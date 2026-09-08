import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSettings, AgentStatus, Project, Scenario } from '../shared/types';
import { executablePath, runProcess } from './process';
import { GENERATION_SCHEMA, generationPrompt } from './codex';
import { validateScenario } from './generator';
import { REPOSITORY_TOOL_DEFINITIONS } from './repository-tools';
import {
  checkCancelled,
  redactAgentText,
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
  run: {
    mcpConfig?: string;
    session?: { id: string; resume: boolean };
    images?: boolean;
    name?: string;
  } = {},
): string[] {
  const validated = validateAgentSettings(settings);
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    run.images ? 'stream-json' : 'text',
    '--json-schema',
    JSON.stringify(GENERATION_SCHEMA),
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    run.mcpConfig ?? '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-chrome',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify(overrides),
    '--effort',
    validated.effort === 'xhigh' || validated.effort === 'max' ? 'max' : validated.effort,
    '--max-budget-usd',
    String(validated.claudeBudgetUsd ?? 1),
  ];
  if (run.session) {
    args.push(run.session.resume ? '--resume' : '--session-id', run.session.id);
    if (run.name)
      args.push(
        '--name',
        run.name
          .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 180),
      );
  } else args.push('--no-session-persistence');
  if (run.mcpConfig)
    args.push(
      '--allowedTools',
      REPOSITORY_TOOL_DEFINITIONS.map((tool) => `mcp__repository__${tool.name}`).join(','),
    );
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
      'Claude requested unavailable tools. Only the controlled, read-only repository tools are allowed.',
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeSessions = new Set<string>();
const SESSION_FILE = 'claude-session.json';
const MCP_FILE = 'repository-mcp.json';

async function noSymlinks(full: string): Promise<void> {
  let current = path.parse(full).root;
  const parts = full.slice(current.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (
      i === 0 &&
      process.platform === 'darwin' &&
      ['/var', '/tmp'].includes(current) &&
      info.isSymbolicLink() &&
      (await realpath(current)) === `/private${current}`
    ) {
      current = `/private${current}`;
      continue;
    }
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()))
      throw new Error('Claude managed files and their ancestors cannot be symlinks.');
  }
}

async function privateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function bindSession(
  root: string,
  project: Project,
  scenario: Scenario,
  id?: string,
): Promise<string> {
  const marker = path.join(root, SESSION_FILE);
  let previous: { projectId?: string; scenarioId?: string; sessionId?: string } | undefined;
  try {
    await noSymlinks(marker);
    if ((await lstat(marker)).size > 4096) throw new Error('oversized');
    previous = JSON.parse(await readFile(marker, 'utf8'));
    if (!previous || typeof previous !== 'object') throw new Error('invalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Claude session ownership could not be verified. Start a new case session.');
  }
  if (previous && (previous.projectId !== project.id || previous.scenarioId !== scenario.id))
    throw new Error('Claude session belongs to a different project or test case.');
  if (id && (!SESSION_ID.test(id) || previous?.sessionId?.toLowerCase() !== id.toLowerCase()))
    throw new Error('Claude resume ID does not belong to this case session.');
  const expected = id || randomUUID();
  await privateJson(marker, {
    projectId: project.id,
    scenarioId: scenario.id,
    sessionId: expected,
  });
  return expected;
}

/** Native image blocks are sent directly to Claude, never through repository tools. */
async function claudeInput(prompt: string, options: AgentOptions): Promise<string> {
  if (options.evidenceImages === undefined) return prompt;
  if (!Array.isArray(options.evidenceImages) || options.evidenceImages.length > 100)
    throw new Error('Claude evidence supports at most 100 screenshots per generation.');
  const content: Record<string, unknown>[] = [{ type: 'text', text: prompt }];
  let total = 0;
  for (const image of options.evidenceImages) {
    checkCancelled(options.signal);
    if (
      !image ||
      typeof image.path !== 'string' ||
      !path.isAbsolute(image.path) ||
      image.path !== path.resolve(image.path) ||
      !['image/png', 'image/jpeg'].includes(image.mimeType) ||
      typeof image.label !== 'string' ||
      image.label.length > 2000
    )
      throw new Error('Claude evidence must be labeled PNG or JPEG files from managed recordings.');
    try {
      await noSymlinks(image.path);
      const before = await lstat(image.path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size <= 0 ||
        before.size > 50 * 1024 * 1024 - total
      )
        throw new Error('size');
      const handle = await open(
        image.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat();
        if (
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size ||
          opened.nlink !== 1
        )
          throw new Error('changed');
        const bytes = Buffer.alloc(before.size);
        let read = 0;
        while (read < bytes.length) {
          checkCancelled(options.signal);
          const result = await handle.read(
            bytes,
            read,
            Math.min(64 * 1024, bytes.length - read),
            read,
          );
          if (!result.bytesRead) throw new Error('changed');
          read += result.bytesRead;
        }
        await noSymlinks(image.path);
        const after = await handle.stat(),
          named = await lstat(image.path);
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          named.ino !== before.ino ||
          named.dev !== before.dev
        )
          throw new Error('changed');
        const valid =
          image.mimeType === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (!valid) throw new Error('format');
        total += bytes.length;
        content.push(
          { type: 'text', text: redactAgentText(image.label) },
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: bytes.toString('base64') },
          },
        );
      } finally {
        await handle.close();
      }
    } catch {
      checkCancelled(options.signal);
      throw new Error(
        'Claude screenshot is unsafe, changed, invalid, or exceeds the 50 MB evidence limit.',
      );
    }
  }
  return (
    JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) +
    '\n'
  );
}

export async function claudeGenerate(
  project: Project,
  scenario: Scenario,
  workspace: string,
  input: AgentSettings,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const settings = validateAgentSettings(input);
  validateScenario(scenario);
  checkCancelled(options.signal);
  const prompt = generationPrompt(project, scenario, settings);
  const stdin = await claudeInput(prompt, options);
  const overrides = await runtimeSettings();
  const persistent = options.session !== undefined;
  if (
    persistent &&
    (!options.session ||
      typeof options.session.cwd !== 'string' ||
      !path.isAbsolute(options.session.cwd))
  )
    throw new Error('Claude sessions require an absolute managed working directory.');
  let agentRoot = persistent
    ? path.resolve(options.session!.cwd)
    : await mkdtemp(path.join(tmpdir(), 'testloom-claude-'));
  if (persistent) {
    await mkdir(agentRoot, { recursive: true, mode: 0o700 });
    await noSymlinks(agentRoot);
    agentRoot = await realpath(agentRoot);
    // User env settings merge with these overrides. Pin persistence here as
    // well as in the child environment without changing stored user settings.
    overrides.env = { ...CLAUDE_RUN_ENV, CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0' };
  }
  if (activeSessions.has(agentRoot))
    throw new Error('This Claude case session is already generating.');
  activeSessions.add(agentRoot);
  try {
    let run: Parameters<typeof claudeArguments>[2] = {
      images: options.evidenceImages !== undefined,
    };
    let expectedSession: string | undefined;
    let sessionSeen = false;
    if (persistent) {
      if (
        options.session!.id !== undefined &&
        (typeof options.session!.id !== 'string' || !SESSION_ID.test(options.session!.id))
      )
        throw new Error('Claude resume ID must be a valid session UUID.');
      const lexicalSnapshot = path.resolve(workspace);
      await noSymlinks(lexicalSnapshot);
      const snapshot = await realpath(lexicalSnapshot);
      if (
        snapshot === agentRoot ||
        snapshot.startsWith(agentRoot + path.sep) ||
        agentRoot.startsWith(snapshot + path.sep)
      )
        throw new Error('Claude session directory and source snapshot must be separate.');
      expectedSession = await bindSession(agentRoot, project, scenario, options.session!.id);
      const serverpath =
        typeof __dirname === 'string'
          ? path.join(__dirname, 'repository-mcp.cjs')
          : fileURLToPath(new URL('../../dist/main/repository-mcp.cjs', import.meta.url));
      const config = path.join(agentRoot, MCP_FILE);
      await privateJson(config, {
        mcpServers: {
          repository: {
            type: 'stdio',
            command: process.execPath,
            args: [serverpath, snapshot, JSON.stringify(settings.excludedContextPaths)],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
      });
      run = {
        ...run,
        mcpConfig: config,
        session: { id: expectedSession, resume: !!options.session!.id },
        name: `Testloom: ${scenario.name}`,
      };
    }
    let terminal: unknown;
    let terminalSeen = false;
    let authenticationFailure: 401 | 403 | undefined;
    options.onProgress?.('Claude is adapting the recorded journey to your project conventions.');
    const result = await runAgentProcess('claude', claudeArguments(settings, overrides, run), {
      cwd: agentRoot,
      timeoutMs: settings.timeoutSeconds * 1000,
      signal: options.signal,
      stdin,
      env: { ...CLAUDE_RUN_ENV, ...(persistent ? { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '0' } : {}) },
      onEvent: (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Claude returned an invalid stream event.');
        const event = value as Record<string, unknown>;
        if (terminalSeen) throw new Error('Claude returned data after its terminal result.');
        if (event.type === 'system' && event.subtype === 'init') {
          if (persistent) {
            if (
              typeof event.session_id !== 'string' ||
              !SESSION_ID.test(event.session_id) ||
              event.session_id.toLowerCase() !== expectedSession!.toLowerCase() ||
              sessionSeen
            )
              throw new Error('Claude initialized an unexpected or invalid case session.');
            sessionSeen = true;
            options.onSession?.(event.session_id);
          }
          options.onProgress?.('Claude started reasoning about the test.');
        }
        if (event.type === 'system' && event.subtype === 'api_retry') {
          if (event.error_status === 401 || event.error_status === 403)
            authenticationFailure = event.error_status;
          options.onProgress?.(
            'Claude is retrying its configured API connection within the generation timeout.',
          );
        }
        if (event.type === 'result') {
          if (
            persistent &&
            event.session_id !== undefined &&
            (typeof event.session_id !== 'string' ||
              event.session_id.toLowerCase() !== expectedSession!.toLowerCase())
          )
            throw new Error('Claude returned a result for a different case session.');
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
    if (persistent && !sessionSeen)
      throw new Error('Claude did not initialize the requested case session.');
    return parseClaudeResult(terminal, project);
  } finally {
    activeSessions.delete(agentRoot);
    if (!persistent) await rm(agentRoot, { recursive: true, force: true });
  }
}
