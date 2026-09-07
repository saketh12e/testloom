export type Framework = 'playwright-ts' | 'playwright-java' | 'selenium-java' | 'unknown';
export interface TestCommand { executable: string; args: string[]; label: string }
export interface Project {
  id: string; name: string; path: string; framework: Framework; buildTool: string;
  summary: string; examples: { path: string; content: string }[];
  commands: TestCommand[]; outputDir: string; isDemo?: boolean;
}
export interface LocatorSpec {
  strategy: 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'css';
  value: string; name?: string;
}
export interface InteractionEvent {
  id: string; sequence: number; timestamp: string;
  action: 'navigate' | 'click' | 'fill' | 'check' | 'uncheck' | 'select' | 'press' | 'popup' | 'note';
  url: string; pageId: string; label: string; locators: LocatorSpec[];
  value?: string; redacted?: boolean; screenshot?: string;
  frameSelectors?: string[]; warnings?: string[];
}
export interface Assertion {
  id: string; description: string; kind: 'text' | 'visible' | 'url' | 'custom';
  locator?: LocatorSpec; expected: string; source: 'user';
}
export interface Scenario {
  schemaVersion: 1; id: string; name: string; startUrl: string; createdAt: string;
  events: InteractionEvent[]; assertions: Assertion[];
  warnings: string[]; network: { method: string; url: string; status: number }[];
}
export interface GeneratedFile { path: string; content: string }
export interface Generation {
  provider: 'codex' | 'portable'; summary: string; files: GeneratedFile[];
  warnings: string[]; workspace: string; patch: string; generatedAt: string;
}
export interface VerificationRun {
  index: number; exitCode: number | null; durationMs: number; output: string;
  status: 'passed' | 'failed' | 'environment-error' | 'cancelled' | 'timed-out';
}
export interface Verification {
  status: 'passed' | 'failed' | 'environment-error' | 'cancelled' | 'timed-out';
  command: TestCommand; runs: VerificationRun[]; startedAt: string;
  statement: string;
  fileHashes?: Record<string, string>;
  discoveredTests?: string[];
}
export interface AppState {
  project?: Project; scenario?: Scenario; generation?: Generation; verification?: Verification;
  phase: 'idle' | 'recording' | 'generating' | 'verifying';
  activity: { time: string; message: string }[];
  error?: string; codex: { available: boolean; version?: string; path?: string };
  workspaceRoot: string;
}
export interface JourneyAPI {
  getState(): Promise<AppState>;
  chooseProject(): Promise<AppState>;
  loadDemo(): Promise<AppState>;
  startRecording(input: { url: string; name: string; captureScreenshots: boolean }): Promise<AppState>;
  stopRecording(): Promise<AppState>;
  saveScenario(input: { name: string; assertions: Assertion[] }): Promise<AppState>;
  generate(input: { mode: 'codex' | 'portable'; model?: string }): Promise<AppState>;
  verify(input: { command: TestCommand; repeats: number }): Promise<AppState>;
  exportBundle(): Promise<string | null>;
  revealWorkspace(): Promise<void>;
  cancelRun(): Promise<AppState>;
  onUpdate(callback: (state: AppState) => void): () => void;
}
