import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSettings, AgentStatus, Project, Scenario } from '../shared/types';
import { executablePath, runProcess } from './process';
import { GENERATION_SCHEMA, generationPrompt } from './codex';
import { validateScenario } from './generator';
import {
  checkCancelled,
  runAgentProcess,
  validateAgentResult,
  validateAgentSettings,
  type AgentOptions,
  type AgentResult,
} from './agents';

// These switches exist in installed Claude Code 2.1.116. Do not use --bare:
// it disables OAuth/keychain authentication. Keep HOME/CLAUDE_CONFIG_DIR and
// credential environment variables intact, and preserve user apiKeyHelper/env.
export const CLAUDE_RUN_ENV: NodeJS.ProcessEnv = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_SIMPLE: '0',
};

export async function detectClaude(): Promise<AgentStatus> {
  const executable = await executablePath('claude');
  if (!executable) return { available: false };
  try {
    const result = await runProcess(executable, ['--version'], {
      cwd: tmpdir(),
      timeoutMs: 10_000,
      env: CLAUDE_RUN_ENV,
    });
    const version = result.output.match(
      /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?(?: \(Claude Code\))?/,
    )?.[0];
    return {
      available: result.code === 0 && !result.timedOut && !result.cancelled,
      path: executable,
      ...(version ? { version } : {}),
    };
  } catch {
    return { available: false };
  }
}

async function runtimeSettings(): Promise<Record<string, unknown>> {
  // Empty enabledPlugins would merge with user settings, not disable them. Read
  // only plugin keys into the override; never copy or log credentials/settings.
  const file = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
    'settings.json',
  );
  let plugins: string[] = [];
  try {
    if ((await stat(file)).size > 1_000_000) throw new Error('oversized');
    const settings = JSON.parse(await readFile(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('invalid');
    if (settings.enabledPlugins && typeof settings.enabledPlugins === 'object')
      plugins = Object.keys(settings.enabledPlugins);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        'Claude user settings could not be safely loaded. Check their JSON format and size.',
      );
  }
  return {
    disableAllHooks: true,
    disableSkillShellExecution: true,
    autoMemoryEnabled: false,
    enableAllProjectMcpServers: false,
    enabledPlugins: Object.fromEntries(plugins.map((key) => [key, false])),
    env: CLAUDE_RUN_ENV,
  };
}

export function claudeArguments(
  settings: AgentSettings,
  overrides: Record<string, unknown>,
): string[] {
  const validated = validateAgentSettings(settings);
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'text',
    '--json-schema',
    JSON.stringify(GENERATION_SCHEMA),
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--no-chrome',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify(overrides),
    '--effort',
    validated.effort,
    '--max-budget-usd',
    String(validated.claudeBudgetUsd ?? 1),
  ];
  if (validated.model) args.push('--model', validated.model);
  return args;
}

/** Only the terminal result's structured_output is authoritative (never result text or a tool call). */
export function parseClaudeResult(value: unknown, project: Project): AgentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Claude returned no valid structured result.');
  const event = value as Record<string, unknown>;
  if (event.type !== 'result') throw new Error('Claude returned no terminal result.');
  if (event.subtype !== 'success' || event.is_error !== false) {
    if (event.subtype === 'error_max_budget_usd')
      throw new Error(
        'Claude reached the per-run budget. Shorten the journey or increase the Claude budget.',
      );
    if (event.subtype === 'error_max_turns')
      throw new Error('Claude could not finish within its turn limit. Shorten the journey.');
    throw new Error(
      'Claude could not complete generation. Check your Claude login, model, and budget settings.',
    );
  }
  if (Array.isArray(event.permission_denials) && event.permission_denials.length)
    throw new Error(
      'Claude requested unavailable tools. Retry with enough source context for generation without tools.',
    );
  if (
    !event.structured_output ||
    typeof event.structured_output !== 'object' ||
    Array.isArray(event.structured_output)
  )
    throw new Error(
      'Claude returned no valid structured_output. Retry with a model that supports structured generation.',
    );
  return validateAgentResult(event.structured_output, project, 'Claude');
}

export async function claudeGenerate(
  project: Project,
  scenario: Scenario,
  _workspace: string,
  input: AgentSettings,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const settings = validateAgentSettings(input);
  validateScenario(scenario);
  checkCancelled(options.signal);
  const prompt = generationPrompt(project, scenario, settings);
  const overrides = await runtimeSettings();
  const agentRoot = await mkdtemp(path.join(tmpdir(), 'testloom-claude-'));
  try {
    let terminal: unknown;
    let terminalSeen = false;
    let authenticationFailure: 401 | 403 | undefined;
    options.onProgress?.('Claude is adapting the recorded journey to your project conventions.');
    const result = await runAgentProcess('claude', claudeArguments(settings, overrides), {
      cwd: agentRoot,
      timeoutMs: settings.timeoutSeconds * 1000,
      signal: options.signal,
      stdin: prompt,
      env: CLAUDE_RUN_ENV,
      onEvent: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Claude returned an invalid stream event.');
        const event = value as Record<string, unknown>;
        if (terminalSeen) throw new Error('Claude returned data after its terminal result.');
        if (event.type === 'system' && event.subtype === 'init')
          options.onProgress?.('Claude started reasoning about the test.');
        if (event.type === 'system' && event.subtype === 'api_retry') {
          if (event.error_status === 401 || event.error_status === 403)
            authenticationFailure = event.error_status;
          options.onProgress?.(
            'Claude is retrying its configured API connection within the generation timeout.',
          );
        }
        if (event.type === 'result') {
          terminal = event;
          terminalSeen = true;
        }
      },
    });
    checkCancelled(options.signal);
    if (result.cancelled)
      throw new Error('Generation cancelled. Your connected project is unchanged.');
    if (
      authenticationFailure &&
      (result.timedOut ||
        result.code !== 0 ||
        !terminalSeen ||
        (terminal as Record<string, unknown>).is_error === true)
    )
      throw new Error(
        `Claude's configured API rejected authentication (HTTP ${authenticationFailure}). Refresh your Claude login or check your existing user authentication settings.`,
      );
    if (result.timedOut)
      throw new Error(
        `Claude reached the ${settings.timeoutSeconds}-second generation limit. Try a shorter journey or increase the timeout.`,
      );
    // A valid terminal error (e.g. budget exhaustion) can accompany a nonzero exit.
    if (terminalSeen && (terminal as Record<string, unknown>).subtype !== 'success')
      return parseClaudeResult(terminal, project);
    if (result.code !== 0)
      throw new Error(
        'Claude could not complete generation. Check your Claude login and model configuration.',
      );
    if (!terminalSeen)
      throw new Error('Claude returned no terminal structured result. Retry generation.');
    return parseClaudeResult(terminal, project);
  } finally {
    await rm(agentRoot, { recursive: true, force: true });
  }
}
