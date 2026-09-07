export type Framework = 'playwright-ts' | 'playwright-java' | 'selenium-java' | 'unknown';
export interface TestCommand {
  executable: string;
  args: string[];
  label: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  framework: Framework;
  buildTool: string;
  summary: string;
  examples: { path: string; content: string }[];
  commands: TestCommand[];
  outputDir: string;
  isDemo?: boolean;
  demoPort?: number;
}
export interface LocatorSpec {
  strategy: 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'css';
  value: string;
  name?: string;
}
export interface InteractionEvent {
  id: string;
  sequence: number;
  timestamp: string;
  action:
    'navigate' | 'click' | 'fill' | 'check' | 'uncheck' | 'select' | 'press' | 'popup' | 'note';
  url: string;
  pageId: string;
  label: string;
  locators: LocatorSpec[];
  value?: string;
  redacted?: boolean;
  screenshot?: string;
  frameSelectors?: string[];
  warnings?: string[];
}
export interface Assertion {
  id: string;
  description: string;
  kind: 'text' | 'visible' | 'url' | 'custom';
  locator?: LocatorSpec;
  expected: string;
  source: 'user';
}
export interface Scenario {
  schemaVersion: 1;
  id: string;
  name: string;
  startUrl: string;
  createdAt: string;
  events: InteractionEvent[];
  assertions: Assertion[];
  warnings: string[];
  network: { method: string; url: string; status: number }[];
}
export interface GeneratedFile {
  path: string;
  content: string;
}
export interface Generation {
  provider: AgentProvider;
  caseIds?: string[];
  caseFiles?: Record<string, string[]>;
  settings?: AgentSettings;
  summary: string;
  files: GeneratedFile[];
  warnings: string[];
  workspace: string;
  patch: string;
  generatedAt: string;
}
export interface VerificationRun {
  index: number;
  exitCode: number | null;
  durationMs: number;
  output: string;
  status: 'passed' | 'failed' | 'environment-error' | 'cancelled' | 'timed-out';
}
export interface Verification {
  status: 'passed' | 'failed' | 'environment-error' | 'cancelled' | 'timed-out';
  command: TestCommand;
  runs: VerificationRun[];
  startedAt: string;
  statement: string;
  fileHashes?: Record<string, string>;
  discoveredTests?: string[];
}
export type AgentProvider = 'codex' | 'claude' | 'portable';
export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
  instructions: string;
  excludedContextPaths: string[];
  claudeBudgetUsd?: number;
}
export interface AgentStatus {
  available: boolean;
  version?: string;
  path?: string;
}
export type CaseKind = 'positive' | 'negative' | 'boundary';
export interface TestCase {
  id: string;
  name: string;
  kind: CaseKind;
  priority: 'critical' | 'high' | 'normal' | 'low';
  tags: string[];
  enabled: boolean;
  recordingId: string;
  scenario: Scenario;
  updatedAt: string;
}
export interface RunRecord {
  id: string;
  createdAt: string;
  provider: AgentProvider;
  caseIds: string[];
  caseNames: string[];
  status: 'generated' | 'generation-failed' | Verification['status'];
  workspace: string;
  summary: string;
  fileCount: number;
}
export interface AppState {
  project?: Project;
  scenario?: Scenario;
  generation?: Generation;
  verification?: Verification;
  phase: 'idle' | 'recording' | 'generating' | 'verifying';
  activity: { time: string; message: string }[];
  error?: string;
  codex: AgentStatus;
  claude: AgentStatus;
  cases: TestCase[];
  activeCaseId?: string;
  settings: AgentSettings;
  history: RunRecord[];
  workspaceRoot: string;
}
export interface JourneyAPI {
  getState(): Promise<AppState>;
  chooseProject(): Promise<AppState>;
  loadDemo(): Promise<AppState>;
  startRecording(input: {
    url: string;
    name: string;
    captureScreenshots: boolean;
  }): Promise<AppState>;
  stopRecording(): Promise<AppState>;
  saveScenario(input: { name: string; assertions: Assertion[] }): Promise<AppState>;
  generate(input: { mode: AgentProvider; model?: string; caseIds?: string[] }): Promise<AppState>;
  saveCase(input: TestCase): Promise<AppState>;
  duplicateCase(input: { id: string; kind: CaseKind }): Promise<AppState>;
  deleteCase(input: { id: string }): Promise<AppState>;
  selectCase(input: { id: string }): Promise<AppState>;
  saveSettings(input: AgentSettings): Promise<AppState>;
  refreshAgents(): Promise<AppState>;
  chooseContextFiles(): Promise<AppState>;
  previewPrompt(input: { caseId?: string }): Promise<string>;
  importSuite(): Promise<AppState>;
  exportSuite(): Promise<string | null>;
  verify(input: { command: TestCommand; repeats: number }): Promise<AppState>;
  exportBundle(): Promise<string | null>;
  revealWorkspace(): Promise<void>;
  cancelRun(): Promise<AppState>;
  onUpdate(callback: (state: AppState) => void): () => void;
}
