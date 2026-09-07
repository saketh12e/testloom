import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export async function executablePath(name: string): Promise<string | undefined> {
  if (name.includes('/')) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return;
    }
  }
  const extra = [
    path.join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  try {
    const root = path.join(homedir(), '.nvm/versions/node');
    const versions = (await readdir(root)).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    extra.push(...versions.map((v) => path.join(root, v, 'bin')));
  } catch {
    /* nvm is optional */
  }
  for (const dir of [...(process.env.PATH || '').split(path.delimiter), ...extra]) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* continue */
    }
  }
}

export interface ProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}
export async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    stdin?: string;
    onOutput?: (text: string) => void;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  const resolved = await executablePath(executable);
  if (!resolved)
    throw new Error(
      `${executable} is not installed or cannot be found. Install it, then restart Testloom.`,
    );
  if (options.signal?.aborted)
    return { code: null, output: 'Cancelled.', timedOut: false, cancelled: true, durationMs: 0 };
  const node = await executablePath('node');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PATH: [
      path.dirname(resolved),
      node ? path.dirname(node) : '',
      process.env.PATH,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]
      .filter(Boolean)
      .join(':'),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let output = '';
    let timedOut = false;
    let cancelled = false;
    const child = spawn(resolved, args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Only the group created by this detached spawn belongs to this operation.
    const group = process.platform !== 'win32' ? child.pid : undefined;
    let gone = false;
    const alive = (): boolean => {
      if (gone || !child.pid) return false;
      if (!group) return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-group, 0);
        return true;
      } catch (error: any) {
        if (error.code === 'ESRCH') gone = true;
        return !gone;
      }
    };
    const signal = (value: NodeJS.Signals): void => {
      if (!alive()) return;
      try {
        if (group) process.kill(-group, value);
        else child.kill(value);
      } catch (error: any) {
        if (error.code === 'ESRCH') gone = true;
      }
    };
    const waitForExit = async (milliseconds: number): Promise<void> => {
      const deadline = Date.now() + milliseconds;
      while (alive() && Date.now() < deadline) {
        // Keep cleanup alive even after the leader and its stdio have closed.
        await new Promise<void>((done) =>
          setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now()))),
        );
      }
    };
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return;
      clearTimeout(timeout);
      stopping = (async () => {
        signal('SIGTERM');
        await waitForExit(1500);
        signal('SIGKILL');
        // Reaping can lag delivery (including orphan zombies); never wait forever.
        await waitForExit(500);
      })();
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 180_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    const consume = (data: Buffer) => {
      const text = data.toString();
      output = (output + text).slice(-200_000);
      options.onOutput?.(text);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      void Promise.resolve(stopping).then(() => reject(error));
    });
    child.once('close', (code) => {
      cleanup();
      void Promise.resolve(stopping).then(() =>
        resolve({ code, output, timedOut, cancelled, durationMs: Date.now() - start }),
      );
    });
    // Abort may have arrived while resolving the Node executable above.
    if (options.signal?.aborted) abort();
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
  });
}
