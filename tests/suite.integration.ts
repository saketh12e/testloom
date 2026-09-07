import { JourneyService } from '../src/core/service';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyWorkspace } from '../src/core/verifier';

const root = await mkdtemp(path.join(tmpdir(), 'testloom-batch-'));
const service = new JourneyService(root, path.resolve('examples/cart'));
try {
  await service.initialize();
  await service.loadDemo();
  const source = await readFile(path.join(service.state.project!.path, 'server.mjs'), 'utf8');
  const ids = service.state.cases.map((c) => c.id);
  await service.generate({ mode: 'portable', caseIds: ids });
  await service.verify({ command: service.state.project!.commands[0], repeats: 2 });
  assert.equal(service.state.verification?.status, 'passed');
  assert.equal(service.state.verification?.discoveredTests?.length, 3);
  const generation = service.state.generation!;
  const mutant = await verifyWorkspace(
    generation.workspace,
    service.state.project!.commands[0],
    1,
    {
      env: { JOURNEYPROOF_BROKEN_DISCOUNT: '1' },
      expectedPlaywrightFiles: generation.files.map((f) => f.path),
    },
  );
  assert.equal(mutant.status, 'failed');
  assert.match(mutant.runs[0].output, /95\.00/);
  assert.equal(
    await readFile(path.join(service.state.project!.path, 'server.mjs'), 'utf8'),
    source,
  );
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/suite-validation.json',
    JSON.stringify(
      {
        cases: service.state.cases.map((c) => ({ name: c.name, kind: c.kind })),
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
      cases: 3,
      healthyRuns: 2,
      discovered: 3,
      mutant: mutant.status,
      sourceUnchanged: true,
    }),
  );
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
