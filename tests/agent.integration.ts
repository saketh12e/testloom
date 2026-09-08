// Explicit opt-in live account test: TESTLOOM_AGENT=codex|claude npx tsx tests/agent.integration.ts
import { JourneyService } from '../src/core/service';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyWorkspace } from '../src/core/verifier';
import { listProjectFiles } from '../src/core/repository';
import { createHash } from 'node:crypto';
const provider = process.env.TESTLOOM_AGENT;
if (provider !== 'codex' && provider !== 'claude')
  throw new Error('Set TESTLOOM_AGENT to codex or claude to authorize this live account test.');
const root = await mkdtemp(path.join(tmpdir(), `testloom-live-${provider}-`));
const service = new JourneyService(root, path.resolve('examples/cart'));
async function digest(folder: string) {
  const hash = createHash('sha256');
  for (const file of await listProjectFiles(folder))
    hash.update(file).update(await readFile(path.join(folder, file)));
  return hash.digest('hex');
}
let last = '';
service.on('update', (state) => {
  const message = state.activity.at(-1)?.message;
  if (message !== last) {
    last = message;
    console.log(message);
  }
});
try {
  await service.initialize();
  await service.loadDemo();
  await service.saveSettings({
    ...service.state.settings,
    provider,
    model: process.env.TESTLOOM_MODEL || '',
    effort: 'max',
    timeoutSeconds: 480,
    claudeBudgetUsd: 1,
  });
  const before = await digest(service.state.project!.path);
  const ids = service.state.cases.slice(0, 2).map((c) => c.id);
  await service.generate({ mode: provider, caseIds: ids });
  const generation = service.state.generation!;
  for (const c of service.state.cases.slice(0, 2))
    for (const assertion of c.scenario.assertions)
      assert.ok(
        generation.files.some((f) => f.content.includes(assertion.id)),
        `${provider} retained requirement ${assertion.description}`,
      );
  await service.verify({ command: service.state.project!.commands[0], repeats: 2 });
  assert.equal(
    service.state.verification?.status,
    'passed',
    JSON.stringify(service.state.verification),
  );
  const mutant = await verifyWorkspace(
    generation.workspace,
    service.state.project!.commands[0],
    1,
    {
      env: { JOURNEYPROOF_BROKEN_DISCOUNT: '1' },
      expectedPlaywrightFiles: generation.files
        .filter((f) => /\.(spec|test)\.[jt]s$/.test(f.path))
        .map((f) => f.path),
    },
  );
  assert.equal(mutant.status, 'failed', JSON.stringify(mutant));
  assert.match(mutant.runs[0].output, /95\.00/);
  assert.equal(await digest(service.state.project!.path), before);
  await mkdir('work', { recursive: true });
  await writeFile(
    `work/${provider}-v3-validation.json`,
    JSON.stringify(
      {
        provider,
        settings: service.state.settings,
        cases: service.state.cases.slice(0, 2),
        generation,
        healthy: service.state.verification,
        mutant,
        sourceUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      provider,
      cases: 2,
      healthyRuns: 2,
      discovered: service.state.verification?.discoveredTests?.length,
      mutant: mutant.status,
      sourceUnchanged: true,
    }),
  );
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
