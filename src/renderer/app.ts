import type { AppState, Assertion, JourneyAPI, LocatorSpec, TestCommand } from '../shared/types';

const api = (window as Window & { journey?: JourneyAPI }).journey;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const text = (id: string, value: string) => { $(id).textContent = value; };
const show = (id: string, visible: boolean) => { $(id).hidden = !visible; };
const enable = (id: string, enabled: boolean) => { ($<HTMLButtonElement>(id)).disabled = !enabled; };
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

let state: AppState | undefined;
let pending = '';
let cancelling = false;
let activeTab: 'ledger' | 'generated' | 'verification' = 'ledger';
let assertions: Assertion[] = [];
let dirty = false;
let formIdentity = '';
let commandIdentity = '';
let contextIdentity = '';
let generationIdentity = '';
let verificationIdentity = '';
let eventSignature = '';
let selectedFile = 0;
let dismissedError = '';
let localError = '';
let retry: (() => void) | undefined;
let streamVersion = 0;
let unsubscribe: (() => void) | undefined;
const phaseLabels = { idle: 'Ready', recording: 'Recording browser', generating: 'Generating test', verifying: 'Running verification' };

function reportError(error: unknown, heading = 'Something needs attention', help = 'Review the details and try the action again.', retryAction?: () => void) {
  localError = error instanceof Error ? error.message : String(error);
  text('error-heading', heading);
  text('error-message', localError);
  text('error-help', help);
  retry = retryAction;
  show('retry-button', !!retry);
  show('error-banner', true);
}

async function perform(label: string, action: () => Promise<unknown>, help: string, retryable = false) {
  if (pending) return;
  pending = label;
  localError = '';
  dismissedError = state?.error ?? '';
  show('error-banner', false);
  render();
  try {
    const result = await action();
    if (result && typeof result === 'object' && 'phase' in result) receive(result as AppState);
  } catch (error) {
    reportError(error, `${label} could not finish`, help, retryable ? () => { void perform(label, action, help, true); } : undefined);
  } finally {
    pending = '';
    render();
  }
}

function receive(next: AppState) {
  state = next;
  const identity = `${next.project?.id ?? ''}:${next.scenario?.id ?? ''}`;
  if (identity !== formIdentity) {
    formIdentity = identity;
    input('scenario-name').value = next.scenario?.name ?? '';
    input('start-url').value = next.scenario?.startUrl ?? '';
    input('capture-screenshots').checked = false;
    assertions = structuredClone(next.scenario?.assertions ?? []);
    dirty = false;
    generationIdentity = '';
    verificationIdentity = '';
    eventSignature = '';
    renderAssertions();
    setTab('ledger');
    show('export-result', false);
  // Routine streaming updates must not replace the current name or assertion draft.
  } else if (!dirty && next.scenario) {
    input('scenario-name').value = next.scenario.name;
    const updated = JSON.stringify(next.scenario.assertions);
    if (updated !== JSON.stringify(assertions)) {
      assertions = structuredClone(next.scenario.assertions);
      renderAssertions();
    }
  }
  const nextCommandIdentity = `${next.project?.id ?? ''}:${JSON.stringify(next.project?.commands ?? [])}`;
  if (commandIdentity !== nextCommandIdentity) {
    commandIdentity = nextCommandIdentity;
    const commands = select('test-command');
    commands.replaceChildren();
    (next.project?.commands ?? []).forEach((command, index) => commands.add(new Option(command.label || `${command.executable} ${command.args.join(' ')}`, String(index))));
    commands.add(new Option('Custom executable…', 'custom'));
    commands.value = next.project?.commands.length ? '0' : 'custom';
    updateCommand();
  }
  render();
}

function render() {
  const connected = !!state && !!api;
  const idle = connected && state?.phase === 'idle' && !pending;
  const hasProject = !!state?.project;
  const hasScenario = !!state?.scenario;
  const recording = state?.phase === 'recording';
  const busy = !!pending || (!!state && state.phase !== 'idle');
  show('welcome', !hasProject);
  show('journey-section', hasProject);
  text('project-name', state?.project?.name ?? 'No project open');
  text('project-framework', state?.project ? `${state.project.framework === 'unknown' ? 'Framework not detected' : state.project.framework} · ${state.project.buildTool || 'Local repo'}` : 'Choose a local repository');
  text('project-path', state?.project?.path ?? '');
  $('project-path').title = state?.project?.path ?? '';
  show('project-context', hasProject);
  const contextPaths = state?.project?.examples.map(example => example.path) ?? [];
  const nextContextIdentity = JSON.stringify([state?.project?.id, contextPaths]);
  if (contextIdentity !== nextContextIdentity) {
    contextIdentity = nextContextIdentity;
    text('context-count', `${contextPaths.length} file${contextPaths.length === 1 ? '' : 's'}`);
    $('context-paths').replaceChildren(...contextPaths.map(path => element('li', '', path)));
    show('context-empty', contextPaths.length === 0);
  }
  text('scenario-count', hasScenario ? '1' : '—');
  text('scenario-nav-name', state?.scenario?.name ?? 'Your first journey');
  show('scenario-dot', hasScenario);
  enable('scenario-nav', hasProject);
  text('rail-hint', state?.project?.summary || 'The best tests begin with a real interaction.');
  text('connection-state', connected ? 'On your Mac' : 'Disconnected');
  $('connection-state').prepend(element('span'));
  $('connection-state').classList.toggle('connected', connected);
  text('journey-title', state?.scenario?.name || state?.project?.name || 'A new journey');
  text('phase-chip', pending || (state?.phase && state.phase !== 'idle' ? phaseLabels[state.phase] : state?.scenario?.events.length ? 'Journey captured' : 'Ready to record'));
  $('phase-chip').className = `status-chip ${state?.phase ?? ''}`;
  ['open-project', 'load-demo', 'rail-project'].forEach(id => enable(id, idle));
  enable('start-recording', idle && hasProject);
  show('start-recording', !recording);
  show('stop-recording', recording);
  enable('stop-recording', recording && !pending);
  input('scenario-name').disabled = !idle || !hasProject;
  input('start-url').disabled = !idle || !hasProject;
  input('capture-screenshots').disabled = !idle || !hasProject;
  show('screenshot-help', input('capture-screenshots').checked);
  text('record-hint', recording ? 'Recording is live. Use the browser, then stop here to review the journey.' : hasScenario ? 'Starting again creates a new recording. Save and export this journey first if you want to keep it.' : 'A browser opens for your journey. Interactions appear here as you go.');
  enable('add-assertion', idle && hasScenario);
  enable('save-scenario', idle && hasScenario && dirty);
  text('assertion-count', String(assertions.length));
  show('assertions-empty', assertions.length === 0);
  $('assertion-list').querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input, select, textarea, button').forEach(control => { control.disabled = !idle; });
  text('save-status', !hasScenario ? 'Record a journey to define assertions.' : dirty ? 'Unsaved changes' : 'Saved with this journey');
  const codexMode = select('generator-mode').value === 'codex';
  text('codex-status', !state ? 'Connect the desktop app to check Codex.' : !codexMode ? 'Portable fallback uses the recorded journey and your assertions.' : state.codex.available ? `Codex available${state.codex.version ? ` · ${state.codex.version}` : ''}` : 'Codex is unavailable. Install/sign in to Codex, or choose the portable fallback.');
  show('model-field', codexMode);
  enable('generator-mode', idle);
  enable('model-name', idle);
  enable('generate', idle && hasScenario && assertions.length > 0 && (!codexMode || !!state?.codex.available));
  $('generate').title = !hasScenario ? 'Record a journey first' : assertions.length === 0 ? 'Add at least one assertion to define success' : codexMode && !state?.codex.available ? 'Choose the portable generator or make Codex available' : 'Save assertions and generate a test';
  text('generate', state?.phase === 'generating' || pending === 'Generate test' ? 'Generating…' : 'Generate test ↗');
  ['test-command', 'command-executable', 'command-args', 'json-args', 'use-json-args', 'verify-repeats'].forEach(id => enable(id, idle));
  input('command-args').disabled = !idle || input('use-json-args').checked;
  $<HTMLTextAreaElement>('json-args').disabled = !idle || !input('use-json-args').checked;
  enable('verify', idle && !!state?.generation);
  text('verify', state?.phase === 'verifying' ? 'Verifying…' : 'Run verification →');
  ['export-bundle', 'reveal-workspace'].forEach(id => enable(id, idle && !!state?.generation));
  enable('rail-reveal', idle && hasProject);
  show('cancel-run', state?.phase === 'generating' || state?.phase === 'verifying');
  enable('cancel-run', !cancelling);
  text('cancel-run', cancelling ? 'Cancelling…' : 'Cancel run');
  $('activity-indicator').classList.toggle('busy', busy);
  text('activity-current', pending || (state && state.phase !== 'idle' ? phaseLabels[state.phase] : state?.activity.at(-1)?.message) || (connected ? 'Ready when you are.' : 'Open JourneyProof in the desktop app to connect.'));
  const stage = state?.verification ? 4 : state?.generation || state?.phase === 'generating' ? 3 : state?.scenario?.events.length && !recording ? 2 : hasProject ? 1 : 0;
  document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => {
    const index = Number(button.dataset.step);
    button.disabled = index === 0 ? !idle : index === 1 ? !hasProject : index < 4 ? !hasScenario : !state?.generation;
    if (index === stage) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    button.classList.toggle('reached', index < stage);
  });
  if (state?.error && state.error !== dismissedError && !localError) reportError(state.error, 'The workspace needs attention', 'Review Activity for details. Check the project, URL, or command, then retry the relevant action.');
  renderLedger();
  renderGeneration();
  renderVerification();
  renderActivity();
}

function renderLedger() {
  const events = state?.scenario?.events ?? [];
  text('event-count', String(events.length));
  text('ledger-meta', events.length ? `${events.length} interaction${events.length === 1 ? '' : 's'} recorded` : state?.phase === 'recording' ? 'Listening to the browser…' : 'Waiting for your first interaction');
  show('ledger-empty', events.length === 0);
  const signature = JSON.stringify(events);
  if (eventSignature !== signature) {
    eventSignature = signature;
    const list = $('event-ledger');
    const fragment = document.createDocumentFragment();
    const icons: Record<string, string> = { navigate: '↗', click: '↖', fill: 'T', check: '☑', uncheck: '□', select: '⌄', press: '↵', popup: '▱', note: '·' };
    events.forEach(event => {
      const row = element('li', 'event-row');
      const detail = element('div');
      detail.append(element('h3', '', event.label || event.action));
      const locator = event.locators[0];
      if (locator) {
        const location = element('p', 'event-detail');
        location.append(element('code', '', `${locator.strategy}: ${locator.value}${locator.name ? ` · ${locator.name}` : ''}`));
        detail.append(location);
      }
      if (event.value !== undefined) detail.append(element('p', 'event-detail', event.redacted ? 'Value redacted' : `Value: ${event.value}`));
      if (event.url) detail.append(element('p', 'event-detail', event.url));
      if (event.frameSelectors?.length) detail.append(element('p', 'event-detail', `Frame: ${event.frameSelectors.join(' → ')}`));
      if (event.screenshot) detail.append(element('p', 'event-detail', 'Screenshot captured'));
      event.warnings?.forEach(warning => detail.append(element('p', 'event-warning', warning)));
      row.append(element('span', 'event-number', String(event.sequence).padStart(2, '0')), element('span', 'event-icon', icons[event.action] || '·'), detail, element('time', 'event-time', formatTime(event.timestamp)));
      fragment.append(row);
    });
    list.replaceChildren(fragment);
  }
  renderWarnings('scenario-warnings', state?.scenario?.warnings ?? []);
}

function renderWarnings(id: string, warnings: string[]) {
  const node = $(id);
  node.hidden = warnings.length === 0;
  if (node.dataset.value === JSON.stringify(warnings)) return;
  node.dataset.value = JSON.stringify(warnings);
  const list = element('ul');
  warnings.forEach(warning => list.append(element('li', '', warning)));
  node.replaceChildren(element('strong', '', 'Review notes'), list);
}

function renderAssertions() {
  const container = $('assertion-list');
  container.replaceChildren();
  assertions.forEach((assertion, index) => {
    const card = element('article', 'assertion-card');
    const header = element('div', 'assertion-topline');
    const remove = element('button', 'icon-button', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete assertion ${index + 1}`);
    remove.addEventListener('click', () => {
      assertions.splice(index, 1); dirty = true; renderAssertions(); render();
      const next = $('assertion-list').querySelector<HTMLButtonElement>('.icon-button');
      (next ?? $('add-assertion')).focus();
    });
    header.append(element('strong', '', `ASSERTION ${String(index + 1).padStart(2, '0')}`), remove);
    card.append(header);
    const field = (labelText: string, key: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
      const wrapper = element('div', 'field');
      const label = element('label', '', labelText);
      control.id = `assertion-${index}-${key}`;
      label.htmlFor = control.id;
      wrapper.append(label, control);
      return wrapper;
    };
    const changed = () => { dirty = true; render(); };
    const kinds = element('select');
    [['text', 'Text'], ['visible', 'Visible'], ['url', 'URL'], ['custom', 'Custom intent']].forEach(([value, label]) => kinds.add(new Option(label, value)));
    kinds.value = assertion.kind;
    kinds.addEventListener('change', () => {
      assertion.kind = kinds.value as Assertion['kind'];
      if (assertion.kind === 'text' || assertion.kind === 'visible') assertion.locator ??= { strategy: 'testId', value: '' };
      else delete assertion.locator;
      dirty = true; renderAssertions(); render(); $(`assertion-${index}-kind`).focus();
    });
    card.append(field('Kind', 'kind', kinds));
    if (assertion.kind === 'text' || assertion.kind === 'visible') {
      assertion.locator ??= { strategy: 'testId', value: '' };
      const locator = assertion.locator;
      const strategy = element('select');
      [['testId', 'Test ID'], ['role', 'Role'], ['label', 'Label'], ['placeholder', 'Placeholder'], ['text', 'Text'], ['css', 'CSS']].forEach(([value, label]) => strategy.add(new Option(label, value)));
      strategy.value = locator.strategy;
      strategy.addEventListener('change', () => { locator.strategy = strategy.value as LocatorSpec['strategy']; if (locator.strategy !== 'role') delete locator.name; dirty = true; renderAssertions(); render(); $(`assertion-${index}-strategy`).focus(); });
      const value = element('input'); value.value = locator.value; value.placeholder = 'e.g. total'; value.autocomplete = 'off'; value.spellcheck = false;
      value.addEventListener('input', () => { locator.value = value.value; changed(); });
      const grid = element('div', 'assertion-grid'); grid.append(field('Locator strategy', 'strategy', strategy), field('Locator value', 'value', value)); card.append(grid);
      if (locator.strategy === 'role') {
        const name = element('input'); name.value = locator.name ?? ''; name.placeholder = 'e.g. Add to cart';
        name.addEventListener('input', () => { locator.name = name.value || undefined; changed(); });
        card.append(field('Accessible name (optional)', 'accessible-name', name));
      }
    }
    const expected = element('input'); expected.value = assertion.expected;
    expected.placeholder = assertion.kind === 'text' ? 'e.g. $90.00' : assertion.kind === 'url' ? 'Expected URL' : assertion.kind === 'visible' ? 'Visible (no value needed)' : 'Describe the expected outcome';
    expected.addEventListener('input', () => { assertion.expected = expected.value; changed(); });
    card.append(field(assertion.kind === 'visible' ? 'Expected (optional)' : 'Expected', 'expected', expected));
    const description = element('textarea'); description.rows = 2; description.value = assertion.description; description.placeholder = 'Why this outcome matters';
    description.addEventListener('input', () => { assertion.description = description.value; changed(); });
    card.append(field('Description', 'description', description));
    container.append(card);
  });
}

function renderGeneration() {
  const generation = state?.generation;
  enable('tab-generated', !!generation);
  text('file-count', String(generation?.files.length ?? 0));
  if (!generation) { generationIdentity = ''; if (activeTab === 'generated') setTab('ledger'); return; }
  const identity = JSON.stringify(generation);
  if (generationIdentity === identity) return;
  const isNew = generationIdentity !== identity;
  generationIdentity = identity;
  selectedFile = 0;
  text('generation-summary', generation.summary);
  text('generation-workspace', generation.workspace);
  renderWarnings('generation-warnings', generation.warnings);
  const files = $('file-list'); files.replaceChildren();
  generation.files.forEach((file, index) => {
    const button = element('button', '', file.path); button.type = 'button';
    button.addEventListener('click', () => { selectedFile = index; showFile(); }); files.append(button);
  });
  showFile();
  if (isNew) setTab('generated');
}

function showFile() {
  const file = state?.generation?.files[selectedFile];
  text('code-path', file?.path ?? 'No generated files returned');
  text('code-content', file?.content ?? 'The generator returned no files. Check the review notes and Activity before trying again.');
  enable('copy-code', !!file);
  $('file-list').querySelectorAll('button').forEach((button, index) => button.setAttribute('aria-pressed', String(index === selectedFile)));
}

function renderVerification() {
  const verification = state?.verification;
  enable('tab-verification', !!state?.generation);
  if (!verification) {
    verificationIdentity = '';
    text('verification-statement', 'Run the generated test to collect evidence. No verification result yet.');
    $('verification-summary').replaceChildren(); $('verification-runs').replaceChildren();
    if (activeTab === 'verification' && !state?.generation) setTab('ledger');
    return;
  }
  const identity = JSON.stringify(verification);
  if (verificationIdentity === identity) return;
  verificationIdentity = identity;
  text('verification-statement', verification.statement);
  $('verification-summary').replaceChildren(element('span', `verification-status ${verification.status}`, verification.status.replaceAll('-', ' ')), element('code', '', `${verification.command.executable} ${verification.command.args.map(arg => JSON.stringify(arg)).join(' ')}`));
  const runs = $('verification-runs'); runs.replaceChildren();
  verification.runs.forEach(run => {
    const details = element('details', 'run-details'); details.open = run.status !== 'passed';
    const summary = element('summary');
    summary.append(element('strong', '', `Run ${run.index}`), element('span', `verification-status ${run.status}`, run.status.replaceAll('-', ' ')), element('span', 'run-duration', `${(run.durationMs / 1000).toFixed(1)}s · exit ${run.exitCode ?? '—'}`));
    details.append(summary, element('pre', 'run-output', run.output || 'No command output was captured.')); runs.append(details);
  });
  setTab('verification');
}

function renderActivity() {
  const log = $('activity-log');
  const entries = state?.activity ?? [];
  const signature = JSON.stringify(entries);
  if (log.dataset.value === signature) return;
  log.dataset.value = signature;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 35;
  const fragment = document.createDocumentFragment();
  entries.slice(-100).forEach(entry => {
    const row = element('div', 'activity-entry'); row.append(element('time', '', formatTime(entry.time)), element('p', '', entry.message)); fragment.append(row);
  });
  if (!entries.length) fragment.append(element('p', 'field-hint', 'Activity from your local workspace will appear here.'));
  log.replaceChildren(fragment);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function setTab(tab: typeof activeTab) {
  activeTab = tab;
  (['ledger', 'generated', 'verification'] as const).forEach(name => {
    show(`panel-${name}`, tab === name);
    $(`tab-${name}`).setAttribute('aria-selected', String(tab === name));
    $(`tab-${name}`).tabIndex = tab === name ? 0 : -1;
  });
}

function updateCommand() {
  const custom = select('test-command').value === 'custom';
  show('custom-command', custom);
  const command = state?.project?.commands[Number(select('test-command').value)];
  text('command-preview', !custom && command ? `${command.executable} ${command.args.map(arg => JSON.stringify(arg)).join(' ')}` : '');
}

function parseArgs(value: string): string[] {
  const result: string[] = []; let token = ''; let quote = ''; let started = false; let escaped = false;
  for (const char of value) {
    if (escaped) { token += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else token += char; started = true; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { result.push(token); token = ''; started = false; } } else { token += char; started = true; }
  }
  if (quote || escaped) throw new Error('An argument has an unfinished quote or escape. Close it, or use the JSON argument array in Advanced.');
  if (started) result.push(token);
  return result;
}

function getCommand(): TestCommand {
  if (select('test-command').value !== 'custom') {
    const command = state?.project?.commands[Number(select('test-command').value)];
    if (!command) throw new Error('Select a suggested command or enter a custom executable.');
    return structuredClone(command);
  }
  const executable = input('command-executable').value.trim();
  if (!executable) { input('command-executable').focus(); throw new Error('Enter an executable, such as npm, npx, or mvn. Put its arguments in the separate field.'); }
  let args: string[];
  if (input('use-json-args').checked) {
    let parsed: unknown;
    try { parsed = JSON.parse($<HTMLTextAreaElement>('json-args').value); } catch { throw new Error('Arguments must be valid JSON, for example ["run", "test"].'); }
    if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === 'string')) throw new Error('JSON arguments must be an array containing only strings.');
    args = parsed;
  } else args = parseArgs(input('command-args').value);
  return { executable, args, label: 'Custom command' };
}

function scenarioDraft() {
  const name = input('scenario-name').value.trim();
  if (!name) { input('scenario-name').focus(); throw new Error('Give this scenario a name before saving or generating.'); }
  for (const [index, assertion] of assertions.entries()) {
    if ((assertion.kind === 'text' || assertion.kind === 'visible') && !assertion.locator?.value.trim()) { $(`assertion-${index}-value`).focus(); throw new Error(`Assertion ${index + 1} needs a locator value.`); }
    if ((assertion.kind === 'text' || assertion.kind === 'url') && !assertion.expected.trim()) { $(`assertion-${index}-expected`).focus(); throw new Error(`Assertion ${index + 1} needs an expected value.`); }
    if (assertion.kind === 'custom' && !assertion.description.trim() && !assertion.expected.trim()) { $(`assertion-${index}-description`).focus(); throw new Error(`Describe the expected outcome for assertion ${index + 1}.`); }
  }
  return { name, assertions: structuredClone(assertions) };
}

async function saveDraft() {
  const draft = scenarioDraft();
  const next = await api!.saveScenario(draft);
  dirty = false;
  receive(next);
  return next;
}

['open-project', 'rail-project'].forEach(id => $(id).addEventListener('click', () => { if (api) void perform('Open project', () => api.chooseProject(), 'Choose a readable local repository folder.'); }));
$('load-demo').addEventListener('click', () => { if (api) void perform('Load cart demo', () => api.loadDemo(), 'Check Activity for the demo setup error, then try loading the demo again.', true); });
$('home-link').addEventListener('click', event => { event.preventDefault(); $('main-content').scrollTo({ top: 0, behavior: 'smooth' }); });
$('scenario-nav').addEventListener('click', () => { setTab('ledger'); $('main-content').scrollTo({ top: 0, behavior: 'smooth' }); });
input('scenario-name').addEventListener('input', () => { dirty = !!state?.scenario; render(); });
input('capture-screenshots').addEventListener('change', () => show('screenshot-help', input('capture-screenshots').checked));
$('record-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!api || pending || state?.phase !== 'idle') return;
  const url = input('start-url').value.trim();
  const name = input('scenario-name').value.trim();
  try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { reportError('Enter a full HTTP or HTTPS starting URL, for example http://localhost:3000.', 'Check the starting URL', 'Start your application before recording.'); input('start-url').focus(); return; }
  if (!name) { reportError('Enter a name for this journey.', 'Name your scenario'); input('scenario-name').focus(); return; }
  const captureScreenshots = input('capture-screenshots').checked;
  void perform('Start recording', () => api.startRecording({ url, name, captureScreenshots }), 'Check that the URL is reachable and the browser is installed. See Activity for details.');
});
$('stop-recording').addEventListener('click', () => { if (api) void perform('Stop recording', () => api.stopRecording(), 'Try stopping again. Any captured events remain visible in the ledger.'); });
$('add-assertion').addEventListener('click', () => {
  assertions.push({ id: crypto.randomUUID(), kind: 'text', locator: { strategy: 'testId', value: '' }, expected: '', description: '', source: 'user' });
  dirty = true; renderAssertions(); render(); $(`assertion-${assertions.length - 1}-value`).focus();
});
$('save-scenario').addEventListener('click', () => { if (api) void perform('Save scenario', saveDraft, 'Check the assertion fields and try saving again.'); });
select('generator-mode').addEventListener('change', render);
$('generate').addEventListener('click', () => {
  if (!api) return;
  void perform('Generate test', async () => {
    if (!assertions.length) throw new Error('Add at least one assertion before generating a test.');
    await saveDraft();
    const mode = select('generator-mode').value as 'codex' | 'portable';
    const model = input('model-name').value.trim();
    return api.generate({ mode, ...(mode === 'codex' && model ? { model } : {}) });
  }, 'Review Activity and generation notes. Check Codex setup or choose the portable fallback, then generate again.');
});
select('test-command').addEventListener('change', updateCommand);
input('use-json-args').addEventListener('change', render);
$('verify').addEventListener('click', () => {
  if (!api) return;
  void perform('Run verification', async () => {
    const command = getCommand();
    const repeats = Number(select('verify-repeats').value);
    if (![1, 2, 3].includes(repeats)) throw new Error('Choose between one and three verification runs.');
    setTab('verification');
    return api.verify({ command, repeats });
  }, 'Check the executable and arguments. Dependencies and the application must be available in the isolated workspace; inspect the run output for details.');
});
$('export-bundle').addEventListener('click', () => {
  if (api) void perform('Export bundle', async () => {
    const path = await api.exportBundle();
    text('export-result', path ? `Exported to ${path}` : 'Export cancelled. Your workspace is still available.');
    show('export-result', true);
  }, 'Choose a writable destination and export again.');
});
['rail-reveal', 'reveal-workspace'].forEach(id => $(id).addEventListener('click', () => { if (api) void perform('Reveal workspace', () => api.revealWorkspace(), 'Check that the workspace still exists, then try again.'); }));
$('cancel-run').addEventListener('click', async () => {
  if (!api || cancelling) return;
  cancelling = true; render();
  try { receive(await api.cancelRun()); } catch (error) { reportError(error, 'Cancellation could not finish', 'Check Activity and try cancelling again.'); } finally { cancelling = false; render(); }
});
$('copy-code').addEventListener('click', async () => {
  const content = state?.generation?.files[selectedFile]?.content;
  if (content === undefined) return;
  try { await navigator.clipboard.writeText(content); text('copy-code', 'Copied'); window.setTimeout(() => text('copy-code', 'Copy'), 1600); } catch (error) { reportError(error, 'Could not copy the file', 'Select the code and press ⌘C, or export the bundle.'); }
});
$('dismiss-error').addEventListener('click', () => { dismissedError = state?.error ?? ''; localError = ''; show('error-banner', false); });
$('retry-button').addEventListener('click', () => retry?.());
$('activity-toggle').addEventListener('click', () => {
  const expanded = $('activity-toggle').getAttribute('aria-expanded') !== 'true';
  $('activity-toggle').setAttribute('aria-expanded', String(expanded)); show('activity-log', expanded);
  if (expanded) $('activity-log').scrollTop = $('activity-log').scrollHeight;
});
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.addEventListener('click', () => setTab(button.dataset.tab as typeof activeTab));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]')).filter(tab => !tab.disabled);
    const index = tabs.indexOf(button);
    const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    target.click(); target.focus();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(button => button.addEventListener('click', () => {
  switch (button.dataset.step) {
    case '0': $('rail-project').click(); break;
    case '1': setTab('ledger'); input('start-url').focus(); $('main-content').scrollTo({ top: 0, behavior: 'smooth' }); break;
    case '2': $('assertions-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('add-assertion').focus({ preventScroll: true }); break;
    case '3': if (state?.generation) setTab('generated'); $('generation-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
    case '4': setTab('verification'); $('verify-section').scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
  }
}));
window.addEventListener('beforeunload', () => unsubscribe?.());

async function connect() {
  if (!api) {
    render();
    reportError('The native JourneyProof connection is unavailable.', 'Open JourneyProof on your Mac', 'Launch the Electron desktop app. This renderer needs its preload API to open folders, record, generate, and verify.');
    return;
  }
  try {
    if (!unsubscribe) unsubscribe = api.onUpdate(next => { streamVersion++; receive(next); });
    const version = streamVersion;
    const initial = await api.getState();
    if (streamVersion === version) receive(initial);
  } catch (error) { render(); reportError(error, 'Could not connect to the workspace', 'Retry the connection. If it still fails, restart the desktop app.', () => { void connect(); }); }
}
void connect();
