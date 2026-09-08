import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BoundedNdjson, checkCancelled, type AgentOptions } from './agents';
import { executablePath } from './process';
import { REPOSITORY_TOOL_DEFINITIONS, executeRepositoryTool } from './repository-tools';
import type { AgentSettings } from '../shared/types';

type Wire = Record<string, any>;

/** One owned stdio connection. Native Codex threads outlive this process. */
export class CodexConnection {
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private failure?: Error;
  private stopped = false;
  onEvent: (event: Wire) => void = () => {};
  onRequest: (event: Wire) => Promise<Wire> = async () => {
    throw new Error('Unsupported server request.');
  };
  onFailure: (error: Error) => void = () => {};
  constructor(private child: ChildProcessWithoutNullStreams) {
    const decoder = new BoundedNdjson((value) => this.receive(value));
    child.stdout.on('data', (data) => {
      try {
        decoder.push(data);
      } catch {
        this.fail(new Error('Codex returned an invalid or oversized protocol message.'));
      }
    });
    // Drain diagnostics without mixing private stderr into the protocol or UI.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail(new Error('Codex disconnected.')));
    child.on('error', () => this.fail(new Error('Could not start the Codex app server.')));
    child.on('close', () => {
      if (!this.stopped) this.fail(new Error('Codex disconnected before the turn completed.'));
    });
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid RPC message.');
    const message = value as Wire;
    if (message.method && message.id !== undefined) {
      void this.onRequest(message).then(
        (result) => this.send({ id: message.id, result }),
        () =>
          this.send({
            id: message.id,
            error: { code: -32601, message: 'This operation is unavailable in Testloom.' },
          }),
      );
    } else if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(
            'Codex rejected the session request. Check CLI compatibility, login and model settings, or start a fresh case session.',
          ),
        );
      else request.resolve(message.result);
    } else if (typeof message.method === 'string') this.onEvent(message);
  }
  send(message: Wire): void {
    if (!this.stopped && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: Wire): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.onFailure(error);
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.fail(new Error('Codex connection closed.'));
    const pid = this.child.pid;
    if (!pid) return;
    const signal = (kind: NodeJS.Signals) => {
      try {
        process.platform === 'win32' ? this.child.kill(kind) : process.kill(-pid, kind);
      } catch {
        /* already exited */
      }
    };
    this.child.stdin.end();
    signal('SIGTERM');
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 0);
      } catch {
        return;
      }
      await delay(25);
    }
    signal('SIGKILL');
  }
}

export async function codexServerGenerate(
  prompt: string,
  schema: Wire,
  workspace: string,
  settings: AgentSettings,
  options: AgentOptions,
): Promise<unknown> {
  checkCancelled(options.signal);
  const executable = await executablePath('codex');
  if (!executable)
    throw new Error('Install and sign in to Codex CLI, then refresh agent availability.');
  const cwd = options.session!.cwd;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const connection = new CodexConnection(
    spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  const controller = new AbortController();
  let threadId = '',
    turnId = '',
    finalText = '',
    calls = 0,
    activeCalls = 0;
  let finish!: (v: Wire) => void, fail!: (e: Error) => void;
  const finished = new Promise<Wire>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Handshake failures can happen before the caller starts awaiting the turn.
  void finished.catch(() => {});
  connection.onFailure = fail;
  const abort = () => {
    controller.abort();
    if (threadId && turnId)
      connection.send({ id: 'interrupt', method: 'turn/interrupt', params: { threadId, turnId } });
    connection.fail(new Error('Generation cancelled. The case session is retained.'));
  };
  const timeout = setTimeout(() => {
    controller.abort();
    if (threadId && turnId)
      connection.send({ id: 'interrupt', method: 'turn/interrupt', params: { threadId, turnId } });
    connection.fail(
      new Error(
        `Codex reached the ${settings.timeoutSeconds}-second limit. Resume this case or increase the time limit.`,
      ),
    );
  }, settings.timeoutSeconds * 1000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  connection.onEvent = ({ method, params }) => {
    if (params?.threadId !== threadId || !threadId) return;
    if (method === 'turn/started') turnId = params.turn.id;
    if (params.turnId && turnId && params.turnId !== turnId) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (typeof params.item.text !== 'string' || Buffer.byteLength(params.item.text) > 8_000_000) {
        connection.fail(new Error('Codex returned an oversized final response.'));
        return;
      }
      if (!params.item.phase || params.item.phase === 'final_answer') finalText = params.item.text;
    }
    if (method === 'turn/completed' && (!turnId || params.turn?.id === turnId)) finish(params.turn);
  };
  connection.onRequest = async ({ method, params }) => {
    if (
      method === 'item/tool/call' &&
      params.threadId === threadId &&
      (!turnId || params.turnId === turnId)
    ) {
      if (++calls > 200 || activeCalls >= 4 || controller.signal.aborted)
        return {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: 'Repository tool budget exceeded or cancelled. Return an explicit warning if context is insufficient.',
            },
          ],
        };
      activeCalls++;
      try {
        options.onProgress?.(`Codex is inspecting repository context (${calls} tool calls).`);
        const text = await executeRepositoryTool(
          workspace,
          settings.excludedContextPaths,
          params.tool,
          params.arguments,
          controller.signal,
        );
        return { success: true, contentItems: [{ type: 'inputText', text }] };
      } catch {
        return {
          success: false,
          contentItems: [
            {
              type: 'inputText',
              text: 'This path or query is unavailable under the repository access limits. Use relative source paths and narrower queries.',
            },
          ],
        };
      } finally {
        activeCalls--;
      }
    }
    if (method.includes('requestApproval')) {
      if (method.includes('permissions')) return { permissions: {}, scope: 'turn' };
      return { decision: 'decline' };
    }
    throw new Error('Unsupported request.');
  };
  try {
    await connection.request('initialize', {
      clientInfo: { name: 'testloom', title: 'Testloom', version: '0.3.0' },
      capabilities: { experimentalApi: true },
    });
    connection.send({ method: 'initialized', params: {} });
    const current = await connection.request('config/read', { includeLayers: false, cwd });
    const config: Wire = {
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.code_mode': false,
      'features.code_mode_host': false,
      'features.apps': false,
      'features.multi_agent': false,
      'features.memories': false,
      'features.skill_search': false,
      'features.skip_host_skill_discovery': true,
      web_search: 'disabled',
      project_doc_max_bytes: 0,
    };
    // Preserve account/provider configuration while disabling unrelated tools for this thread.
    for (const name of Object.keys(current?.config?.mcp_servers || {}))
      config[`mcp_servers.${name}.enabled`] = false;
    const common = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config,
      baseInstructions:
        'You are Testloom’s test author. Use only the supplied repository tools to inspect code. Return the required structured test files. Never execute commands or edit files. The current user-provided scenario and assertions supersede earlier versions; past results are context, never proof that current tests pass.',
      ...(settings.model ? { model: settings.model } : {}),
    };
    options.onProgress?.(
      options.session?.id
        ? 'Resuming this case’s Codex session.'
        : 'Creating a dedicated Codex session for this case.',
    );
    const response = options.session?.id
      ? await connection.request('thread/resume', {
          ...common,
          threadId: options.session.id,
          excludeTurns: true,
        })
      : await connection.request('thread/start', {
          ...common,
          ephemeral: false,
          environments: [],
          dynamicTools: REPOSITORY_TOOL_DEFINITIONS.map((tool) => ({ ...tool, type: 'function' })),
        });
    threadId = response?.thread?.id;
    if (
      typeof threadId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(threadId) ||
      (options.session?.id && threadId !== options.session.id)
    )
      throw new Error('Codex returned an invalid case session identity.');
    options.onSession?.(threadId);
    if (options.sessionTitle) {
      await connection.request('thread/name/set', {
        threadId,
        name: options.sessionTitle.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180),
      });
    }
    let effort: string = settings.effort;
    if (effort === 'max') {
      let cursor: string | undefined;
      let selected: Wire | undefined;
      for (let page = 0; page < 10 && !selected; page++) {
        const models = await connection.request('model/list', {
          includeHidden: true,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        selected = models.data?.find(
          (model: Wire) =>
            model.model === (response.model || settings.model) ||
            model.id === (response.model || settings.model),
        );
        cursor = models.nextCursor;
        if (!cursor) break;
      }
      const supported =
        selected?.supportedReasoningEfforts?.map((entry: Wire) => entry.reasoningEffort) ?? [];
      const ranking = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
      effort = [...ranking].reverse().find((value) => supported.includes(value)) || '';
      if (!effort)
        throw new Error(
          'The selected Codex model did not advertise its maximum reasoning level. Choose an explicit effort or a supported model.',
        );
      options.onProgress?.(`Using the model’s highest supported reasoning effort: ${effort}.`);
    }
    const input: Wire[] = [{ type: 'text', text: prompt }];
    for (const image of options.evidenceImages ?? []) {
      input.push(
        { type: 'text', text: image.label },
        { type: 'localImage', path: image.path, detail: 'original' },
      );
    }
    const started = await connection.request('turn/start', {
      threadId,
      input,
      cwd,
      environments: [],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort,
      outputSchema: schema,
      ...(settings.model ? { model: settings.model } : {}),
    });
    if (turnId && turnId !== started?.turn?.id)
      throw new Error('Codex returned a mismatched turn.');
    turnId = started?.turn?.id;
    const turn = await finished;
    checkCancelled(options.signal);
    if (turn.status !== 'completed')
      throw new Error(
        'Codex did not complete this turn. Its session is retained; check account/model settings or start fresh.',
      );
    if (!finalText) {
      const last = turn.items?.filter((item: Wire) => item.type === 'agentMessage').at(-1);
      finalText = last?.text || '';
    }
    if (Buffer.byteLength(finalText) > 8_000_000)
      throw new Error('Codex response exceeded the result limit.');
    try {
      return JSON.parse(finalText);
    } catch {
      throw new Error('Codex returned no valid structured test result. Resume the case to retry.');
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
    await connection.close();
  }
}
