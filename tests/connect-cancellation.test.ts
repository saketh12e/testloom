import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JourneyService } from '../src/core/service';
import { demoCases } from '../src/core/demo';

test('late connect cancellation retains the current project and case library', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'testloom-connect-cancel-')));
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  let restoreRead: (() => void) | undefined;
  t.after(async () => {
    restoreRead?.();
    syncBuiltinESMExports();
    await service.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const originalFolder = path.join(root, 'original');
  const nextFolder = path.join(root, 'next');
  await Promise.all([service.root, originalFolder, nextFolder].map((folder) => fs.mkdir(folder)));
  await fs.writeFile(path.join(nextFolder, 'source.ts'), 'export const value = 1;\n');
  await service.connect(originalFolder);
  const originalCase = demoCases()[0];
  service.state.cases = [originalCase];
  await service.selectCase({ id: originalCase.id });
  const originalProject = structuredClone(service.state.project);
  const originalCases = structuredClone(service.state.cases);
  const nextLibrary = path.join(
    service.root,
    'libraries',
    createHash('sha256').update(nextFolder).digest('hex') + '.json',
  );

  const readFile = fs.readFile;
  let cancellations = 0;
  // Cancel after inspection has returned, at the real saved-library I/O boundary.
  // Cancelling inside scan progress would also pass without connect's final abort guard.
  const read = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === nextLibrary) {
      cancellations++;
      assert.equal(service.state.phase, 'indexing');
      assert.ok(
        service.state.activity.some((entry) => entry.message === 'Indexed 1 source files.'),
      );
      await service.cancel();
    }
    return readFile(...args);
  });
  restoreRead = () => read.mock.restore();
  syncBuiltinESMExports();

  await assert.rejects(service.connect(nextFolder), { name: 'AbortError' });
  assert.equal(cancellations, 1);
  assert.equal(service.state.phase, 'idle');
  assert.deepEqual(service.state.project, originalProject);
  assert.deepEqual(service.state.cases, originalCases);
  assert.equal(service.state.activeCaseId, originalCase.id);
  assert.deepEqual(service.state.scenario, originalCase.scenario);
  assert.equal(
    service.state.activity.some((entry) => entry.message.startsWith('Connected next.')),
    false,
  );

  restoreRead();
  syncBuiltinESMExports();
  await service.connect(nextFolder);
  assert.equal(service.state.project?.path, nextFolder);
  assert.equal(service.state.phase, 'idle');
});
