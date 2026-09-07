import { access, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { TestCommand, Verification, VerificationRun } from '../shared/types';
import { runProcess } from './process';
import { scrubText } from './repository';

export function validateCommand(command: TestCommand): void {
  if (
    !command ||
    typeof command.executable !== 'string' ||
    !command.executable.trim() ||
    !Array.isArray(command.args) ||
    command.args.length > 256 ||
    Array.from(command.args).some(
      (a) => typeof a !== 'string' || a.length > 4000 || a.includes('\0'),
    ) ||
    /[\x00\r\n]/.test(command.executable)
  )
    throw new Error('Use an executable and a list of arguments for the verification command.');
}
export function inspectPlaywrightReport(
  report: unknown,
  expectedFiles: string[],
  workspace: string,
): string[] {
  type Entry = Record<string, unknown>;
  const object = (input: unknown): Entry => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Malformed Playwright report.');
    return input as Entry;
  };
  const entries = (input: unknown): Entry[] => {
    if (!Array.isArray(input)) throw new Error('Malformed Playwright report array.');
    return Array.from(input, object);
  };
  const noErrors = (entry: Entry): void => {
    if (
      entry.error != null ||
      (entry.errors !== undefined && (!Array.isArray(entry.errors) || entry.errors.length > 0)) ||
      entry.status === 'interrupted' ||
      entry.status === 'timedOut' ||
      entry.status === 'timedout'
    )
      throw new Error('Playwright reported errors or interrupted execution.');
  };
  const data = object(report);
  noErrors(data);
  if (data.status !== undefined && data.status !== 'passed')
    throw new Error('Playwright did not report a passing run.');
  const config = data.config === undefined ? {} : object(data.config);
  if (config.rootDir !== undefined && (typeof config.rootDir !== 'string' || !config.rootDir))
    throw new Error('Invalid Playwright report root directory.');
  const root = path.resolve(workspace, (config.rootDir as string) ?? '.');
  const expected = new Map(expectedFiles.map((file) => [path.resolve(workspace, file), file]));
  const specs: Entry[] = [];
  const seen = new Set<Entry>();
  const checkSteps = (step: Entry): void => {
    if (seen.has(step)) throw new Error('Cyclic Playwright report.');
    seen.add(step);
    noErrors(step);
    if (step.steps !== undefined) entries(step.steps).forEach(checkSteps);
  };
  const visit = (suite: Entry): number => {
    if (seen.has(suite)) throw new Error('Cyclic Playwright report.');
    seen.add(suite);
    noErrors(suite);
    const children = suite.specs === undefined ? [] : entries(suite.specs);
    for (const spec of children) {
      noErrors(spec);
      if (typeof spec.file !== 'string' || !spec.file)
        throw new Error('A reported test is missing its file.');
      for (const test of entries(spec.tests)) {
        noErrors(test);
        for (const result of entries(test.results)) {
          noErrors(result);
          if (result.steps !== undefined) entries(result.steps).forEach(checkSteps);
        }
      }
      specs.push(spec);
    }
    let count = children.length;
    if (suite.suites !== undefined)
      for (const child of entries(suite.suites)) count += visit(child);
    if (
      typeof suite.file === 'string' &&
      expected.has(path.resolve(root, suite.file)) &&
      count === 0
    )
      throw new Error(
        `No completed, passing test was reported for ${expected.get(path.resolve(root, suite.file))}: empty generated file.`,
      );
    return count;
  };
  visit(data);
  const discovered: string[] = [];
  for (const file of expectedFiles) {
    const absolute = path.resolve(workspace, file);
    // Match the entire file first. A passing sibling must never hide a skipped spec or project variant.
    const matches = specs.filter((spec) => path.resolve(root, spec.file as string) === absolute);
    const passed = (spec: Entry): boolean => {
      const tests = entries(spec.tests);
      return (
        spec.ok !== false &&
        tests.length > 0 &&
        tests.every((test) => {
          const results = entries(test.results);
          return (
            test.expectedStatus === 'passed' &&
            test.status === 'expected' &&
            results.length === 1 &&
            results[0].status === 'passed' &&
            (results[0].retry === undefined || results[0].retry === 0)
          );
        })
      );
    };
    if (!matches.length || !matches.every(passed))
      throw new Error(
        `No completed, passing test was reported for every spec and project variant in ${file}. Missing, empty, skipped, expected-failure and retried results are not accepted; each test must pass in exactly one attempt.`,
      );
    discovered.push(...matches.map((spec) => `${file}: ${spec.title}`));
  }
  return discovered;
}
export async function verifyWorkspace(
  workspace: string,
  command: TestCommand,
  repeats: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    prepareDemo?: boolean;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectedPlaywrightFiles?: string[];
  } = {},
): Promise<Verification> {
  validateCommand(command);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
    throw new Error('Choose between one and three repeat runs.');
  if (options.prepareDemo) {
    try {
      await access(path.join(workspace, 'node_modules/@playwright/test/package.json'));
    } catch {
      options.onProgress?.(
        'Installing the sample project’s pinned test dependencies in the isolated copy.',
      );
      let lock = false;
      try {
        await access(path.join(workspace, 'package-lock.json'));
        lock = true;
      } catch {
        /* source demo */
      }
      const install = await runProcess(
        'npm',
        [lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: workspace, timeoutMs: 180_000, signal: options.signal },
      );
      if (install.code !== 0 || install.cancelled || install.timedOut)
        throw new Error(
          install.cancelled
            ? 'Verification cancelled during dependency setup.'
            : `Sample dependency installation failed. ${scrubText(install.output).slice(-1200)}`,
        );
    }
  }
  const startedAt = new Date().toISOString();
  const runs: VerificationRun[] = [];
  const discoveredTests: string[] = [];
  for (let index = 1; index <= repeats; index++) {
    options.onProgress?.(`Running verification ${index} of ${repeats}.`);
    try {
      const reportPath = path.join(workspace, '.journeyproof', `playwright-report-${index}.json`);
      await rm(reportPath, { force: true });
      const result = await runProcess(
        command.executable.startsWith('./')
          ? path.join(workspace, command.executable)
          : command.executable,
        command.args,
        {
          cwd: workspace,
          timeoutMs: options.timeoutMs ?? 180_000,
          signal: options.signal,
          env: {
            ...options.env,
            CI: '1',
            FORCE_COLOR: '0',
            ...(options.expectedPlaywrightFiles ? { PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath } : {}),
          },
        },
      );
      let status: VerificationRun['status'] = result.cancelled
        ? 'cancelled'
        : result.timedOut
          ? 'timed-out'
          : result.code === 0
            ? 'passed'
            : /Cannot find (module|package)|command not found|ENOENT|Executable doesn't exist|Unable to locate a Java Runtime|EADDRINUSE/.test(
                  result.output,
                )
              ? 'environment-error'
              : 'failed';
      if (status === 'passed' && options.expectedPlaywrightFiles?.length) {
        try {
          const discovered = inspectPlaywrightReport(
            JSON.parse(await readFile(reportPath, 'utf8')),
            options.expectedPlaywrightFiles,
            await realpath(workspace),
          );
          discoveredTests.push(...discovered);
          result.output +=
            '\nJourneyProof confirmed generated test discovery:\n' + discovered.join('\n');
        } catch (error: any) {
          status = 'failed';
          result.output +=
            '\nJourneyProof could not confirm generated test execution: ' + error.message;
        }
      }
      runs.push({
        index,
        status,
        exitCode: result.code,
        durationMs: result.durationMs,
        output: scrubText(result.output),
      });
      if (status !== 'passed') break;
    } catch (error: any) {
      runs.push({
        index,
        status: 'environment-error',
        exitCode: null,
        durationMs: 0,
        output: error.message,
      });
      break;
    }
  }
  const status = runs.find((r) => r.status !== 'passed')?.status ?? 'passed';
  const statement =
    status === 'passed'
      ? `The selected command exited successfully in ${runs.length} run${runs.length === 1 ? '' : 's'}. Review its output to confirm the generated tests were discovered. This is execution evidence, not proof of complete coverage or defect detection.`
      : status === 'failed'
        ? 'Verification failed. Inspect the output to distinguish a product defect from an incorrect test. Assertions have not been changed.'
        : status === 'environment-error'
          ? 'The environment could not execute the tests. Install the required runtime or dependencies in the isolated workspace and retry.'
          : status === 'timed-out'
            ? 'Verification exceeded the time limit. This is not evidence of a product defect.'
            : 'Verification was cancelled. No passing result is claimed.';
  const verification: Verification = {
    status,
    command,
    runs,
    startedAt,
    statement:
      discoveredTests.length && status === 'passed'
        ? `Generated tests were discovered and passed in ${runs.length} independent command runs. ${statement}`
        : statement,
    ...(discoveredTests.length ? { discoveredTests: [...new Set(discoveredTests)] } : {}),
  };
  await writeFile(
    path.join(workspace, '.journeyproof/verification.json'),
    JSON.stringify(verification, null, 2),
  );
  return verification;
}
