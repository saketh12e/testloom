// Run explicitly with JAVA_HOME, PATH, and optionally MAVEN_EXECUTABLE set.
// Owns only port 4329. Generated files and runtime evidence stay in ignored work/.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserRecorder } from '../src/core/recorder';
import { portableGenerate } from '../src/core/generator';
import {
  inspectProject,
  listProjectFiles,
  snapshotProject,
  writeGeneratedFiles,
} from '../src/core/repository';
import { runProcess } from '../src/core/process';
import { demoCases } from '../src/core/demo';
import type { Scenario } from '../src/shared/types';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repo, 'examples/java');
const cartSource = path.join(repo, 'examples/cart');
const work = path.join(repo, 'work');
const url = 'http://127.0.0.1:4329/';
// Read the shipped POM rather than overriding its dependency on the command line.
const pom = await readFile(path.join(source, 'pom.xml'), 'utf8');
const version = /<playwright\.version>(\d+\.\d+\.\d+)<\/playwright\.version>/.exec(pom)?.[1];
assert(version, 'The Java example must pin a numeric Playwright version in its POM.');
const maven = process.env.MAVEN_EXECUTABLE ?? 'mvn';

async function digest(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listProjectFiles(root))
    hash.update(file).update(await readFile(path.join(root, file)));
  return hash.digest('hex');
}

async function freePort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () =>
      reject(new Error('Port 4329 is occupied; the existing process was not touched.')),
    );
    probe.listen({ host: '127.0.0.1', port: 4329, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

async function stop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function main(): Promise<void> {
  await mkdir(work, { recursive: true });
  const runDir = await mkdtemp(path.join(work, 'java-integration-'));
  const workspace = path.join(runDir, 'generated-project');
  const cartCopy = path.join(runDir, 'cart');
  const before = { java: await digest(source), cart: await digest(cartSource) };
  const summary: Record<string, unknown> = {
    status: 'running',
    startedAt: new Date().toISOString(),
    requestedVersion: version,
    testedVersion: version,
    pinnedVersionVerified: false,
    versionSource: 'examples/java/pom.xml',
    versionOverride: false,
    port: 4329,
    workspace,
    runDir,
    sourceDigestsBefore: before,
    commands: [],
  };
  let server: ChildProcess | undefined;
  let recorder: BrowserRecorder | undefined;
  let failure: unknown;
  const commands = summary.commands as unknown[];

  async function mvn(label: string, args: string[]) {
    console.log(`JAVA ${label}: Playwright ${version}`);
    const command = [
      '-B',
      '-ntp',
      `-Dmaven.repo.local=${path.join(work, 'java-maven-cache')}`,
      ...args,
    ];
    const result = await runProcess(maven, command, {
      cwd: workspace,
      timeoutMs: 240_000,
      env: { JAVA_HOME: process.env.JAVA_HOME, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
    await writeFile(path.join(runDir, `${label}.log`), result.output);
    commands.push({ label, executable: maven, args: command, ...result });
    console.log(`${label}: exit ${result.code} (${result.durationMs} ms)`);
    return result;
  }

  async function start(broken: boolean) {
    await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '4329',
      JOURNEYPROOF_BROKEN_DISCOUNT: broken ? '1' : '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: cartCopy,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = server;
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => finish(new Error(`Cart readiness timeout: ${output}`)),
        10_000,
      );
      const exit = () => finish(new Error(`Cart failed to start: ${output}`));
      const error = (e: Error) => finish(e);
      const consume = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('Testloom cart ready at http://127.0.0.1:4329')) finish();
      };
      function finish(e?: Error) {
        clearTimeout(timer);
        child.off('exit', exit);
        child.off('error', error);
        child.stdout?.off('data', consume);
        child.stderr?.off('data', consume);
        e ? reject(e) : resolve();
      }
      child.once('exit', exit);
      child.once('error', error);
      child.stdout?.on('data', consume);
      child.stderr?.on('data', consume);
    });
  }

  try {
    assert(process.env.JAVA_HOME, 'Set JAVA_HOME to a JDK 17+ installation for this invocation.');
    const project = await inspectProject(source);
    assert.equal(project.framework, 'playwright-java');
    summary.javaSnapshot = await snapshotProject(project, workspace);
    summary.cartSnapshot = await snapshotProject(await inspectProject(cartSource), cartCopy);
    const install = await mvn('browser-install', [
      'exec:java',
      '-Dexec.mainClass=com.microsoft.playwright.CLI',
      '-Dexec.classpathScope=test',
      '-Dexec.args=install chromium',
    ]);
    if (install.code !== 0 || install.timedOut || install.cancelled) {
      summary.status = 'environment-error';
      throw new Error(
        `Java dependency/browser setup failed for Playwright ${version}. See browser-install.log.`,
      );
    }
    const baseline = await mvn('baseline', ['test', '-Dtest=example.BrowserSmokeTest']);
    assert.equal(baseline.code, 0, 'Java baseline failed');
    assert.match(baseline.output, /Tests run: 1, Failures: 0, Errors: 0, Skipped: 0/);

    await start(false);
    recorder = new BrowserRecorder({
      artifactDir: path.join(runDir, 'recording'),
      onEvent: () => {},
    });
    await recorder.start(url, { headless: true, captureScreenshots: false });
    const page = recorder.page;
    page.setDefaultTimeout(10_000);
    await page.getByTestId('add-notebook').click();
    await page.getByTestId('add-bag').click();
    await page.getByTestId('coupon').fill('SAVE10');
    await page.getByTestId('apply-coupon').click();
    await page
      .getByTestId('total')
      .filter({ hasText: /^\$90\.00$/ })
      .waitFor();
    const recording = await recorder.stop();
    recorder = undefined;
    const scenario: Scenario = {
      schemaVersion: 1,
      id: randomUUID(),
      name: 'Java cart coupon',
      startUrl: url,
      createdAt: new Date().toISOString(),
      ...recording,
      assertions: [
        {
          id: 'discount-total',
          description: 'SAVE10 reduces the $100 cart total to $90.00.',
          kind: 'text',
          locator: { strategy: 'testId', value: 'total' },
          expected: '$90.00',
          source: 'user',
        },
      ],
    };
    for (const id of ['add-notebook', 'add-bag', 'coupon', 'apply-coupon']) {
      assert(
        scenario.events.some((event) =>
          event.locators.some((locator) => locator.strategy === 'testId' && locator.value === id),
        ),
        `Missing recorded ${id}`,
      );
    }
    await writeFile(path.join(runDir, 'scenario.json'), JSON.stringify(scenario, null, 2));
    const generated = portableGenerate(project, scenario);
    const variants = demoCases(4329).slice(1);
    generated.files.push(...variants.flatMap((c) => portableGenerate(project, c.scenario).files));
    summary.caseKinds = ['positive', ...variants.map((c) => c.kind)];
    assert.equal(generated.files.length, 3);
    await writeGeneratedFiles(workspace, generated.files, project.outputDir);
    const file = generated.files[0];
    assert.match(file.content, /assertThat\(page\.getByTestId\("total"\)\)\.hasText\("\$90\.00"\)/);
    const className = path.basename(file.path, '.java');
    summary.generatedFile = file.path;
    summary.generatedSha256 = createHash('sha256').update(file.content).digest('hex');
    summary.recordedEvents = scenario.events.length;
    const healthy = await mvn('healthy', ['test', '-Dtest=testloom.Testloom*Test']);
    assert.equal(healthy.code, 0, 'Generated Java coupon test failed on the healthy cart');
    assert.match(healthy.output, /Tests run: 3, Failures: 0, Errors: 0, Skipped: 0/);
    await writeFile(
      path.join(runDir, 'healthy-surefire.xml'),
      await readFile(
        path.join(workspace, 'target/surefire-reports', `TEST-testloom.${className}.xml`),
      ),
    );
    await stop(server);
    server = undefined;
    await start(true);
    const broken = await mvn('broken', ['test', '-Dtest=testloom.Testloom*Test']);
    assert.equal(broken.code, 1, 'Mutation must complete with a test failure');
    assert.equal(broken.timedOut, false);
    const report = await readFile(
      path.join(workspace, 'target/surefire-reports', `TEST-testloom.${className}.xml`),
      'utf8',
    );
    await writeFile(path.join(runDir, 'broken-surefire.xml'), report);
    assert.match(report, /tests="1"/);
    assert.match(report, /failures="1"/);
    assert.match(report, /errors="0"/);
    assert.match(report, /skipped="0"/);
    assert.match(report, /\$90\.00/);
    assert.match(report, /\$95\.00/);
    assert.match(report, /AssertionFailedError|AssertionError/);
    assert.equal(
      await readFile(path.join(workspace, file.path), 'utf8'),
      file.content,
      'Generated code changed between runs',
    );
    summary.status = 'passed';
    summary.pinnedVersionVerified = true;
    summary.mutation = { expected: '$90.00', received: '$95.00', semanticFailure: true };
  } catch (error) {
    failure = error;
    if (summary.status !== 'environment-error') summary.status = 'failed';
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    await recorder?.stop().catch(() => {});
    await stop(server);
    const after = { java: await digest(source), cart: await digest(cartSource) };
    summary.sourceDigestsAfter = after;
    summary.originalUnchanged = before.java === after.java && before.cart === after.cart;
    if (!summary.originalUnchanged) {
      summary.status = 'failed';
      failure = new Error('Original source changed during integration.');
    }
    summary.finishedAt = new Date().toISOString();
    await writeFile(path.join(runDir, 'result.json'), JSON.stringify(summary, null, 2));
    await writeFile(path.join(work, 'java-verification.json'), JSON.stringify(summary, null, 2));
    console.log(
      JSON.stringify(
        {
          status: summary.status,
          testedVersion: version,
          pinnedVersionVerified: summary.pinnedVersionVerified,
          originalUnchanged: summary.originalUnchanged,
          evidence: path.join(work, 'java-verification.json'),
          error: summary.error,
        },
        null,
        2,
      ),
    );
  }
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
