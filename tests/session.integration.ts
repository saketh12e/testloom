// Opt-in real provider/session check; uses synthetic data and your authenticated account.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { codexServerGenerate } from '../src/core/codex-server';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/agents';

if (process.env.TESTLOOM_LIVE_SESSION !== 'codex')
  throw new Error('Set TESTLOOM_LIVE_SESSION=codex to run the live account check.');
const root = await mkdtemp(path.join(tmpdir(), 'testloom-session-live-'));
const workspace = path.join(root, 'source-copy'),
  cwd = path.join(root, 'case-session');
await Promise.all([mkdir(path.join(workspace, 'backend'), { recursive: true }), mkdir(cwd)]);
const memory = 'MEMORY_' + randomUUID().slice(0, 8),
  visual = 'VISUAL_' + randomUUID().slice(0, 8);
const firstValue = randomUUID(),
  secondValue = randomUUID();
const source = path.join(workspace, 'backend/contract.json');
const screenshot = path.join(root, 'recorded-event.png');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  await page.setContent(
    `<html><body style="font:48px monospace;padding:50px">Recorded receipt<br>${visual}</body></html>`,
  );
  await page.screenshot({ path: screenshot });
} finally {
  await browser.close();
}
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['memory', 'backend', 'visual'],
  properties: {
    memory: { type: 'string' },
    backend: { type: 'string' },
    visual: { type: 'string' },
  },
};
let sessionId = '',
  toolCalls = 0;
const settings = { ...DEFAULT_AGENT_SETTINGS, timeoutSeconds: 480 };
const progress: string[] = [];
const options = {
  session: { cwd },
  onSession: (id: string) => {
    sessionId = id;
  },
  onProgress: (message: string) => {
    progress.push(message);
    if (message.includes('tool calls')) toolCalls++;
    console.log(message);
  },
};
try {
  await writeFile(source, JSON.stringify({ backend: firstValue }));
  const first = await codexServerGenerate(
    `This is a synthetic integration test. Remember exactly ${memory} for the next turn. Use repository_read to read backend/contract.json and return its backend field. Read the VISUAL_ word from the attached screenshot. Return memory, backend and visual exactly. Do not modify any files.`,
    schema,
    workspace,
    settings,
    {
      ...options,
      evidenceImages: [
        { path: screenshot, mimeType: 'image/png', label: 'Recorded event 1: receipt displayed' },
      ],
    },
  );
  assert.deepEqual(first, { memory, backend: firstValue, visual });
  assert.equal(await readFile(source, 'utf8'), JSON.stringify({ backend: firstValue }));
  const originalSession = sessionId;
  await writeFile(source, JSON.stringify({ backend: secondValue }));
  const second = await codexServerGenerate(
    'Continue this same case. Recall the exact MEMORY_ and VISUAL_ values from our prior turn. The repository changed; use repository_read to read backend/contract.json again and return its current backend field. Return the same three fields. Do not modify files.',
    schema,
    workspace,
    settings,
    { ...options, session: { cwd, id: originalSession } },
  );
  assert.deepEqual(second, { memory, backend: secondValue, visual });
  assert.equal(sessionId, originalSession);
  assert.ok(toolCalls >= 2);
  assert.equal(await readFile(source, 'utf8'), JSON.stringify({ backend: secondValue }));
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/codex-session-validation.json',
    JSON.stringify(
      {
        status: 'passed',
        nativeSessionId: sessionId,
        turns: 2,
        maximumEffort: true,
        toolCalls,
        screenshotUnderstood: true,
        priorTurnMemoryRecalled: true,
        changedBackendRead: true,
        agentSourceWrites: false,
        progress,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: native session resumed, image understood, memory recalled, changed backend inspected, source unchanged by agent.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
