// Run separately: npx tsx tests/journey.integration.ts
// Owns port 4318 briefly; refuses to reuse or terminate somebody else's server.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserRecorder } from '../src/core/recorder';
import { portableGenerate } from '../src/core/generator';
import { inspectProject, listProjectFiles, snapshotProject, writeGeneratedFiles } from '../src/core/repository';
import { verifyWorkspace } from '../src/core/verifier';
import type { InteractionEvent, Scenario, Verification } from '../src/shared/types';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(repo, 'examples/cart');
const summaryPath = path.join(repo, 'work/verification-integration.json');
const startUrl = 'http://127.0.0.1:4318/';
const command = { executable: 'npm', args: ['test'], label: 'Cart generated journey integration' };

async function sourceDigest(): Promise<string> {
  // Same source-file boundary as the production snapshot; excludes dependencies
  // and test artifacts that the owner's independent checks may create.
  const hash = createHash('sha256');
  for (const file of await listProjectFiles(source)) hash.update(file).update(await readFile(path.join(source, file)));
  return hash.digest('hex');
}

async function requireFreePort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Port 4318 is occupied. Stop the other run before this integration; its server was not touched.')));
    probe.listen({ host: '127.0.0.1', port: 4318, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function stopOwnedServer(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function waitForServer(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`Recording server did not become ready: ${output}`)), 10_000);
    const onExit = () => finish(new Error(`Recording server exited before readiness: ${output}`));
    const onError = (error: Error) => finish(error);
    const consume = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('JourneyProof cart ready at http://127.0.0.1:4318')) finish();
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.off('error', onError); child.off('exit', onExit);
      child.stdout?.off('data', consume); child.stderr?.off('data', consume);
      if (error) reject(error); else resolve();
    }
    child.once('error', onError); child.once('exit', onExit);
    child.stdout?.on('data', consume); child.stderr?.on('data', consume);
  });
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const before = await sourceDigest();
  const temp = await mkdtemp(path.join(tmpdir(), 'journeyproof-full-integration-'));
  const workspace = path.join(temp, 'verification');
  const summary: Record<string, unknown> = { status: 'running', startedAt, source, sourceDigestBefore: before, workspace, command };
  let recorder: BrowserRecorder | undefined;
  let server: ChildProcess | undefined;
  let failure: unknown;
  try {
    assert(!temp.startsWith(source + path.sep), 'Workspace must be outside the original source');
    const project = await inspectProject(source);
    assert.equal(project.framework, 'playwright-ts');
    assert(project.commands.some((candidate) => candidate.executable === 'npm' && candidate.args.join(' ') === 'test'));
    const recordingCopy = path.join(temp, 'recording-source');
    const recordingSnapshot = await snapshotProject(project, recordingCopy);
    assert.equal(recordingSnapshot.digest, before);
    await requireFreePort();
    const serverEnv: NodeJS.ProcessEnv = { ...process.env, PORT: '4318', JOURNEYPROOF_BROKEN_DISCOUNT: '0' };
    delete serverEnv.ELECTRON_RUN_AS_NODE;
    console.log('START recording server on port 4318 (owned temporary source copy).');
    server = spawn(process.execPath, ['server.mjs'], { cwd: recordingCopy, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    await waitForServer(server);
    summary.recordingServerPid = server.pid;
    const callbacks: InteractionEvent[] = [];
    recorder = new BrowserRecorder({ artifactDir: path.join(temp, 'screenshots'), onEvent: (event) => callbacks.push(event) });
    await recorder.start(startUrl, { headless: true, captureScreenshots: false });
    const page = recorder.page;
    page.setDefaultTimeout(10_000);
    await page.getByTestId('add-notebook').click();
    await page.getByTestId('add-bag').click();
    await page.getByTestId('coupon').fill('SAVE10');
    await page.getByTestId('apply-coupon').click();
    await page.getByTestId('total').filter({ hasText: /^\$90\.00$/ }).waitFor();
    const recording = await recorder.stop();
    await stopOwnedServer(server);
    server = undefined;
    console.log('STOP recording server; port 4318 released before verification.');
    await requireFreePort();
    assert.deepEqual(callbacks, recording.events, 'Callbacks and flushed event ledger differ');
    const order = recording.events.map((event) => ({ action: event.action, target: event.locators[0]?.value ?? '', value: event.value ?? '' }));
    summary.eventOrder = order;
    assert.deepEqual(order, [
      { action: 'navigate', target: '', value: '' },
      { action: 'click', target: 'add-notebook', value: '' },
      { action: 'click', target: 'add-bag', value: '' },
      { action: 'fill', target: 'coupon', value: 'SAVE10' },
      { action: 'click', target: 'apply-coupon', value: '' },
    ], 'Recording has duplicate navigation, redundant actions, or incorrect event order');
    assert.deepEqual(recording.events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert(recording.events.every((event) => event.pageId === 'page-1' && event.url === startUrl && !event.redacted && !event.screenshot));
    assert.equal(recording.network.filter((entry) => entry.method === 'POST' && entry.url === `${startUrl}api/cart` && entry.status === 200).length, 3);
    const scenario: Scenario = {
      schemaVersion: 1, id: 'cart-integration-save10-0001', name: 'Recorded cart SAVE10 totals ninety dollars',
      startUrl, createdAt: startedAt, ...recording,
      assertions: [{ id: 'cart-total-90', description: 'Both products with SAVE10 total exactly $90.00',
        kind: 'text', locator: { strategy: 'testId', value: 'total' }, expected: '$90.00', source: 'user' }],
    };
    summary.scenario = scenario;
    const generated = portableGenerate(project, scenario);
    assert.equal(generated.files.length, 1);
    const code = generated.files[0].content;
    assert(generated.files[0].path.endsWith('.spec.ts'));
    assert.equal((code.match(/page\.goto\(/g) ?? []).length, 1);
    assert.equal((code.match(/\.click\(/g) ?? []).length, 3);
    assert.equal((code.match(/\.fill\(/g) ?? []).length, 1);
    assert(!code.includes('toHaveURL('), 'No duplicate navigation observation should be generated');
    assert(code.includes('getByTestId("total")).toHaveText("$90.00")'));
    const snapshot = await snapshotProject(project, workspace);
    assert.equal(snapshot.digest, before);
    summary.snapshot = snapshot;
    summary.generatedFiles = generated.files;
    const patch = await writeGeneratedFiles(workspace, generated.files, project.outputDir);
    assert(patch.includes(generated.files[0].path));
    assert.equal(await readFile(path.join(workspace, generated.files[0].path), 'utf8'), code);
    const options = { prepareDemo: true, timeoutMs: 60_000, signal: AbortSignal.timeout(180_000), onProgress: (message: string) => console.log(message) };
    const env = { PORT: '4318', JOURNEYPROOF_FRESH_SERVER: '1', JOURNEYPROOF_BROKEN_DISCOUNT: '0' };
    const healthy = await verifyWorkspace(workspace, command, 2, { ...options, env });
    summary.healthy = healthy;
    assert.equal(healthy.status, 'passed', JSON.stringify(healthy));
    assert.equal(healthy.runs.length, 2);
    for (const run of healthy.runs) {
      assert.equal(run.status, 'passed'); assert.equal(run.exitCode, 0);
      assert(run.output.includes(scenario.name), 'The generated journey was not discovered');
    }
    await requireFreePort();
    const broken: Verification = await verifyWorkspace(workspace, command, 1, { ...options, env: { ...env, JOURNEYPROOF_BROKEN_DISCOUNT: '1' } });
    summary.broken = broken;
    assert.equal(broken.status, 'failed', JSON.stringify(broken));
    assert.equal(broken.runs.length, 1);
    assert.equal(broken.runs[0].status, 'failed');
    assert.notEqual(broken.runs[0].exitCode, 0);
    const output = broken.runs[0].output.replace(/\u001b\[[0-9;]*m/g, '');
    assert(output.includes(scenario.name), 'Broken run must execute the generated journey');
    assert.match(output, /Expected[^\n]*\$90\.00/);
    assert.match(output, /Received[^\n]*\$95\.00/);
    assert.equal(await readFile(path.join(workspace, generated.files[0].path), 'utf8'), code, 'Mutation verification changed the assertion');
    summary.status = 'passed';
  } catch (error) {
    failure = error;
    summary.status = 'failed';
    summary.error = error instanceof Error ? error.stack : String(error);
  } finally {
    await recorder?.stop().catch(() => undefined);
    await stopOwnedServer(server);
    const after = await sourceDigest();
    summary.sourceDigestAfter = after;
    summary.sourceUnchanged = before === after;
    if (before !== after) { failure ??= new Error('Original cart source digest changed'); summary.status = 'failed'; }
    summary.completedAt = new Date().toISOString();
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    await rm(temp, { recursive: true, force: true });
    console.log(`COMPLETE: ${summary.status}; temporary workspace removed. Summary: ${summaryPath}`);
  }
  if (failure) throw failure;
}

await main().catch((error) => { console.error(error); process.exitCode = 1; });
