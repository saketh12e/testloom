import { JourneyService } from '../src/core/service';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await mkdtemp(path.join(tmpdir(), 'testloom-batch20-'));
const service = new JourneyService(root, path.resolve('examples/cart'));
try {
  await service.initialize();
  await service.loadDemo();
  const originals = structuredClone(service.state.cases);
  for (let i = 0; i < 17; i++) {
    const sample = originals[i % 3];
    await service.duplicateCase({ id: sample.id, kind: sample.kind });
  }
  const ids = service.state.cases.map((c) => c.id);
  await service.generate({ mode: 'portable', caseIds: ids });
  assert.equal(service.state.generation?.files.length, 20);
  await service.verify({ command: service.state.project!.commands[0], repeats: 1 });
  assert.equal(
    service.state.verification?.status,
    'passed',
    JSON.stringify(service.state.verification),
  );
  assert.equal(service.state.verification?.discoveredTests?.length, 20);
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/batch20-validation.json',
    JSON.stringify(
      { generated: 20, verified: 20, status: 'passed', verification: service.state.verification },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ generated: 20, verified: 20, status: 'passed' }));
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
