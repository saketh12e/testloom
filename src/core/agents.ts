import { StringDecoder } from 'node:string_decoder';
import type { AgentSettings, GeneratedFile, Project, Scenario } from '../shared/types';
import { codexGenerate, detectCodex, generationPrompt } from './codex';
import { claudeGenerate, detectClaude } from './claude';
import { portableGenerate, validateScenario } from './generator';
import { executablePath, runProcess } from './process';
import { scrubText, validateGeneratedFiles } from './repository';

export const DEFAULT_AGENT_SETTINGS: AgentSettings = Object.freeze({
  provider: 'codex',
  model: '',
  effort: 'medium',
  timeoutSeconds: 480,
  instructions: '',
  excludedContextPaths: Object.freeze([]) as unknown as string[],
  claudeBudgetUsd: 1,
});

export interface AgentOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface AgentResult {
  summary: string;
  files: GeneratedFile[];
  warnings: string[];
}

/** Paths are relative to the connected project; * / ** / ? are supported globs. */
export function contextPath(input: string, glob = false): string {
  const value = input
    .trim()
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  if (
    !value ||
    value.length > 500 ||
    value.startsWith('/') ||
    /^[a-z]:/i.test(value) ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.split('/').some((p) => !p || p === '.' || p === '..') ||
    (!glob && /[*?]/.test(value))
  )
    throw new Error('Context paths must be relative project paths without traversal.');
  return value;
}

export function validateAgentSettings(input: unknown): AgentSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Agent settings must be an object.');
  const value = input as Record<string, unknown>;
  const settings = { ...DEFAULT_AGENT_SETTINGS, ...value };
  if (!['codex', 'claude', 'portable'].includes(settings.provider))
    throw new Error('Choose Codex, Claude, or portable generation.');
  if (
    typeof settings.model !== 'string' ||
    (settings.model.trim() !== '' &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_./:\[\]-]{0,159}$/.test(settings.model.trim()))
  )
    throw new Error('Invalid model name.');
  if (!['low', 'medium', 'high'].includes(settings.effort))
    throw new Error('Effort must be low, medium, or high.');
  if (
    !Number.isInteger(settings.timeoutSeconds) ||
    settings.timeoutSeconds < 30 ||
    settings.timeoutSeconds > 1800
  )
    throw new Error('Generation timeout must be 30–1800 whole seconds.');
  if (
    typeof settings.instructions !== 'string' ||
    settings.instructions.length > 8000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(settings.instructions)
  )
    throw new Error('Instructions must contain at most 8,000 characters of plain text.');
  if (
    !Array.isArray(settings.excludedContextPaths) ||
    settings.excludedContextPaths.length > 100 ||
    settings.excludedContextPaths.some((p) => typeof p !== 'string')
  )
    throw new Error('Supply at most 100 context exclusion paths.');
  const paths = [...new Set(settings.excludedContextPaths.map((p) => contextPath(p, true)))];
  if (
    settings.claudeBudgetUsd !== undefined &&
    (typeof settings.claudeBudgetUsd !== 'number' ||
      !Number.isFinite(settings.claudeBudgetUsd) ||
      settings.claudeBudgetUsd < 0.01 ||
      settings.claudeBudgetUsd > 20)
  )
    throw new Error('Claude budget must be between $0.01 and $20 per generation.');
  // Construct a fresh, known-field-only object. Callers cannot mutate the defaults or inject CLI flags.
  return {
    provider: settings.provider,
    model: settings.model.trim(),
    effort: settings.effort,
    timeoutSeconds: settings.timeoutSeconds,
    instructions: settings.instructions,
    excludedContextPaths: paths,
    ...(settings.claudeBudgetUsd === undefined
      ? {}
      : { claudeBudgetUsd: settings.claudeBudgetUsd }),
  };
}

export function agentPrompt(project: Project, scenario: Scenario, settings: AgentSettings): string {
  return generationPrompt(project, scenario, validateAgentSettings(settings));
}

export async function detectAgents() {
  const [codex, claude] = await Promise.all([detectCodex(), detectClaude()]);
  return { codex, claude };
}

export async function generateWithAgent(
  project: Project,
  scenario: Scenario,
  workspace: string,
  input: AgentSettings,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const settings = validateAgentSettings(input);
  checkCancelled(options.signal);
  validateScenario(scenario);
  if (settings.provider === 'codex')
    return codexGenerate(project, scenario, workspace, { ...options, settings });
  if (settings.provider === 'claude')
    return claudeGenerate(project, scenario, workspace, settings, options);
  const result = portableGenerate(project, scenario);
  if (settings.instructions.trim())
    result.warnings.push(
      'Portable generation does not interpret custom instructions. Review the generated tests or select an AI provider.',
    );
  return result;
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error('Generation cancelled. Your connected project is unchanged.');
}

export function redactAgentText(text: string): string {
  return scrubText(text)
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_.=:-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|authorization|signature|code)=)[^&#\s"'<>]*/gi,
      '$1[REDACTED]',
    );
}

export function validateAgentResult(
  value: unknown,
  project: Project,
  provider: string,
): AgentResult {
  const result = value as Partial<AgentResult> | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.keys(result).some((key) => !['summary', 'files', 'warnings'].includes(key)) ||
    typeof result.summary !== 'string' ||
    !result.summary.trim() ||
    result.summary.length > 10_000 ||
    !Array.isArray(result.warnings) ||
    result.warnings.length > 50 ||
    result.warnings.some((w) => typeof w !== 'string' || w.length > 2000) ||
    !Array.isArray(result.files)
  )
    throw new Error(`${provider} returned an invalid structured result. Retry generation.`);
  if (result.files.length === 0)
    throw new Error(
      `${provider} needs more information: ${redactAgentText(result.warnings.join(' ')).slice(0, 2000) || 'Review the scenario and project dependencies.'}`,
    );
  let files: GeneratedFile[];
  try {
    if (
      result.files.some(
        (file) =>
          !file ||
          typeof file !== 'object' ||
          Array.isArray(file) ||
          Object.keys(file).some((key) => !['path', 'content'].includes(key)),
      )
    )
      throw new Error('Invalid file fields.');
    files = validateGeneratedFiles(result.files, project.outputDir);
  } catch {
    throw new Error(
      `${provider} returned invalid test files. Only new, bounded files inside the test output folder are allowed.`,
    );
  }
  return {
    summary: redactAgentText(result.summary),
    files,
    warnings: [
      ...result.warnings.map(redactAgentText),
      'AI-generated assertions require review. Passing execution alone does not prove every requirement is covered.',
    ],
  };
}

// Large results can exceed process.ts's 200 KB diagnostic tail. Parse incrementally,
// retaining at most one bounded NDJSON record, and never parse the merged log tail.
export class BoundedNdjson {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private bytes = 0;
  constructor(
    private receive: (event: unknown) => void,
    private lineLimit = 8_000_000,
    private totalLimit = 16_000_000,
  ) {}
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.totalLimit)
      throw new Error('Agent output exceeded the generation size limit.');
    this.consume(this.decoder.write(chunk));
  }
  private consume(text: string): void {
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.parse(line);
    }
    if (Buffer.byteLength(this.pending) > this.lineLimit)
      throw new Error('Agent output exceeded the record size limit.');
  }
  private parse(line: string): void {
    if (Buffer.byteLength(line) > this.lineLimit)
      throw new Error('Agent output exceeded the record size limit.');
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('Agent returned malformed structured output.');
    }
    this.receive(value);
  }
  finish(): void {
    this.consume(this.decoder.end());
    if (this.pending.trim()) this.parse(this.pending);
    this.pending = '';
  }
}

// process.ts owns timeout/cancellation and kills its detached process group. This
// child stays in that group. Its stderr is discarded; stdout is framed as ASCII
// base64 so split UTF-8 bytes survive process.ts's per-chunk string conversion.
// No shell, persisted logs, or extra source files are needed.
const STDOUT_RELAY = `
const { spawn } = require('node:child_process');
const child = spawn(process.argv[1], process.argv.slice(2), { shell: false, stdio: ['inherit', 'pipe', 'ignore'] });
child.stdout.on('data', data => {
  for (let i = 0; i < data.length; i += 16384) {
    if (!process.stdout.write(data.subarray(i, i + 16384).toString('base64') + '\\n')) child.stdout.pause();
  }
});
process.stdout.on('drain', () => child.stdout.resume());
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code === null ? 1 : code; });
`;

export async function runAgentProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    onEvent: (event: unknown) => void;
  },
): Promise<{ code: number | null; cancelled: boolean; timedOut: boolean }> {
  checkCancelled(options.signal);
  const [binary, node] = await Promise.all([executablePath(executable), executablePath('node')]);
  if (!binary || !node)
    throw new Error(
      'The selected agent CLI or Node.js is unavailable. Check its installation and restart Testloom.',
    );
  const failureController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, failureController.signal])
    : failureController.signal;
  let frame = '';
  let failure: Error | undefined;
  const parser = new BoundedNdjson(options.onEvent);
  const result = await runProcess(node, ['-e', STDOUT_RELAY, binary, ...args], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    signal,
    stdin: options.stdin,
    env: options.env,
    onOutput: (text) => {
      if (failure) return;
      try {
        frame += text;
        let newline: number;
        while ((newline = frame.indexOf('\n')) !== -1) {
          const encoded = frame.slice(0, newline);
          frame = frame.slice(newline + 1);
          if (encoded.length > 24_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
            throw new Error('Agent output transport failed.');
          parser.push(Buffer.from(encoded, 'base64'));
        }
        if (frame.length > 24_000)
          throw new Error('Agent output transport exceeded its size limit.');
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Agent returned invalid output.');
        failureController.abort();
      }
    },
  });
  checkCancelled(options.signal);
  if (failure) throw failure;
  if (!result.cancelled && !result.timedOut && result.code === 0) {
    if (frame) throw new Error('Agent output transport was incomplete.');
    parser.finish();
  }
  return { code: result.code, cancelled: result.cancelled, timedOut: result.timedOut };
}
