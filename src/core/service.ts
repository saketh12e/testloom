import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppState, Assertion, Scenario, TestCommand } from '../shared/types';
import { BrowserRecorder } from './recorder';
import { inspectProject, snapshotProject, writeGeneratedFiles, verifyGeneratedBytes } from './repository';
import { portableGenerate, validateScenario } from './generator';
import { codexGenerate, detectCodex } from './codex';
import { verifyWorkspace } from './verifier';
import { executablePath } from './process';

export class JourneyService extends EventEmitter {
  state: AppState;
  private recorder?: BrowserRecorder;
  private controller?: AbortController;
  private demoProcess?: ChildProcess;
  private persistQueue = Promise.resolve();
  private operationDone?: Promise<void>;
  private finishOperation?: () => void;
  constructor(readonly root: string, readonly exampleRoot: string) {
    super(); this.state = { phase: 'idle', activity: [], codex: { available: false }, workspaceRoot: root };
  }
  async initialize(): Promise<AppState> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(path.join(this.root, 'session.json'), 'utf8'));
      if (saved.workspaceRoot === this.root) this.state = { ...saved, phase: 'idle', error: undefined };
    } catch { /* first launch */ }
    this.state.codex = await detectCodex();
    this.log('Ready. Open a project folder or try the cart demo.'); return this.state;
  }
  private emitState(): void {
    this.emit('update', structuredClone(this.state));
    const snapshot = JSON.stringify(this.state, null, 2);
    this.persistQueue = this.persistQueue.then(() => writeFile(path.join(this.root, 'session.json'), snapshot, { mode: 0o600 })).catch(() => {});
  }
  log(message: string): void { this.state.activity.push({ time: new Date().toISOString(), message }); this.state.activity = this.state.activity.slice(-80); this.emitState(); }
  private idle(): void { if (this.state.phase !== 'idle') throw new Error('Finish or cancel the current operation first.'); }
  private beginOperation(): void { this.operationDone = new Promise(resolve => { this.finishOperation = resolve; }); }
  private endOperation(): void { this.finishOperation?.(); this.operationDone = undefined; this.finishOperation = undefined; }
  async connect(folder: string): Promise<AppState> {
    this.idle(); await this.stopDemo();
    const project = await inspectProject(folder);
    this.state = { ...this.state, project, scenario: undefined, generation: undefined, verification: undefined, error: undefined };
    this.log(`Connected ${project.name}. ${project.summary}.`); return this.state;
  }
  async loadDemo(): Promise<AppState> {
    this.idle(); await this.stopDemo();
    const demo = path.join(this.root, 'samples', `cart-${Date.now()}`);
    await mkdir(path.dirname(demo), { recursive: true });
    await cp(this.exampleRoot, demo, { recursive: true, filter: source => !source.split(path.sep).includes('node_modules') && !source.split(path.sep).includes('test-results') });
    await this.connect(demo); this.state.project!.isDemo = true;
    const now = new Date().toISOString();
    this.state.scenario = { schemaVersion: 1, id: randomUUID(), name: 'Apply a cart discount', startUrl: 'http://127.0.0.1:4318', createdAt: now, events: [], network: [], warnings: [], assertions: [{ id: randomUUID(), description: 'SAVE10 reduces the $100 eligible subtotal to $90.', kind: 'text', locator: { strategy: 'testId', value: 'total' }, expected: '$90.00', source: 'user' }] };
    await this.startDemo(); this.log('Demo ready. Record adding both products and applying SAVE10. The $90.00 requirement is prefilled for review.'); return this.state;
  }
  private async startDemo(): Promise<void> {
    if (this.demoProcess && this.demoProcess.exitCode === null) return;
    const node = await executablePath('node'); if (!node) throw new Error('Install Node.js 20.19 or newer to run the sample.');
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: '4318' }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, ['server.mjs'], { cwd: this.state.project!.path, env, stdio: ['ignore','pipe','pipe'], detached: true });
    this.demoProcess = child; let output = ''; let spawnError = '';
    child.stderr?.on('data', data => { output = (output + data).slice(-2000); }); child.on('error', err => { spawnError = err.message; });
    for (let i = 0; i < 60; i++) {
      if (spawnError || child.exitCode !== null) throw new Error(`The demo could not start. Port 4318 may be in use. ${spawnError || output}`);
      try { const r = await fetch('http://127.0.0.1:4318', { signal: AbortSignal.timeout(300) }); if (r.ok) { await new Promise(r => setTimeout(r, 150)); if (child.exitCode !== null) throw new Error(output); return; } } catch { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    await this.stopDemo(); throw new Error('The cart demo did not become ready within six seconds.');
  }
  async stopDemo(): Promise<void> {
    const child = this.demoProcess; this.demoProcess = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { resolve(); } setTimeout(resolve, 2000).unref(); });
  }
  async startRecording(input: { url: string; name: string; captureScreenshots: boolean }): Promise<AppState> {
    this.idle(); if (!this.state.project) throw new Error('Open a project folder first.');
    let url: URL; try { url = new URL(input.url); } catch { throw new Error('Enter a full http:// or https:// URL.'); }
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    if (url.search || url.hash) throw new Error('Start from a URL without a query or fragment. Navigate to the desired page while recording; sensitive URL parameters are removed from evidence.');
    if (this.state.project.isDemo) await this.startDemo();
    const previous = this.state.scenario;
    const scenario: Scenario = { schemaVersion: 1, id: randomUUID(), name: input.name.trim().slice(0,120) || 'Recorded journey', startUrl: url.toString(), createdAt: new Date().toISOString(), events: [], assertions: previous?.assertions || [], warnings: [], network: [] };
    this.state = { ...this.state, scenario, generation: undefined, verification: undefined, error: undefined, phase: 'recording' };
    const artifactDir = path.join(this.root, 'recordings', scenario.id); await mkdir(artifactDir, { recursive: true });
    this.recorder = new BrowserRecorder({ artifactDir, onEvent: event => { scenario.events.push(event); this.emitState(); }, onWarning: warning => { if (!scenario.warnings.includes(warning)) scenario.warnings.push(warning); this.emitState(); } });
    try { await this.recorder.start(url.toString(), { captureScreenshots: Boolean(input.captureScreenshots) }); this.log('Recording in a fresh browser. Complete the journey, then return here and stop.'); }
    catch (error) { this.state.phase = 'idle'; await this.recorder.stop().catch(() => {}); this.recorder = undefined; this.emitState(); throw error; }
    return this.state;
  }
  async stopRecording(): Promise<AppState> {
    if (!this.recorder) throw new Error('There is no active recording.');
    try {
      const result = await this.recorder.stop();
      Object.assign(this.state.scenario!, result);
      this.log(`Recorded ${result.events.length} events. Review the expected results before generating.`);
    } finally { this.recorder = undefined; this.state.phase = 'idle'; this.emitState(); }
    return this.state;
  }
  async saveScenario(input: { name: string; assertions: Assertion[] }): Promise<AppState> {
    this.idle(); if (!this.state.scenario) throw new Error('Record a scenario first.');
    if (typeof input.name !== 'string' || input.name.length > 120 || !Array.isArray(input.assertions) || input.assertions.length > 30 || JSON.stringify(input).length > 50_000) throw new Error('Invalid scenario details.');
    const next = { ...this.state.scenario, name: input.name.trim() || 'Recorded journey', assertions: input.assertions };
    validateScenario(next);
    if (JSON.stringify(next) !== JSON.stringify(this.state.scenario)) { this.state.generation = undefined; this.state.verification = undefined; }
    this.state.scenario = next; this.log('Expected results saved.'); return this.state;
  }
  async generate(input: { mode: 'codex' | 'portable'; model?: string }): Promise<AppState> {
    this.idle(); if (!this.state.project || !this.state.scenario) throw new Error('Connect a project and record a scenario first.');
    if (!['codex','portable'].includes(input.mode)) throw new Error('Choose Codex or portable generation.');
    validateScenario(this.state.scenario);
    this.state.phase = 'generating'; this.state.error = undefined; this.state.generation = undefined; this.state.verification = undefined;
    this.controller = new AbortController(); this.beginOperation(); this.log('Creating an isolated source snapshot. The connected folder will not be edited.');
    try {
      const workspace = path.join(this.root, 'runs', `${Date.now()}-${randomUUID().slice(0,8)}`, 'project');
      await snapshotProject(this.state.project, workspace);
      if (this.controller.signal.aborted) throw new Error('Generation cancelled.');
      await writeFile(path.join(workspace, '.journeyproof/scenario.json'), JSON.stringify(this.state.scenario, null, 2));
      const result = input.mode === 'codex' ? await codexGenerate(this.state.project, this.state.scenario, workspace, { model: input.model, signal: this.controller.signal, onProgress: message => this.log(message) }) : portableGenerate(this.state.project, this.state.scenario);
      if (this.controller.signal.aborted) throw new Error('Generation cancelled.');
      const patch = await writeGeneratedFiles(workspace, result.files, this.state.project.outputDir);
      this.state.generation = { ...result, provider: input.mode, workspace, patch, generatedAt: new Date().toISOString() };
      if (this.state.project.framework === 'playwright-ts') {
        const tests=result.files.filter(f=>/\.(?:spec|test)\.[jt]s$/.test(f.path)).map(f=>f.path);
        if(tests.length) this.state.project.commands = [{executable:'npx',args:['--no-install','playwright','test',...tests,'--reporter=list,json','--retries=0'],label:'Generated tests · confirm discovery'},...this.state.project.commands.filter(c=>c.label!=='Generated tests · confirm discovery')];
      }
      this.log(`Generated ${result.files.length} test file${result.files.length === 1 ? '' : 's'}. Review the code, then verify.`);
    } finally { this.state.phase = 'idle'; this.controller = undefined; this.emitState(); this.endOperation(); }
    return this.state;
  }
  async verify(input: { command: TestCommand; repeats: number }): Promise<AppState> {
    this.idle(); if (!this.state.generation) throw new Error('Generate tests before verifying.');
    this.state.phase = 'verifying'; this.state.error = undefined; this.state.verification = undefined;
    this.controller = new AbortController(); this.beginOperation(); this.log('Preparing verification in the isolated copy.');
    try {
      await this.stopDemo();
      const generation = this.state.generation;
      const fileHashes = await verifyGeneratedBytes(generation.workspace,generation.files);
      const expectedFiles=this.state.project?.framework==='playwright-ts' && input.command.args.includes('--reporter=list,json') ? generation.files.filter(f=>/\.(?:spec|test)\.[jt]s$/.test(f.path)).map(f=>f.path) : undefined;
      const verification = await verifyWorkspace(generation.workspace, input.command, input.repeats, { prepareDemo: this.state.project?.isDemo, signal: this.controller.signal, onProgress: message => this.log(message), expectedPlaywrightFiles:expectedFiles });
      await verifyGeneratedBytes(generation.workspace,generation.files);
      this.state.verification = {...verification,fileHashes};
      await writeFile(path.join(generation.workspace,'.journeyproof/verification.json'),JSON.stringify(this.state.verification,null,2));
      this.log(this.state.verification.statement);
    } finally { this.state.phase = 'idle'; this.controller = undefined; this.emitState(); this.endOperation(); }
    return this.state;
  }
  async cancel(): Promise<AppState> {
    this.controller?.abort();
    if (this.recorder) await this.stopRecording();
    this.log('Cancellation requested. Waiting for the active process to stop.'); return this.state;
  }
  async exportTo(parent: string): Promise<string> {
    this.idle(); if (!this.state.scenario) throw new Error('Record a scenario before exporting.');
    if (this.state.generation) await verifyGeneratedBytes(this.state.generation.workspace,this.state.generation.files);
    const folder = path.join(parent, `journeyproof-${Date.now()}`); await mkdir(folder, { recursive: true, mode: 0o700 });
    const scenario = structuredClone(this.state.scenario);
    for (const event of scenario.events) {
      if (event.screenshot) {
        const relative = `screenshots/${event.id}.png`; await mkdir(path.join(folder, 'screenshots'), { recursive: true });
        try { await copyFile(event.screenshot, path.join(folder, relative)); event.screenshot = relative; } catch { delete event.screenshot; }
      }
    }
    await writeFile(path.join(folder, 'scenario.json'), JSON.stringify(scenario, null, 2));
    if (this.state.generation) {
      await writeFile(path.join(folder, 'generated.patch'), this.state.generation.patch);
      for (const file of this.state.generation.files) { const target = path.join(folder, 'tests', file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.content); }
    }
    if (this.state.verification) await writeFile(path.join(folder, 'verification.json'), JSON.stringify(this.state.verification, null, 2));
    await writeFile(path.join(folder, 'README.md'), '# JourneyProof evidence bundle\n\nReview scenario.json and generated.patch before applying to your project. Generated files are also in tests/. Verification records the selected command and actual output; a zero exit code is not proof of complete requirement coverage. Screenshots are included only if enabled during recording and may contain visible data.\n');
    this.log('Exported the scenario, generated tests, and available execution evidence.'); return folder;
  }
  reportError(error: unknown): void { this.state.error = error instanceof Error ? error.message : String(error); this.log(this.state.error); }
  async close(): Promise<void> { this.controller?.abort(); await this.recorder?.stop().catch(() => {}); await this.stopDemo(); await this.operationDone; await this.persistQueue; }
}
