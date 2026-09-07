import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JourneyService } from '../src/core/service';
import { BrowserRecorder } from '../src/core/recorder';
import { demoCases } from '../src/core/demo';
import { validateCase } from '../src/core/suite';
import type { InteractionEvent } from '../src/shared/types';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'testloom-service-audit-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(
    path.join(source, 'package.json'),
    '{"devDependencies":{"@playwright/test":"1.63.0"}}',
  );
  const service = new JourneyService(path.join(root, 'app'), '/unused');
  await mkdir(service.root);
  await service.connect(source);
  const original = demoCases()[0];
  service.state.cases = [original];
  await service.selectCase({ id: original.id });
  const instances = [service];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, instances, original };
}

test('audit: saved empty-text requirements must remain generatable in a negative case', async (t) => {
  const { service, original } = await fixture(t);
  await service.duplicateCase({ id: original.id, kind: 'negative' });
  const edited = structuredClone(service.state.cases.at(-1)!);
  edited.scenario.events.find((event) => event.action === 'fill')!.value = '';
  edited.scenario.assertions.push({
    id: 'no-success-message',
    source: 'user',
    kind: 'text',
    description: 'Do not show a success message for an empty coupon.',
    locator: { strategy: 'testId', value: 'coupon-success' },
    expected: '',
  });
  assert.doesNotThrow(() => validateCase(edited));
  await service.saveCase(edited);
  assert.equal(service.state.scenario!.assertions.at(-1)!.expected, '');
  assert.equal(service.state.scenario!.events.find((event) => event.action === 'fill')!.value, '');
  // This is an explicit assertion of empty text, rather than a missing requirement.
  await service.generate({ mode: 'portable', caseIds: [original.id, edited.id] });
  assert.equal(service.state.generation!.files.length, 2);
  assert.ok(
    service.state.generation!.files.some((file) => file.content.includes('toHaveText("")')),
  );
});

test('audit: cancelling immediately after recording starts must prevent the pending launch', async (t) => {
  const { service } = await fixture(t);
  let launches = 0;
  // Substitute only browser I/O. The service's actual directory await, phase
  // changes, cancellation, recorder assignment and persistence all run normally.
  t.mock.method(BrowserRecorder.prototype, 'start', async () => {
    launches++;
  });
  t.mock.method(BrowserRecorder.prototype, 'stop', async () => ({
    events: [],
    network: [],
    warnings: [],
  }));
  const starting = service.startRecording({
    url: 'http://localhost:4318/',
    name: 'Cancelled journey',
    captureScreenshots: false,
  });
  assert.equal(service.state.phase, 'recording');
  await service.cancel();
  const outcome = await starting.then(
    () => 'resolved',
    (error) => String(error),
  );
  t.diagnostic(
    `After cancel: start=${outcome}; launches=${launches}; phase=${service.state.phase}`,
  );
  assert.equal(launches, 0, 'Cancellation must cover the await before the recorder is assigned.');
  assert.equal(service.state.phase, 'idle');
});

test('audit control: a legacy single recording migrates with its requirements unchanged', async (t) => {
  const { service, instances, original } = await fixture(t);
  await service.close();
  const legacy = {
    ...service.state,
    cases: undefined,
    activeCaseId: undefined,
    scenario: original.scenario,
  };
  await writeFile(path.join(service.root, 'session.json'), JSON.stringify(legacy));
  const reopened = new JourneyService(service.root, '/unused');
  instances.push(reopened);
  await reopened.initialize();
  assert.equal(reopened.state.cases.length, 1);
  assert.equal(reopened.state.cases[0].recordingId, original.scenario.id);
  assert.deepEqual(reopened.state.cases[0].scenario.assertions, original.scenario.assertions);
});

test('audit: an interrupted recording must be retained alongside an existing case library', async (t) => {
  const { service, instances, original } = await fixture(t);
  const event: InteractionEvent = {
    id: 'unsaved-event',
    sequence: 1,
    timestamp: new Date().toISOString(),
    action: 'navigate',
    url: 'http://localhost:4318/new-journey',
    pageId: 'page-1',
    label: 'New captured journey',
    locators: [],
  };
  t.mock.method(BrowserRecorder.prototype, 'start', async function (this: BrowserRecorder) {
    // Deliver an event through the same callback the real browser uses, without
    // launching a browser that could interfere with the parallel desktop audit.
    (this as unknown as { options: { onEvent(event: InteractionEvent): void } }).options.onEvent(
      structuredClone(event),
    );
  });
  t.mock.method(BrowserRecorder.prototype, 'stop', async () => ({
    events: [event],
    network: [],
    warnings: [],
  }));
  await service.startRecording({
    url: event.url,
    name: 'Interrupted journey',
    captureScreenshots: false,
  });
  await (service as unknown as { persistQueue: Promise<void> }).persistQueue;
  const recordingId = service.state.scenario!.id;
  const saved = JSON.parse(await readFile(path.join(service.root, 'session.json'), 'utf8'));
  assert.equal(saved.phase, 'recording');
  assert.equal(saved.cases.length, 1);
  assert.equal(saved.scenario.events[0].id, event.id);
  assert.deepEqual(
    await readdir(path.join(service.root, 'recordings', recordingId)),
    [],
    'Raw recording.json is written only on stop.',
  );

  // Reopening from the exact saved snapshot simulates a crash before stopRecording.
  const reopened = new JourneyService(service.root, '/unused');
  instances.push(reopened);
  await reopened.initialize();
  const recoverable = reopened.state.cases.some((item) => item.recordingId === recordingId);
  // A normal selection persists the state again. The captured journey must still
  // exist in either the case library or its original recording artifact afterward.
  await reopened.selectCase({ id: original.id });
  await (reopened as unknown as { persistQueue: Promise<void> }).persistQueue;
  const afterSelection = await readFile(path.join(service.root, 'session.json'), 'utf8');
  const rawFiles = await readdir(path.join(service.root, 'recordings', recordingId));
  const libraries = await Promise.all(
    (await readdir(path.join(service.root, 'libraries'))).map((file) =>
      readFile(path.join(service.root, 'libraries', file), 'utf8'),
    ),
  );
  const retainedInLibrary = libraries.some((library) => library.includes(event.id));
  t.diagnostic(
    `Recovered case=${recoverable}; captured event remains in session=${afterSelection.includes(event.id)}; retained in library=${retainedInLibrary}; recording files=${JSON.stringify(rawFiles)}`,
  );
  assert.equal(
    recoverable ||
      afterSelection.includes(event.id) ||
      retainedInLibrary ||
      rawFiles.includes('recording.json'),
    true,
    'Reopening and selecting an existing case must not erase the interrupted recording.',
  );
});
