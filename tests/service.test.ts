import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JourneyService } from '../src/core/service';
import { writeGeneratedFiles } from '../src/core/repository';

test('closing the service awaits cancellation and records no successful verification', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'journeyproof-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  await mkdir(path.join(workspace, '.journeyproof'), { recursive: true });
  const files = [{ path: 'tests/journeyproof/a.spec.ts', content: '// generated test\n' }];
  const patch = await writeGeneratedFiles(workspace, files, 'tests/journeyproof');
  const service = new JourneyService(root, '/unused');
  service.state.generation = {
    provider: 'portable',
    summary: 'test',
    files,
    warnings: [],
    workspace,
    patch,
    generatedAt: new Date().toISOString(),
  };
  const run = service.verify({
    command: {
      executable: process.execPath,
      args: [
        '-e',
        "require('fs').writeFileSync('ready','yes');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
      ],
      label: 'shutdown fixture',
    },
    repeats: 1,
  });
  for (let i = 0; i < 100; i++) {
    try {
      await access(path.join(workspace, 'ready'));
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  await service.close();
  await run;
  assert.equal(service.state.phase, 'idle');
  assert.equal(service.state.verification?.status, 'cancelled');
});

test('export refuses a changed test instead of pairing stale tests with passing evidence', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'journeyproof-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  await mkdir(path.join(workspace, '.journeyproof'), { recursive: true });
  const files = [{ path: 'tests/journeyproof/a.spec.ts', content: 'expect(total).toBe(90);\n' }];
  const patch = await writeGeneratedFiles(workspace, files, 'tests/journeyproof');
  const service = new JourneyService(root, '/unused');
  service.state.scenario = {
    schemaVersion: 1,
    id: 'scenario',
    name: 'coupon',
    startUrl: 'http://localhost/',
    createdAt: new Date().toISOString(),
    events: [],
    assertions: [],
    network: [],
    warnings: [],
  };
  service.state.generation = {
    provider: 'portable',
    summary: 'test',
    files,
    warnings: [],
    workspace,
    patch,
    generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(workspace, files[0].path), 'expect(total).toBe(95);\n');
  await assert.rejects(service.exportTo(root), /changed on disk/);
  await service.close();
});

import { demoCases } from '../src/core/demo';

test('case variants, batch generation and edits keep recording and source independent', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-suite-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const pkg = '{"devDependencies":{"@playwright/test":"1.63.0"}}';
  await writeFile(path.join(source, 'package.json'), pkg);
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  await mkdir(service.root);
  await service.connect(source);
  service.state.cases = demoCases();
  service.state.activeCaseId = service.state.cases[0].id;
  service.state.scenario = service.state.cases[0].scenario;
  const original = structuredClone(service.state.cases[0]);
  await service.duplicateCase({ id: original.id, kind: 'negative' });
  const variant = service.state.cases.at(-1)!;
  assert.equal(variant.kind, 'negative');
  assert.deepEqual(
    variant.scenario.assertions,
    original.scenario.assertions,
    'Changing category never silently changes the requirement',
  );
  variant.name = 'Expired coupons are rejected';
  variant.scenario.events.find((e) => e.action === 'fill')!.value = 'EXPIRED';
  variant.scenario.assertions[0].expected = '$100.00';
  await service.saveCase(variant);
  assert.equal(
    service.state.cases[0].scenario.events.find((e) => e.action === 'fill')!.value,
    'SAVE10',
  );
  await service.generate({
    mode: 'portable',
    caseIds: service.state.cases.slice(0, 3).map((c) => c.id),
  });
  assert.equal(service.state.generation?.files.length, 3);
  assert.equal(new Set(service.state.generation?.files.map((f) => f.path)).size, 3);
  assert.equal(service.state.history[0].status, 'generated');
  assert.equal(await readFile(path.join(source, 'package.json'), 'utf8'), pkg);
  await assert.rejects(access(path.join(source, 'tests')));
  assert.ok(
    service.state.generation?.files.some((f) =>
      f.content.includes('Coupon INVALID is invalid. No discount applied.'),
    ),
  );
  const edit = structuredClone(service.state.cases[0]);
  edit.scenario.assertions[0].expected = '$91.00';
  await service.saveCase(edit);
  assert.equal(service.state.generation, undefined);
  assert.equal(
    service.state.verification,
    undefined,
    'Old evidence is invalidated when requirements change',
  );
  const exported = path.join(root, 'suite.json');
  await service.exportSuiteTo(exported);
  await service.importSuiteFrom(exported);
  assert.equal(service.state.cases.length, 8);
  assert.equal(new Set(service.state.cases.map((c) => c.id)).size, 8);
  await service.close();
});

test('case libraries survive switching projects and reopening the application', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = path.join(root, 'one'),
    two = path.join(root, 'two');
  await mkdir(one);
  await mkdir(two);
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  await mkdir(service.root);
  await service.connect(one);
  service.state.cases = demoCases();
  await service.selectCase({ id: service.state.cases[1].id });
  await service.connect(two);
  assert.equal(service.state.cases.length, 0);
  await service.connect(one);
  assert.equal(service.state.cases.length, 3);
  assert.equal(
    service.state.cases.find((c) => c.id === service.state.activeCaseId)?.kind,
    'negative',
  );
  await service.close();
  const reopened = new JourneyService(service.root, '/unused');
  await reopened.initialize();
  assert.equal(reopened.state.cases.length, 3);
  assert.equal(reopened.state.settings.provider, 'codex');
  await reopened.close();
});

test('disabled, empty and oversized generation selections are rejected before creating a run', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  await mkdir(service.root);
  await service.connect(source);
  service.state.cases = demoCases();
  service.state.scenario = service.state.cases[0].scenario;
  service.state.activeCaseId = service.state.cases[0].id;
  const id = service.state.activeCaseId;
  service.state.cases[0].enabled = false;
  await assert.rejects(service.generate({ mode: 'portable', caseIds: [id] }), /disabled/);
  await assert.rejects(service.generate({ mode: 'portable', caseIds: [] }), /1 and 20/);
  await assert.rejects(
    service.generate({
      mode: 'portable',
      caseIds: Array.from({ length: 21 }, (_, i) => String(i)),
    }),
    /1 and 20/,
  );
  assert.equal(service.state.history.length, 0);
  assert.equal(service.state.phase, 'idle');
  await service.close();
});

test('v1 migration preserves requirements and invalidates evidence tied to the old scenario identity', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenario = demoCases()[0].scenario;
  await writeFile(
    path.join(root, 'session.json'),
    JSON.stringify({
      workspaceRoot: root,
      phase: 'idle',
      scenario,
      activity: [],
      codex: { available: false },
      project: {
        id: 'legacy',
        name: 'Legacy project',
        path: '/tmp/legacy-testloom-fixture',
        framework: 'playwright-ts',
        buildTool: 'npm',
        summary: '',
        examples: [],
        commands: [],
        outputDir: 'tests/journeyproof',
      },
      generation: { provider: 'portable', files: [] },
      verification: { status: 'passed' },
    }),
  );
  const service = new JourneyService(root, '/unused');
  await service.initialize();
  assert.equal(service.state.cases.length, 1);
  assert.deepEqual(service.state.cases[0].scenario.assertions, scenario.assertions);
  assert.equal(service.state.cases[0].recordingId, scenario.id);
  assert.equal(service.state.project?.outputDir, 'tests/testloom');
  assert.equal(service.state.generation, undefined);
  assert.equal(service.state.verification, undefined);
  await service.close();
});

test('corrupt session has a byte-identical recovery copy instead of silent data loss', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const broken = '{"cases": [ unfinished user data';
  await writeFile(path.join(root, 'session.json'), broken);
  const service = new JourneyService(root, '/unused');
  await service.initialize();
  assert.match(service.state.error!, /recovery copy/);
  const { readdir } = await import('node:fs/promises');
  const backup = (await readdir(root)).find((f) => f.startsWith('session-recovery-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(root, backup), 'utf8'), broken);
  await service.close();
});

test('explicit context selection rejects outside-project and credential files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'helper.ts'), 'export const fixture = "safe";');
  await writeFile(path.join(source, '.env'), 'PASSWORD=secret');
  await writeFile(path.join(root, 'outside.ts'), 'private');
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  await mkdir(service.root);
  await service.connect(source);
  await service.addContextFiles([path.join(source, 'helper.ts')]);
  assert.ok(service.state.project!.examples.find((e) => e.path === 'helper.ts'));
  await assert.rejects(
    service.addContextFiles([path.join(root, 'outside.ts')]),
    /inside this project/,
  );
  await assert.rejects(service.addContextFiles([path.join(source, '.env')]), /Credential/);
  await service.close();
});
