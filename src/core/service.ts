import { EventEmitter } from 'node:events';
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  cp,
  rename,
  stat,
  lstat,
  realpath,
} from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AppState,
  Assertion,
  Scenario,
  TestCommand,
  TestCase,
  CaseKind,
  AgentSettings,
  AgentProvider,
  GeneratedFile,
  RunRecord,
  AgentSessionRecord,
} from '../shared/types';
import { BrowserRecorder } from './recorder';
import { demoCases } from './demo';
import {
  inspectProject,
  snapshotProject,
  writeGeneratedFiles,
  verifyGeneratedBytes,
  excluded,
  scrubText,
} from './repository';
import { portableGenerate, validateScenario } from './generator';
import {
  DEFAULT_AGENT_SETTINGS,
  validateAgentSettings,
  detectAgents,
  generateWithAgent,
  agentPrompt,
} from './agents';
import { createCase, cloneCase, validateCase, validateSuite, serializeSuite } from './suite';
import { verifyWorkspace } from './verifier';
import { executablePath } from './process';

export class JourneyService extends EventEmitter {
  state: AppState;
  private recorder?: BrowserRecorder;
  private recordingStop?: Promise<AppState>;
  private closing = false;
  private controller?: AbortController;
  private demoProcess?: ChildProcess;
  private persistQueue = Promise.resolve();
  private operationDone?: Promise<void>;
  private finishOperation?: () => void;
  constructor(
    readonly root: string,
    readonly exampleRoot: string,
  ) {
    super();
    this.state = {
      phase: 'idle',
      activity: [],
      codex: { available: false },
      claude: { available: false },
      cases: [],
      settings: structuredClone(DEFAULT_AGENT_SETTINGS),
      history: [],
      agentSessions: [],
      workspaceRoot: root,
    };
  }
  async initialize(): Promise<AppState> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const fresh = structuredClone(this.state);
    try {
      const saved = JSON.parse(await readFile(path.join(this.root, 'session.json'), 'utf8'));
      if (saved.workspaceRoot !== this.root) {
        const [savedFolder, currentFolder] = await Promise.all([
          stat(saved.workspaceRoot).catch(() => undefined),
          stat(this.root),
        ]);
        if (
          !savedFolder ||
          savedFolder.dev !== currentFolder.dev ||
          savedFolder.ino !== currentFolder.ino
        )
          throw new Error('Saved workspace location does not match.');
      }
      const restored: AppState = {
        ...fresh,
        ...saved,
        workspaceRoot: this.root,
        phase: 'idle',
        error: undefined,
      };
      restored.settings = validateAgentSettings(restored.settings);
      if (restored.project?.outputDir === 'tests/journeyproof')
        restored.project.outputDir = 'tests/testloom';
      if (restored.project?.outputDir === 'src/test/java/journeyproof')
        restored.project.outputDir = 'src/test/java/testloom';
      restored.cases = (restored.cases || []).map(validateCase);
      restored.history = Array.isArray(restored.history) ? restored.history.slice(0, 100) : [];
      restored.agentSessions = this.restoreAgentSessions(restored.agentSessions, restored.cases);
      if (
        saved.phase === 'recording' &&
        !restored.activeCaseId &&
        restored.scenario?.events.length
      ) {
        const raw = structuredClone(restored.scenario);
        raw.warnings.push(
          'This recording was interrupted before stopping. Review its completeness or record it again.',
        );
        const recovered = createCase(raw);
        const folder = path.join(this.root, 'recordings', raw.id);
        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'recording.json'), JSON.stringify(raw, null, 2), {
          mode: 0o600,
        });
        if (restored.cases.length < 500) {
          restored.cases.push(recovered);
          restored.activeCaseId = recovered.id;
          restored.scenario = recovered.scenario;
        }
        restored.generation = undefined;
        restored.verification = undefined;
      } else if (!restored.cases.length && restored.scenario?.events.length) {
        const migrated = createCase(restored.scenario);
        restored.cases = [migrated];
        restored.activeCaseId = migrated.id;
        restored.scenario = migrated.scenario;
        restored.generation = undefined;
        restored.verification = undefined;
      } else if (restored.activeCaseId)
        restored.scenario = restored.cases.find((c) => c.id === restored.activeCaseId)?.scenario;
      if (saved.phase !== 'idle') {
        restored.verification = undefined;
        restored.error =
          'The previous session was interrupted. Verify again before using its results.';
      }
      this.state = restored;
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        const recovery = path.join(this.root, `session-recovery-${Date.now()}.json`);
        await copyFile(path.join(this.root, 'session.json'), recovery);
        this.state = fresh;
        this.state.error =
          'The saved session could not be loaded. A recovery copy is retained in the workspace. Reopen your project to restore its case library.';
      }
    }
    Object.assign(this.state, await detectAgents());
    this.log('Ready. Open a project folder or try the cart demo.');
    return this.state;
  }
  private projectSessionPath(folder: string): string {
    return path.join(
      this.root,
      'libraries',
      createHash('sha256').update(folder).digest('hex') + '.json',
    );
  }
  private restoreAgentSessions(value: unknown, cases: TestCase[]): AgentSessionRecord[] {
    if (!Array.isArray(value)) return [];
    const allowed = new Set(cases.map((c) => c.id));
    const seen = new Set<string>();
    return value
      .slice(0, 1000)
      .filter((s) => {
        if (
          !s ||
          !allowed.has(s.caseId) ||
          !['codex', 'claude'].includes(s.provider) ||
          typeof s.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,160}$/.test(s.id) ||
          typeof s.cwd !== 'string' ||
          !path
            .resolve(s.cwd)
            .startsWith(path.join(path.resolve(this.root), 'agent-sessions') + path.sep) ||
          !Number.isInteger(s.turns) ||
          s.turns < 0
        )
          return false;
        const key = s.caseId + ':' + s.provider;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((s) => ({
        ...s,
        status: s.status === 'running' ? 'failed' : s.status,
        ...(s.status === 'running'
          ? { lastError: 'The previous turn was interrupted. Resume or start a fresh session.' }
          : {}),
      }));
  }
  private contextKey(settings: AgentSettings): string {
    return createHash('sha256')
      .update(JSON.stringify([...settings.excludedContextPaths].sort()))
      .digest('hex');
  }
  private async caseSession(
    caseId: string,
    settings: AgentSettings,
  ): Promise<{ id?: string; cwd: string }> {
    const projectKey = createHash('sha256').update(this.state.project!.path).digest('hex');
    const base = path.join(this.root, 'agent-sessions', projectKey, caseId, settings.provider);
    let previous = this.state.agentSessions?.find(
      (s) => s.caseId === caseId && s.provider === settings.provider,
    );
    if (
      previous &&
      (previous.contextKey !== this.contextKey(settings) ||
        !path.resolve(previous.cwd).startsWith(path.resolve(base) + path.sep))
    ) {
      this.state.agentSessions = this.state.agentSessions?.filter((s) => s !== previous);
      previous = undefined;
      this.log(
        'Starting a fresh session because context exclusions changed. Prior history remains in the agent’s own storage.',
      );
    }
    const cwd = previous?.cwd ?? path.join(base, randomUUID());
    const relative = path.relative(this.root, cwd);
    let current = this.root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('Session storage is not a regular directory.');
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
    return { ...(previous ? { id: previous.id } : {}), cwd };
  }
  async resetAgentSession(input: {
    caseId: string;
    provider: 'codex' | 'claude';
  }): Promise<AppState> {
    this.idle();
    if (
      !this.state.cases.some((c) => c.id === input?.caseId) ||
      !['codex', 'claude'].includes(input?.provider)
    )
      throw new Error('Choose a case and coding agent first.');
    this.state.agentSessions = this.state.agentSessions?.filter(
      (s) => s.caseId !== input.caseId || s.provider !== input.provider,
    );
    this.log(
      'The next generation will start a fresh case session. Previous agent history is retained locally.',
    );
    return this.state;
  }
  private async caseEvidenceImages(testCase: TestCase) {
    const images: { path: string; mimeType: 'image/png' | 'image/jpeg'; label: string }[] = [];
    const events = testCase.scenario.events.filter((e) => e.screenshot);
    if (!events.length) return images;
    if (events.length > 100)
      throw new Error(
        'This case has more than 100 screenshots. Split it into smaller cases before sending all its evidence.',
      );
    const base = await realpath(path.join(this.root, 'recordings', testCase.recordingId));
    let bytes = 0;
    for (const event of events) {
      const file = event.screenshot!;
      const actual = await realpath(file);
      const info = await lstat(file);
      if (
        !actual.startsWith(base + path.sep) ||
        info.isSymbolicLink() ||
        !info.isFile() ||
        !/\.(png|jpe?g)$/i.test(actual)
      )
        throw new Error(
          'A recorded screenshot is unavailable or outside its recording. Record the case again before sending it.',
        );
      bytes += info.size;
      if (info.size > 10_000_000 || bytes > 50_000_000)
        throw new Error(
          'Screenshot evidence exceeds the 50 MB case upload limit. Split the recording into smaller cases; no screenshots have been silently omitted.',
        );
      images.push({
        path: actual,
        mimeType: /\.png$/i.test(actual) ? 'image/png' : 'image/jpeg',
        label: `Recorded event ${event.sequence}: ${event.action}. ${scrubText(event.label)}`,
      });
    }
    return images;
  }
  private emitState(): void {
    this.emit('update', structuredClone(this.state));
    const snapshot = JSON.stringify(this.state, null, 2);
    const projectFile = this.state.project
      ? this.projectSessionPath(this.state.project.path)
      : undefined;
    this.persistQueue = this.persistQueue
      .then(async () => {
        const session = path.join(this.root, 'session.json');
        await writeFile(session + '.tmp', snapshot, { mode: 0o600 });
        await rename(session + '.tmp', session);
        if (projectFile) {
          await mkdir(path.dirname(projectFile), { recursive: true });
          await writeFile(projectFile + '.tmp', snapshot, { mode: 0o600 });
          await rename(projectFile + '.tmp', projectFile);
        }
      })
      .catch(() => {
        this.state.error =
          'Changes could not be saved. Check available disk space and export your suite before closing.';
        this.emit('update', structuredClone(this.state));
      });
  }
  private invalidate(): void {
    this.state.generation = undefined;
    this.state.verification = undefined;
    this.state.error = undefined;
  }
  log(message: string): void {
    this.state.activity.push({ time: new Date().toISOString(), message });
    this.state.activity = this.state.activity.slice(-80);
    this.emitState();
  }
  private idle(): void {
    if (this.closing) throw new Error('The application is closing.');
    if (this.state.phase !== 'idle' || this.operationDone)
      throw new Error('Finish or cancel the current operation first.');
  }
  private beginOperation(): void {
    this.operationDone = new Promise((resolve) => {
      this.finishOperation = resolve;
    });
  }
  private endOperation(): void {
    this.finishOperation?.();
    this.operationDone = undefined;
    this.finishOperation = undefined;
  }
  async connect(folder: string): Promise<AppState> {
    this.idle();
    this.state.phase = 'indexing';
    this.controller = new AbortController();
    this.beginOperation();
    this.log('Inspecting the project folder. Source files remain unchanged.');
    try {
      await this.stopDemo();
      const project = await inspectProject(folder, {
        signal: this.controller.signal,
        onProgress: (progress) =>
          this.log(`Indexed ${progress.fileCount.toLocaleString()} source files.`),
      });
      await this.persistQueue;
      let library: Partial<AppState> = {};
      try {
        const saved = JSON.parse(await readFile(this.projectSessionPath(project.path), 'utf8'));
        if (saved.project?.path === project.path) {
          library = {
            cases: saved.cases.map(validateCase),
            activeCaseId: saved.activeCaseId,
            scenario: saved.scenario,
            history: saved.history || [],
            agentSessions: this.restoreAgentSessions(
              saved.agentSessions,
              saved.cases.map(validateCase),
            ),
          };
          if (
            saved.project.isDemo &&
            project.path.startsWith(path.join(this.root, 'samples') + path.sep) &&
            Number.isInteger(saved.project.demoPort) &&
            saved.project.demoPort > 0 &&
            saved.project.demoPort < 65536
          ) {
            project.isDemo = true;
            project.demoPort = saved.project.demoPort;
          }
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT')
          throw new Error(
            'The saved case library could not be opened. Its file has been preserved in the workspace libraries folder.',
          );
      }
      this.controller.signal.throwIfAborted();
      this.state = {
        ...this.state,
        project,
        cases: [],
        activeCaseId: undefined,
        history: [],
        agentSessions: [],
        scenario: undefined,
        generation: undefined,
        verification: undefined,
        error: undefined,
        ...library,
      };
      this.log(`Connected ${project.name}. ${project.summary}.`);
      return this.state;
    } finally {
      this.state.phase = 'idle';
      this.controller = undefined;
      this.emitState();
      this.endOperation();
    }
  }
  async loadDemo(): Promise<AppState> {
    this.idle();
    await this.stopDemo();
    const demo = path.join(this.root, 'samples', `cart-${Date.now()}`);
    await mkdir(path.dirname(demo), { recursive: true });
    await cp(this.exampleRoot, demo, {
      recursive: true,
      filter: (source) =>
        !source.split(path.sep).includes('node_modules') &&
        !source.split(path.sep).includes('test-results'),
    });
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') {
          probe.close();
          reject(new Error('Could not reserve a demo port.'));
          return;
        }
        const port = address.port;
        probe.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
    const config = path.join(demo, 'playwright.config.ts');
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace(
        "process.env.PORT ?? '4318'",
        `process.env.PORT ?? '${port}'`,
      ),
    );
    await this.connect(demo);
    this.state.project!.isDemo = true;
    this.state.project!.demoPort = port;
    this.state.project!.name = 'Cart example';
    this.state.cases = demoCases(port);
    this.state.activeCaseId = this.state.cases[0].id;
    this.state.scenario = this.state.cases[0].scenario;
    await this.startDemo();
    this.log(
      'Three hand-authored sample cases are ready: valid, invalid, and empty coupons. Generate them together, or record your own journey.',
    );
    return this.state;
  }

  private async startDemo(): Promise<void> {
    if (this.closing) throw new Error('The application is closing.');
    if (this.demoProcess && this.demoProcess.exitCode === null) return;
    const node = await executablePath('node');
    if (this.closing) throw new Error('The application is closing.');
    if (!node) throw new Error('Install Node.js 20.19 or newer to run the sample.');
    const port = this.state.project!.demoPort || 4318;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(node, ['server.mjs'], {
      cwd: this.state.project!.path,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    this.demoProcess = child;
    let output = '';
    let spawnError = '';
    child.stderr?.on('data', (data) => {
      output = (output + data).slice(-2000);
    });
    child.on('error', (err) => {
      spawnError = err.message;
    });
    for (let i = 0; i < 60; i++) {
      if (spawnError || child.exitCode !== null)
        throw new Error(
          `The demo could not start. Port ${port} may be in use. ${spawnError || output}`,
        );
      try {
        const r = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(300) });
        if (r.ok) {
          await new Promise((r) => setTimeout(r, 150));
          if (child.exitCode !== null) throw new Error(output);
          return;
        }
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stopDemo();
    throw new Error('The cart demo did not become ready within six seconds.');
  }
  async stopDemo(): Promise<void> {
    const child = this.demoProcess;
    this.demoProcess = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        resolve();
      }
      setTimeout(resolve, 2000).unref();
    });
  }
  async startRecording(input: {
    url: string;
    name: string;
    captureScreenshots: boolean;
  }): Promise<AppState> {
    this.idle();
    if (!this.state.project) throw new Error('Open a project folder first.');
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error('Enter a full http:// or https:// URL.');
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    if (url.search || url.hash)
      throw new Error(
        'Start from a URL without a query or fragment. Navigate to the desired page while recording; sensitive URL parameters are removed from evidence.',
      );
    if (this.state.cases.length >= 500)
      throw new Error(
        'This library has 500 cases. Export a suite and remove unused cases before recording.',
      );
    if (typeof input.name !== 'string') throw new Error('Enter a case name.');
    const previousId = this.state.activeCaseId;
    const scenario: Scenario = {
      schemaVersion: 1,
      id: randomUUID(),
      name: input.name.trim().slice(0, 120) || 'Recorded journey',
      startUrl: url.toString(),
      createdAt: new Date().toISOString(),
      events: [],
      assertions: [],
      warnings: [],
      network: [],
    };
    const controller = new AbortController();
    this.controller = controller;
    this.recordingStop = undefined;
    this.beginOperation();
    this.state = {
      ...this.state,
      scenario,
      activeCaseId: undefined,
      generation: undefined,
      verification: undefined,
      error: undefined,
      phase: 'recording',
    };
    const checkCancelled = () => {
      if (controller.signal.aborted) throw new Error('Recording cancelled.');
    };
    try {
      if (this.state.project!.isDemo) await this.startDemo();
      checkCancelled();
      const artifactDir = path.join(this.root, 'recordings', scenario.id);
      await mkdir(artifactDir, { recursive: true });
      checkCancelled();
      const recorder = new BrowserRecorder({
        artifactDir,
        onEvent: (event) => {
          scenario.events.push(event);
          this.emitState();
        },
        onWarning: (warning) => {
          if (!scenario.warnings.includes(warning)) scenario.warnings.push(warning);
          this.emitState();
        },
      });
      this.recorder = recorder;
      await recorder.start(url.toString(), {
        captureScreenshots: Boolean(input.captureScreenshots),
      });
      checkCancelled();
      this.log('Recording in a fresh browser. Complete the journey, then return here and stop.');
    } catch (error) {
      if (this.recorder) {
        if (!controller.signal.aborted)
          scenario.warnings.push(
            'Browser startup did not finish. This recording may be incomplete; review it before generating.',
          );
        await this.stopRecording().catch(() => {});
      }
      this.state.phase = 'idle';
      if (!scenario.events.length && !this.state.activeCaseId) {
        this.state.activeCaseId = previousId;
        this.state.scenario = this.state.cases.find((c) => c.id === previousId)?.scenario;
      }
      throw error;
    } finally {
      if (this.state.phase === 'idle') this.controller = undefined;
      this.emitState();
      this.endOperation();
    }
    return this.state;
  }
  async stopRecording(): Promise<AppState> {
    if (this.recordingStop) return this.recordingStop;
    if (!this.recorder) {
      if (this.state.phase === 'recording') {
        this.controller?.abort();
        await this.operationDone;
        return this.state;
      }
      throw new Error('There is no active recording.');
    }
    const recorder = this.recorder;
    const scenario = this.state.scenario!;
    this.recordingStop = (async () => {
      try {
        const result = await recorder.stop();
        const warnings = [...new Set([...scenario.warnings, ...result.warnings])];
        Object.assign(scenario, result, { warnings });
        const recording = structuredClone(scenario);
        await writeFile(
          path.join(this.root, 'recordings', recording.id, 'recording.json'),
          JSON.stringify(recording, null, 2),
          { mode: 0o600 },
        );
        if (result.events.length) {
          const testCase = createCase(recording);
          this.state.cases.push(testCase);
          this.state.activeCaseId = testCase.id;
          this.state.scenario = testCase.scenario;
        }
        this.log(
          `Recorded ${result.events.length} events. Review the expected results before generating.`,
        );
      } finally {
        this.recorder = undefined;
        this.controller = undefined;
        this.state.phase = 'idle';
        this.emitState();
      }
      return this.state;
    })();
    return this.recordingStop;
  }
  async saveScenario(input: { name: string; assertions: Assertion[] }): Promise<AppState> {
    this.idle();
    if (!this.state.scenario) throw new Error('Record a scenario first.');
    if (
      typeof input.name !== 'string' ||
      input.name.length > 120 ||
      !Array.isArray(input.assertions) ||
      input.assertions.length > 30 ||
      JSON.stringify(input).length > 50_000
    )
      throw new Error('Invalid scenario details.');
    const next = {
      ...this.state.scenario,
      name: input.name.trim() || 'Recorded journey',
      assertions: input.assertions,
    };
    validateScenario(next);
    if (JSON.stringify(next) !== JSON.stringify(this.state.scenario)) {
      this.state.generation = undefined;
      this.state.verification = undefined;
    }
    this.state.scenario = next;
    const active = this.state.cases.find((c) => c.id === this.state.activeCaseId);
    if (active) {
      active.name = next.name;
      active.scenario = next;
      active.updatedAt = new Date().toISOString();
    }
    this.log('Expected results saved.');
    return this.state;
  }
  async saveCase(input: TestCase): Promise<AppState> {
    this.idle();
    if (!this.state.project) throw new Error('Open a project first.');
    const next = validateCase(input);
    const index = this.state.cases.findIndex((c) => c.id === next.id);
    if (index < 0) throw new Error('This case is no longer in the library.');
    // A case may edit its actions; the original recording stays in recordings/.
    const previous = this.state.cases[index];
    if (next.recordingId !== previous.recordingId || next.scenario.id !== previous.scenario.id)
      throw new Error('Case identity cannot be changed. Duplicate the case to create a variant.');
    for (const event of next.scenario.events) {
      const original = previous.scenario.events.find((e) => e.id === event.id);
      if (original?.screenshot) event.screenshot = original.screenshot;
      else delete event.screenshot;
    }
    next.scenario.name = next.name;
    const comparable = (c: TestCase) => JSON.stringify({ ...c, updatedAt: '' });
    if (comparable(next) !== comparable(previous)) {
      next.updatedAt = new Date().toISOString();
      this.invalidate();
      this.state.cases[index] = next;
    }
    this.state.activeCaseId = next.id;
    this.state.scenario = this.state.cases[index].scenario;
    this.log('Case saved.');
    return this.state;
  }
  async duplicateCase(input: { id: string; kind: CaseKind }): Promise<AppState> {
    this.idle();
    const source = this.state.cases.find((c) => c.id === input.id);
    if (!source) throw new Error('Choose a case to duplicate.');
    if (this.state.cases.length >= 500) throw new Error('A library supports up to 500 cases.');
    const next = validateCase(cloneCase(source, input.kind));
    this.state.cases.push(next);
    this.state.activeCaseId = next.id;
    this.state.scenario = next.scenario;
    this.log('Variant created. Edit its inputs and expected results to define the new behavior.');
    return this.state;
  }
  async selectCase(input: { id: string }): Promise<AppState> {
    this.idle();
    const selected = this.state.cases.find((c) => c.id === input.id);
    if (!selected) throw new Error('Case not found.');
    this.state.activeCaseId = selected.id;
    this.state.scenario = selected.scenario;
    this.state.error = undefined;
    this.emitState();
    return this.state;
  }
  async deleteCase(input: { id: string }): Promise<AppState> {
    this.idle();
    if (!this.state.cases.some((c) => c.id === input.id)) throw new Error('Case not found.');
    this.state.cases = this.state.cases.filter((c) => c.id !== input.id);
    this.state.agentSessions = this.state.agentSessions?.filter((s) => s.caseId !== input.id);
    if (this.state.generation?.caseIds?.includes(input.id)) this.invalidate();
    if (this.state.activeCaseId === input.id) {
      this.state.activeCaseId = this.state.cases[0]?.id;
      this.state.scenario = this.state.cases[0]?.scenario;
    }
    this.log('Case removed from the library. Original recording retained.');
    return this.state;
  }
  async saveSettings(input: AgentSettings): Promise<AppState> {
    this.idle();
    this.state.settings = validateAgentSettings(input);
    this.state.error = undefined;
    this.log('Agent preferences saved.');
    return this.state;
  }
  async addContextFiles(files: string[]): Promise<AppState> {
    this.idle();
    if (!this.state.project) throw new Error('Open a project first.');
    if (!Array.isArray(files) || files.length > 30)
      throw new Error('Choose at most 30 context files.');
    const root = await realpath(this.state.project.path);
    const extra: { path: string; content: string }[] = [];
    for (const file of files) {
      const actual = await realpath(file);
      const relative = path.relative(root, actual);
      if (
        !actual.startsWith(root + path.sep) ||
        relative.split(path.sep).some(excluded) ||
        !/\.(?:[cm]?[jt]sx?|java|json|xml|gradle|kts|md|yml|yaml|properties)$/.test(relative)
      )
        throw new Error(
          'Context must be a source, test, or configuration file inside this project. Credential files are excluded.',
        );
      if ((await stat(actual)).size > 500_000)
        throw new Error(
          'Choose context files smaller than 500 KB. Only the first 10,000 characters are supplied.',
        );
      extra.push({
        path: relative,
        content: scrubText((await readFile(actual, 'utf8')).slice(0, 10_000)),
      });
    }
    const examples = new Map(this.state.project.examples.map((e) => [e.path, e]));
    extra.forEach((e) => examples.set(e.path, e));
    if (examples.size > 30)
      throw new Error(
        'Up to 30 context files are supported. Connect a smaller test module for more focused context.',
      );
    this.state.project.examples = [...examples.values()];
    this.log(
      `Added ${extra.length} project context files. Review their contents in the prompt preview.`,
    );
    return this.state;
  }
  async refreshAgents(): Promise<AppState> {
    this.idle();
    Object.assign(this.state, await detectAgents());
    this.log('Agent availability refreshed.');
    return this.state;
  }
  async previewPrompt(input: { caseId?: string }): Promise<string> {
    this.idle();
    const selected = this.state.cases.find(
      (c) => c.id === (input?.caseId || this.state.activeCaseId),
    );
    if (!this.state.project || !selected)
      throw new Error('Select a case to preview its agent context.');
    return agentPrompt(this.caseProject(selected), selected.scenario, this.state.settings);
  }
  private caseProject(testCase: TestCase) {
    return {
      ...this.state.project!,
      outputDir: this.state.project!.outputDir + '/case-' + testCase.id,
    };
  }
  async importSuiteFrom(file: string): Promise<AppState> {
    this.idle();
    if (!this.state.project) throw new Error('Open a project before importing cases.');
    if ((await stat(file)).size > 5_000_000)
      throw new Error('Suite files must be smaller than 5 MB.');
    const imported = validateSuite(JSON.parse(await readFile(file, 'utf8')));
    if (this.state.cases.length + imported.length > 500)
      throw new Error('Import would exceed the 500-case library limit.');
    const existing = new Set(this.state.cases.map((c) => c.id));
    const cases = imported.map((c) => (existing.has(c.id) ? cloneCase(c, c.kind) : c));
    this.state.cases.push(...cases);
    if (cases[0]) {
      this.state.activeCaseId = cases[0].id;
      this.state.scenario = cases[0].scenario;
    }
    this.log(
      `Imported ${cases.length} editable cases. Review URLs and expectations before execution.`,
    );
    return this.state;
  }
  async exportSuiteTo(file: string): Promise<string> {
    this.idle();
    if (!this.state.cases.length) throw new Error('Add a case before exporting the suite.');
    await writeFile(file, JSON.stringify(serializeSuite(this.state.cases), null, 2), {
      mode: 0o600,
    });
    this.log('Suite exported as portable, editable JSON.');
    return file;
  }
  async generate(input: {
    mode: AgentProvider;
    model?: string;
    caseIds?: string[];
  }): Promise<AppState> {
    this.idle();
    if (!this.state.project || !this.state.scenario)
      throw new Error('Connect a project and record a case first.');
    const settings = validateAgentSettings({
      ...this.state.settings,
      provider: input.mode,
      model: input.model ?? this.state.settings.model,
    });
    if (!this.state.cases.length) {
      const c = createCase(this.state.scenario);
      this.state.cases.push(c);
      this.state.activeCaseId = c.id;
      this.state.scenario = c.scenario;
    }
    const ids = input.caseIds ?? [this.state.activeCaseId!];
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length)
      throw new Error('Select between 1 and 20 distinct cases per generation batch.');
    const cases = ids.map((id) => {
      const c = this.state.cases.find((c) => c.id === id);
      if (!c || !c.enabled) throw new Error('Selected case is missing or disabled.');
      validateScenario(c.scenario);
      return structuredClone(c);
    });
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const workspace = path.join(this.root, 'runs', id, 'project');
    const record: RunRecord = {
      id,
      createdAt: new Date().toISOString(),
      provider: settings.provider,
      caseIds: ids,
      caseNames: cases.map((c) => c.name),
      status: 'generation-failed',
      workspace,
      summary: '',
      fileCount: 0,
    };
    this.state.phase = 'generating';
    this.invalidate();
    this.controller = new AbortController();
    this.beginOperation();
    this.log(
      `Preparing ${cases.length} case${cases.length === 1 ? '' : 's'} in an isolated source copy.`,
    );
    try {
      await snapshotProject(this.state.project, workspace, {
        signal: this.controller.signal,
        onProgress: (progress) =>
          this.log(
            progress.phase === 'scan'
              ? `Scanning repository: ${progress.fileCount.toLocaleString()} source files.`
              : `Preparing isolated copy: ${progress.fileCount.toLocaleString()} of ${progress.totalFiles?.toLocaleString() ?? '?'} files.`,
          ),
      });
      const files: GeneratedFile[] = [];
      const warnings: string[] = [];
      const caseFiles: Record<string, string[]> = {};
      await writeFile(
        path.join(workspace, '.journeyproof/suite.json'),
        JSON.stringify(serializeSuite(cases), null, 2),
      );
      for (const [index, testCase] of cases.entries()) {
        if (this.controller.signal.aborted) throw new Error('Generation cancelled.');
        this.log(`Authoring ${index + 1} of ${cases.length}: ${testCase.name} (${testCase.kind}).`);
        const project = this.caseProject(testCase);
        const evidenceImages =
          settings.provider === 'portable' ? [] : await this.caseEvidenceImages(testCase);
        const session =
          settings.provider === 'portable'
            ? undefined
            : await this.caseSession(testCase.id, settings);
        let sessionRecord: AgentSessionRecord | undefined;
        const result =
          settings.provider === 'portable'
            ? portableGenerate(project, testCase.scenario)
            : await generateWithAgent(project, testCase.scenario, workspace, settings, {
                signal: this.controller.signal,
                session,
                evidenceImages,
                onSession: (nativeId) => {
                  const now = new Date().toISOString();
                  sessionRecord = this.state.agentSessions?.find(
                    (s) => s.caseId === testCase.id && s.provider === settings.provider,
                  );
                  if (sessionRecord && sessionRecord.id !== nativeId)
                    throw new Error('Agent returned a different case session.');
                  if (!sessionRecord) {
                    sessionRecord = {
                      caseId: testCase.id,
                      provider: settings.provider as 'codex' | 'claude',
                      id: nativeId,
                      cwd: session!.cwd,
                      createdAt: now,
                      updatedAt: now,
                      turns: 0,
                      status: 'running',
                      contextKey: this.contextKey(settings),
                    };
                    (this.state.agentSessions ??= []).push(sessionRecord);
                  }
                  Object.assign(sessionRecord, {
                    updatedAt: now,
                    status: 'running',
                    lastError: undefined,
                  });
                  this.emitState();
                },
                onProgress: (message) => this.log(message),
              });
        if (sessionRecord) {
          sessionRecord.turns++;
          sessionRecord.status = 'ready';
          sessionRecord.updatedAt = new Date().toISOString();
          await writeFile(
            path.join(sessionRecord.cwd, 'case-memory.json'),
            JSON.stringify(
              {
                caseId: testCase.id,
                provider: sessionRecord.provider,
                sessionId: sessionRecord.id,
                latestRequirements: testCase.scenario.assertions,
                summary: result.summary,
                generatedFiles: result.files.map((f) => f.path),
                verification: 'Not run for this generation',
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          this.emitState();
        }
        files.push(...result.files);
        caseFiles[testCase.id] = result.files.map((f) => f.path);
        warnings.push(...result.warnings);
      }
      if (this.controller.signal.aborted) throw new Error('Generation cancelled.');
      const patch = await writeGeneratedFiles(workspace, files, this.state.project.outputDir);
      const summary = `${cases.length} ${cases.length === 1 ? 'case' : 'cases'} authored with ${settings.provider === 'codex' ? 'Codex' : settings.provider === 'claude' ? 'Claude' : 'portable generation'}.`;
      this.state.generation = {
        provider: settings.provider,
        summary,
        files,
        warnings: [...new Set(warnings)],
        workspace,
        patch,
        generatedAt: new Date().toISOString(),
        caseIds: ids,
        caseFiles,
        settings,
      };
      await writeFile(
        path.join(workspace, '.journeyproof/generation.json'),
        JSON.stringify(this.state.generation, null, 2),
        { mode: 0o600 },
      );
      if (this.state.project.framework === 'playwright-ts') {
        const tests = files
          .filter((f) => /\.(?:spec|test)\.[jt]s$/.test(f.path))
          .map((f) => f.path);
        if (tests.length)
          this.state.project.commands = [
            {
              executable: 'npx',
              args: [
                '--no-install',
                'playwright',
                'test',
                ...tests,
                '--reporter=list,json',
                '--retries=0',
              ],
              label: 'Generated tests · confirm discovery',
            },
            ...this.state.project.commands.filter(
              (c) => c.label !== 'Generated tests · confirm discovery',
            ),
          ];
      }
      Object.assign(record, { status: 'generated', summary, fileCount: files.length });
      this.log(`${summary} Review the code, then verify.`);
    } catch (error) {
      record.summary = error instanceof Error ? error.message : String(error);
      for (const session of this.state.agentSessions ?? []) {
        if (
          session.status === 'running' &&
          ids.includes(session.caseId) &&
          session.provider === settings.provider
        ) {
          session.status = 'failed';
          session.lastError = record.summary;
          session.updatedAt = new Date().toISOString();
        }
      }
      throw error;
    } finally {
      this.state.history = [record, ...this.state.history].slice(0, 100);
      this.state.phase = 'idle';
      this.controller = undefined;
      this.emitState();
      this.endOperation();
    }
    return this.state;
  }
  async verify(input: { command: TestCommand; repeats: number }): Promise<AppState> {
    this.idle();
    if (!this.state.generation) throw new Error('Generate tests before verifying.');
    this.state.phase = 'verifying';
    this.state.error = undefined;
    this.state.verification = undefined;
    this.controller = new AbortController();
    this.beginOperation();
    this.log('Preparing verification in the isolated copy.');
    try {
      await this.stopDemo();
      const generation = this.state.generation;
      const fileHashes = await verifyGeneratedBytes(generation.workspace, generation.files);
      const expectedFiles =
        this.state.project?.framework === 'playwright-ts' &&
        input.command.args.includes('--reporter=list,json')
          ? generation.files
              .filter((f) => /\.(?:spec|test)\.[jt]s$/.test(f.path))
              .map((f) => f.path)
          : undefined;
      const verification = await verifyWorkspace(
        generation.workspace,
        input.command,
        input.repeats,
        {
          prepareDemo: this.state.project?.isDemo,
          signal: this.controller.signal,
          onProgress: (message) => this.log(message),
          expectedPlaywrightFiles: expectedFiles,
        },
      );
      await verifyGeneratedBytes(generation.workspace, generation.files);
      this.state.verification = { ...verification, fileHashes };
      const record = this.state.history.find((r) => r.workspace === generation.workspace);
      if (record) {
        record.status = verification.status;
        record.summary = verification.statement;
      }
      await writeFile(
        path.join(generation.workspace, '.journeyproof/verification.json'),
        JSON.stringify(this.state.verification, null, 2),
      );
      this.log(this.state.verification.statement);
    } finally {
      this.state.phase = 'idle';
      this.controller = undefined;
      this.emitState();
      this.endOperation();
    }
    return this.state;
  }
  async cancel(): Promise<AppState> {
    this.controller?.abort();
    if (this.recorder) await this.stopRecording();
    this.log('Cancellation requested. Waiting for the active process to stop.');
    return this.state;
  }
  async exportTo(parent: string): Promise<string> {
    this.idle();
    if (!this.state.scenario) throw new Error('Record a scenario before exporting.');
    if (this.state.generation)
      await verifyGeneratedBytes(this.state.generation.workspace, this.state.generation.files);
    const folder = path.join(parent, `testloom-${Date.now()}`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const scenario = structuredClone(this.state.scenario);
    for (const event of scenario.events) {
      if (event.screenshot) {
        const screenshot = await realpath(event.screenshot).catch(() => '');
        const recordingRoot = await realpath(path.join(this.root, 'recordings')).catch(() => '');
        if (
          !recordingRoot ||
          !screenshot.startsWith(recordingRoot + path.sep) ||
          !/^[a-zA-Z0-9_-]+$/.test(event.id)
        ) {
          delete event.screenshot;
          continue;
        }
        const relative = `screenshots/${event.id}.png`;
        await mkdir(path.join(folder, 'screenshots'), { recursive: true });
        try {
          await copyFile(event.screenshot, path.join(folder, relative));
          event.screenshot = relative;
        } catch {
          delete event.screenshot;
        }
      }
    }
    await writeFile(path.join(folder, 'scenario.json'), JSON.stringify(scenario, null, 2));
    await writeFile(
      path.join(folder, 'suite.json'),
      JSON.stringify(serializeSuite(this.state.cases), null, 2),
    );
    if (this.state.generation) {
      await writeFile(path.join(folder, 'generated.patch'), this.state.generation.patch);
      await copyFile(
        path.join(this.state.generation.workspace, '.journeyproof/suite.json'),
        path.join(folder, 'generated-suite.json'),
      ).catch(() => {});
      await writeFile(
        path.join(folder, 'generation.json'),
        JSON.stringify(
          { ...this.state.generation, workspace: undefined, patch: undefined, files: undefined },
          null,
          2,
        ),
      );
      for (const file of this.state.generation.files) {
        const target = path.join(folder, 'tests', file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    }
    if (this.state.verification)
      await writeFile(
        path.join(folder, 'verification.json'),
        JSON.stringify(this.state.verification, null, 2),
      );
    await writeFile(
      path.join(folder, 'README.md'),
      '# Testloom evidence bundle\n\nReview suite.json (editable library), generated-suite.json (the cases used in this batch), and generated.patch before applying to your project. Generated files are also in tests/. Verification records the selected command and actual output; a zero exit code is not proof of complete requirement coverage. Screenshots are included only if enabled during recording and may contain visible data.\n',
    );
    this.log('Exported the scenario, generated tests, and available execution evidence.');
    return folder;
  }
  reportError(error: unknown): void {
    this.state.error = error instanceof Error ? error.message : String(error);
    this.log(this.state.error);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.controller?.abort();
    if (this.recorder) await this.stopRecording().catch(() => {});
    await this.operationDone;
    await this.stopDemo();
    await this.persistQueue;
  }
}
