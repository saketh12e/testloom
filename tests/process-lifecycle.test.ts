import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { runProcess } from '../src/core/process';

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error: any) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  // Linux containers may not promptly reap an orphan; a zombie is already dead.
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false;
  }
}

for (const mode of ['cancel', 'timeout'] as const) {
  test(
    `${mode} waits for the owned detached group after its leader exits`,
    { skip: process.platform === 'win32', timeout: 12_000 },
    async () => {
      // This separate detached group must survive cleanup of the tested operation.
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      await once(sentinel, 'spawn');
      let descendant: number | undefined;
      const controller = new AbortController();
      let output = '';
      const descendantCode =
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
      // The leader is detached by runProcess. Its descendant shares that owned
      // group, ignores SIGTERM, and releases stdio so the leader can close first.
      const leaderCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => { console.log(child.pid); child.stdout.destroy(); });
      setInterval(() => {}, 1000);
    `;
      try {
        const result = await runProcess(process.execPath, ['-e', leaderCode], {
          cwd: tmpdir(),
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 1000 : 7000,
          onOutput: (text) => {
            output += text;
            if (!descendant && output.includes('\n')) {
              descendant = Number(output.trim());
              if (mode === 'cancel') controller.abort();
            }
          },
        });
        assert.ok(
          descendant && Number.isSafeInteger(descendant),
          'descendant announced readiness before termination',
        );
        assert.equal(result.cancelled, mode === 'cancel');
        assert.equal(result.timedOut, mode === 'timeout');
        assert.notEqual(result.code, 0);
        assert.equal(running(descendant), false, 'descendant is dead when runProcess resolves');
        assert.equal(running(sentinel.pid!), true, 'unrelated detached group remains alive');
        assert.ok(result.durationMs < 6000, 'cleanup is bounded');
      } finally {
        controller.abort();
        // Only known, individually spawned PIDs are used for fallback test cleanup.
        if (descendant && running(descendant)) {
          try {
            process.kill(descendant, 'SIGKILL');
          } catch {}
        }
        if (sentinel.exitCode === null && sentinel.signalCode === null) {
          const exited = once(sentinel, 'exit');
          sentinel.kill('SIGKILL');
          await exited;
        }
      }
    },
  );
}
