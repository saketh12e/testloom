import type {
  AgentProvider,
  AgentSettings,
  AppState,
  Assertion,
  CaseKind,
  InteractionEvent,
  JourneyAPI,
  LocatorSpec,
  TestCase,
  TestCommand,
} from '../shared/types';

const api = (window as Window & { journey?: JourneyAPI }).journey;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const dialog = (id: string) => $<HTMLDialogElement>(id);
const show = (id: string, visible: boolean) => {
  $(id).hidden = !visible;
};
const text = (id: string, value: string) => {
  if ($(id).textContent !== value) $(id).textContent = value;
};
const enable = (id: string, enabled: boolean) => {
  $<HTMLButtonElement>(id).disabled = !enabled;
};
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
const clone = <T>(value: T): T => structuredClone(value);
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll('-', ' ');
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const providers: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  portable: 'Portable',
};
const strategies: [LocatorSpec['strategy'], string][] = [
  ['testId', 'Test ID'],
  ['role', 'Role'],
  ['label', 'Label'],
  ['placeholder', 'Placeholder'],
  ['text', 'Text'],
  ['css', 'CSS selector'],
];
const phases: Record<AppState['phase'], string> = {
  idle: 'Ready when you are.',
  indexing: 'Indexing your repository',
  recording: 'Recording your browser',
  generating: 'Generating your tests',
  verifying: 'Verifying the outcome',
};
const defaults: AgentSettings = {
  provider: 'codex',
  model: '',
  effort: 'max',
  timeoutSeconds: 480,
  instructions: '',
  excludedContextPaths: [],
  claudeBudgetUsd: 1,
};
const semantics: Record<CaseKind, string> = {
  positive:
    'A positive case passes when the intended action succeeds. Assert the successful result, such as a confirmation or the correct total.',
  negative:
    'A negative case passes when invalid input is rejected as expected. Assert the validation message or unchanged result. The test itself should pass; do not simply invert the positive expectation.',
  boundary:
    'A boundary case passes when a limit behaves as specified. Set an empty, minimum, maximum, or just-outside value in Recorded steps, then assert the exact expected result.',
};
let state: AppState | undefined;
let draft: TestCase | undefined;
let caseDirty = false;
let settingsDraft = clone(defaults);
let settingsDirty = false;
let pending = '';
let cancelling = false;
let currentPage: 'cases' | 'editor' | 'results' = 'cases';
let editorTab: 'steps' | 'expectations' | 'details' = 'steps';
let resultTab: 'generated' | 'verification' | 'history' = 'generated';
let filter: 'all' | CaseKind = 'all';
let selectedIds = new Set<string>();
let selectedFile = 0;
let streamVersion = 0;
let unsubscribe: (() => void) | undefined;
let dismissedError = '';
let lastProjectId = '';
let listSignature = '';
let editorSignature = '';
let settingsSignature = '';
let contextSignature = '';
let generationSignature = '';
let verificationSignature = '';
let historySignature = '';
let commandsSignature = '';
let toastTimer: number | undefined;
let confirmAction: (() => void) | undefined;
let savedFocus: HTMLElement | null = null;
// A streamed status update must never replace the text the user is editing.
const retainedDrafts = new Map<string, TestCase>();
const idle = () => !!api && !!state && state.phase === 'idle' && !pending;
const activeCase = () => state?.cases.find((item) => item.id === state?.activeCaseId);
const selectedAgentSession = () =>
  state?.agentSessions?.find(
    (session) => session.caseId === activeCase()?.id && session.provider === settingsDraft.provider,
  );
const mutable = <T extends HTMLElement>(node: T): T => {
  node.dataset.mutation = '';
  return node;
};
function toast(message: string) {
  text('toast', message);
  show('toast', true);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => show('toast', false), 4200);
}
function report(error: unknown, heading = 'Something needs attention') {
  const message = error instanceof Error ? error.message : String(error);
  text('error-heading', heading);
  text('error-message', message);
  show('error-banner', true);
  for (const name of ['settings', 'record'])
    if (dialog(`${name}-dialog`).open) {
      text(`${name}-error`, message);
      show(`${name}-error`, true);
    }
}
function invalidatePrompt() {
  show('prompt-preview', false);
  text('prompt-help', 'Preview saves your current case and settings, then shows the exact prompt.');
}
function changedCase() {
  if (!draft || !idle()) return;
  caseDirty = true;
  invalidatePrompt();
  text('editor-heading', draft.name || 'Untitled case');
  text('nav-case-name', draft.name || 'Untitled case');
  updateSemantics();
  renderControls();
}
function updateSemantics() {
  const kind = draft?.kind ?? 'positive';
  text('editor-kind', capitalize(kind));
  $('editor-kind').className = `badge ${kind}`;
  text('expectation-semantics', semantics[kind]);
  $('expectation-semantics').className = `semantic-note ${kind}`;
}
async function callState(action: () => Promise<AppState>) {
  const version = streamVersion;
  const next = await action();
  // An IPC response can trail a newer live update. Keep the newer state.
  if (version === streamVersion) receive(next);
  return next;
}
async function perform(label: string, action: () => Promise<unknown>): Promise<boolean> {
  if (!idle()) return false;
  pending = label;
  dismissedError = state?.error ?? '';
  show('error-banner', false);
  show('settings-error', false);
  show('record-error', false);
  renderControls();
  try {
    await action();
    return true;
  } catch (error) {
    report(error, `${label} couldn’t finish`);
    return false;
  } finally {
    pending = '';
    render();
  }
}
function receive(next: AppState) {
  const previous = state;
  const projectChanged = next.project?.id !== lastProjectId;
  state = next;
  if (projectChanged) {
    lastProjectId = next.project?.id ?? '';
    selectedIds.clear();
    filter = 'all';
    input('case-search').value = '';
    currentPage = 'cases';
    listSignature = '';
    contextSignature = '';
    commandsSignature = '';
    invalidatePrompt();
    show('export-result', false);
  }
  const active = activeCase();
  if (active?.id !== draft?.id) {
    if (draft && caseDirty) retainedDrafts.set(draft.id, clone(draft));
    draft = active ? clone(retainedDrafts.get(active.id) ?? active) : undefined;
    caseDirty = !!active && retainedDrafts.has(active.id);
    editorSignature = '';
    editorTab = 'steps';
    invalidatePrompt();
  } else if (active && !caseDirty && JSON.stringify(active) !== editorSignature)
    draft = clone(active);
  if (!settingsDirty) settingsDraft = clone(next.settings ?? defaults);
  // Only an actual new recording should take over the editor; demo loading stays in the library.
  if (next.phase === 'recording' && previous?.phase !== 'recording') {
    currentPage = 'editor';
    editorTab = 'steps';
  }
  if (previous?.phase === 'recording' && next.phase === 'idle' && active) {
    currentPage = 'editor';
    editorTab = active.scenario.assertions.length ? 'steps' : 'expectations';
    toast(
      active.scenario.assertions.length
        ? 'Recording saved as a new case.'
        : 'Recording saved. Add an expectation to define success.',
    );
  }
  selectedIds = new Set(
    [...selectedIds].filter((id) => next.cases.some((item) => item.id === id && item.enabled)),
  );
  if (next.error && next.error !== dismissedError) report(next.error);
  render();
}
function render() {
  renderLibrary();
  renderEditor();
  renderSettings();
  renderResults();
  renderActivity();
  renderNavigation();
  renderControls();
}
function renderNavigation() {
  if (currentPage === 'editor' && !draft && state?.phase !== 'recording') currentPage = 'cases';
  for (const page of ['cases', 'editor', 'results'] as const) {
    show(`page-${page}`, currentPage === page);
    const node = $(`nav-${page}`);
    if (currentPage === page) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  show('welcome', !state?.project);
  show('library', !!state?.project);
  show('nav-editor', !!draft || state?.phase === 'recording');
  text('breadcrumb-page', currentPage === 'editor' ? 'Case editor' : capitalize(currentPage));
  text('breadcrumb-project', state?.project?.name || 'Your workspace');
  text('project-name', state?.project?.name || 'Open a project');
  const frameworks = {
    'playwright-ts': 'Playwright · TypeScript',
    'playwright-java': 'Playwright · Java',
    'selenium-java': 'Selenium · Java',
    unknown: 'Local project',
  };
  text(
    'project-framework',
    state?.project ? frameworks[state.project.framework] : 'Choose a local folder',
  );
  $('rail-project').title = state?.project?.path || 'Open a project folder';
  text('case-count', String(state?.cases.length ?? 0));
  text(
    'nav-case-name',
    state?.phase === 'recording'
      ? state.scenario?.name || 'New recording'
      : draft?.name || 'Active case',
  );
  text('connection-state', state ? 'On your Mac' : 'Disconnected');
  $('connection-dot').classList.toggle('connected', !!state);
  show('result-dot', !!state?.generation);
  const settings = state?.settings ?? defaults;
  text(
    'agent-label',
    `${providers[settings.provider]}${settings.provider === 'codex' && !settings.model ? ' · default' : ''}`,
  );
  setSubTab('editor', editorTab);
  setSubTab('result', resultTab);
}
function generationIds(): string[] {
  if (currentPage === 'cases') return [...selectedIds];
  return draft ? [draft.id] : [];
}
function renderControls() {
  const ready = idle();
  const recording = state?.phase === 'recording';
  document
    .querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement
    >('[data-mutation]')
    .forEach((node) => {
      node.disabled = !ready;
    });
  enable('record-button', ready && !!state?.project);
  show('record-button', !recording);
  show('stop-recording', recording);
  enable('stop-recording', !!recording && !pending);
  enable('tab-expectations', !recording);
  enable('tab-details', !recording);
  show('editor-meta', !recording);
  enable('empty-record', ready && !!state?.project);
  enable('export-suite', ready && !!state?.cases.length);
  enable('save-case', ready && !!draft && caseDirty);
  enable('discard-case', ready && caseDirty);
  show('discard-case', caseDirty);
  for (const id of ['add-assertion', 'empty-assertion', 'delete-case'])
    enable(id, ready && !!draft);
  document.querySelectorAll<HTMLButtonElement>('[data-duplicate]').forEach((node) => {
    node.disabled = !ready || !draft;
  });
  ['case-name', 'case-kind', 'case-priority', 'case-tags', 'case-enabled'].forEach((id) =>
    enable(id, ready && !!draft),
  );
  text('save-status', caseDirty ? 'Unsaved changes' : 'All changes saved');
  $('save-status').classList.toggle('dirty', caseDirty);
  show('nav-dirty', caseDirty);
  document.querySelectorAll<HTMLInputElement>('[data-select-case]').forEach((node) => {
    const item = state?.cases.find((item) => item.id === node.dataset.selectCase);
    node.disabled =
      !ready || !item?.enabled || (!selectedIds.has(item.id) && selectedIds.size >= 20);
    node.checked = !!item && selectedIds.has(item.id);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-case-id]').forEach((node) => {
    node.disabled = !ready;
  });
  enable('select-all-cases', ready && visibleCases().some((item) => item.enabled));
  const eligible = visibleCases().filter((item) => item.enabled);
  input('select-all-cases').checked =
    eligible.length > 0 && eligible.every((item) => selectedIds.has(item.id));
  input('select-all-cases').indeterminate =
    eligible.some((item) => selectedIds.has(item.id)) && !input('select-all-cases').checked;
  enable('clear-selection', ready);
  show('clear-selection', currentPage === 'cases' && selectedIds.size > 0);
  const ids = generationIds();
  const settings = state?.settings ?? defaults;
  const available = settings.provider === 'portable' || !!state?.[settings.provider].available;
  const candidateCases = ids.map((id) =>
    draft?.id === id ? draft : state?.cases.find((item) => item.id === id),
  );
  const canGenerate =
    ids.length > 0 &&
    candidateCases.every((item) => item?.enabled && item.scenario.assertions.length > 0);
  show('generate', !!state?.project && currentPage !== 'results' && !recording);
  show(
    'generation-scope',
    !!state?.project && currentPage !== 'results' && !recording && ids.length > 0,
  );
  const screenshotCount = candidateCases.reduce(
    (total, item) =>
      total + (item?.scenario.events.filter((event) => !!event.screenshot).length ?? 0),
    0,
  );
  text(
    'generation-data-scope',
    settings.provider === 'portable'
      ? 'Portable uses the selected interaction ledger and supported expectations locally. No provider request is made.'
      : `Sent to ${providers[settings.provider]}: the selected interaction ledger, ${plural(screenshotCount, 'screenshot')} and expectations, plus repository context read on demand.`,
  );
  enable('generate', ready && canGenerate && available);
  text(
    'generate',
    state?.phase === 'generating'
      ? 'Generating…'
      : ids.length > 1
        ? `Generate ${ids.length} cases ↗`
        : 'Generate test ↗',
  );
  $('generate').title = !ids.length
    ? 'Select cases to generate'
    : !canGenerate
      ? 'Every selected case must be enabled and have at least one expectation'
      : !available
        ? `${providers[settings.provider]} is unavailable. Open Agent settings to choose an available generator.`
        : 'Save the case and generate tests';
  const inFlight =
    state?.phase === 'indexing' || state?.phase === 'generating' || state?.phase === 'verifying';
  const phaseLabel =
    state?.phase === 'indexing' ? phases.indexing : pending || (state ? phases[state.phase] : '');
  show('cancel-run', inFlight);
  enable('cancel-run', !cancelling);
  text(
    'cancel-run',
    cancelling ? 'Cancelling…' : state?.phase === 'indexing' ? 'Cancel scan' : 'Cancel run',
  );
  show('phase-chip', !!pending || !!inFlight);
  text('phase-chip', phaseLabel);
  $('activity-indicator').classList.toggle(
    'busy',
    !!pending || (!!state && state.phase !== 'idle'),
  );
  let footerTitle = 'Ready when you are.';
  let footerDetail = 'Tests are created in a separate copy.';
  if (currentPage === 'cases' && state?.project) {
    footerTitle = selectedIds.size
      ? `${selectedIds.size} of 20 cases selected`
      : 'Choose the outcomes to test';
    footerDetail = selectedIds.size
      ? `${providers[settings.provider]} will generate your selected cases.`
      : 'Select cases above, or record a new flow.';
  }
  if (currentPage === 'editor') {
    footerTitle = caseDirty
      ? 'Your changes will be saved before generation'
      : draft?.scenario.assertions.length
        ? 'Ready to turn intent into a test'
        : 'Define what success looks like';
    footerDetail = draft?.scenario.assertions.length
      ? `${providers[settings.provider]} · ${plural(draft.scenario.events.length, 'step')} · ${plural(draft.scenario.assertions.length, 'expectation')}`
      : 'Add at least one expectation before generating.';
  }
  if (ids.length && !available && currentPage !== 'results')
    footerDetail = `${providers[settings.provider]} is unavailable. Choose a generator in Agent settings.`;
  if (currentPage === 'results') {
    footerTitle = state?.verification
      ? capitalize(state.verification.status)
      : state?.generation
        ? 'Generated and ready for review'
        : 'Your evidence starts here';
    footerDetail = state?.generation
      ? 'Code, verification, and export belong to this generated run.'
      : 'Generate a case to see the result.';
  }
  if (pending || (state?.phase && state.phase !== 'idle')) {
    footerTitle = phaseLabel;
    footerDetail = state?.activity.at(-1)?.message || 'Tests are created in a separate copy.';
  }
  text('footer-title', footerTitle);
  text('footer-detail', footerDetail);
  for (const id of ['export-bundle', 'reveal-workspace', 'verify'])
    enable(id, ready && !!state?.generation?.files.length);
  enable('save-settings', ready && settingsDirty);
  enable('discard-settings', ready && settingsDirty);
  show('discard-settings', settingsDirty);
  enable('preview-prompt', ready && !!draft && !!state?.project);
  enable('add-context-files', ready && !!state?.project);
  const session = selectedAgentSession();
  enable(
    'reset-agent-session',
    ready && !!activeCase() && !!session && session.status !== 'running',
  );
  text('settings-save-status', settingsDirty ? 'Unsaved settings' : 'All settings saved');
  enable('close-record', !pending);
  enable('cancel-record', !pending);
  enable('confirm-accept', !pending);
  enable('confirm-cancel', !pending);
}
function visibleCases() {
  const query = input('case-search').value.toLocaleLowerCase().trim();
  return (state?.cases ?? []).filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      (!query ||
        `${item.name} ${item.tags.join(' ')} ${item.kind}`.toLocaleLowerCase().includes(query)),
  );
}
function renderLibrary() {
  const cases = state?.cases ?? [];
  for (const kind of ['positive', 'negative', 'boundary'] as const)
    text(`${kind}-count`, String(cases.filter((item) => item.kind === kind).length));
  text('all-count', String(cases.length));
  document
    .querySelectorAll<HTMLButtonElement>('[data-filter]')
    .forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.filter === filter)));
  const visible = visibleCases();
  text(
    'library-count',
    `${plural(visible.length, 'case')}${visible.length !== cases.length ? ` of ${cases.length}` : ''} · ${cases.filter((item) => item.enabled).length} enabled`,
  );
  show('library-empty', !cases.length);
  show('search-empty', cases.length > 0 && !visible.length);
  const signature = JSON.stringify([visible, [...selectedIds]]);
  if (signature === listSignature) return;
  listSignature = signature;
  // Search itself is outside this subtree; typing never recreates its input.
  const nodes = visible.map((item) => {
    const row = el(
      'div',
      `case-row${selectedIds.has(item.id) ? ' selected' : ''}${item.enabled ? '' : ' disabled-case'}`,
    );
    row.setAttribute('role', 'listitem');
    row.dataset.testid = 'case-row';
    row.dataset.caseRow = item.id;
    const main = el('div', 'case-row-main');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.selectCase = item.id;
    checkbox.setAttribute('aria-label', `Select ${item.name}`);
    checkbox.checked = selectedIds.has(item.id);
    checkbox.addEventListener('change', () => {
      if (!idle()) return;
      if (checkbox.checked && selectedIds.size >= 20) {
        checkbox.checked = false;
        toast('You can select up to 20 cases at a time.');
        return;
      }
      checkbox.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id);
      row.classList.toggle('selected', checkbox.checked);
      renderControls();
      // Keep this checkbox mounted and focused after a selection.
      listSignature = JSON.stringify([visibleCases(), [...selectedIds]]);
    });
    const button = el('button', 'case-open');
    button.dataset.caseId = item.id;
    button.dataset.testid = 'open-case';
    button.append(
      el('strong', '', item.name),
      el(
        'small',
        '',
        `${item.enabled ? (item.tags.length ? item.tags.join(' · ') : 'No tags') : 'Disabled'} · ${plural(item.scenario.assertions.length, 'expectation')}`,
      ),
    );
    button.title = item.name;
    button.addEventListener('click', () =>
      navigate(async () => {
        await callState(() => api!.selectCase({ id: item.id }));
        currentPage = 'editor';
        editorTab = 'steps';
      }),
    );
    main.append(checkbox, button);
    row.append(
      main,
      el('span', `badge ${item.kind}`, capitalize(item.kind)),
      el('span', `priority ${item.priority}`, capitalize(item.priority)),
      el('span', 'step-count', String(item.scenario.events.length)),
    );
    return row;
  });
  $('case-list').replaceChildren(...nodes);
}
function control<K extends 'input' | 'textarea' | 'select'>(
  tag: K,
  id: string,
  value: string,
  onChange: (value: string) => void,
  options?: [string, string][],
) {
  const node = mutable(el(tag));
  node.id = id;
  if (node instanceof HTMLSelectElement)
    options?.forEach(([value, label]) => node.add(new Option(label, value)));
  node.value = value;
  if (node instanceof HTMLInputElement) node.autocomplete = 'off';
  node.addEventListener(tag === 'select' ? 'change' : 'input', () => {
    if (!idle()) return;
    onChange(node.value);
    changedCase();
  });
  return node;
}
function field(label: string, node: HTMLElement) {
  const wrapper = el('label', 'field', label);
  wrapper.append(node);
  return wrapper;
}
function renderEditor(force = false) {
  const recording = state?.phase === 'recording';
  const scenario = recording ? state?.scenario : draft?.scenario;
  show('recording-notice', recording);
  text('live-event-count', plural(scenario?.events.length ?? 0, 'step'));
  text('event-count', String(scenario?.events.length ?? 0));
  text('assertion-count', String(recording ? 0 : (draft?.scenario.assertions.length ?? 0)));
  text('recorded-url', scenario?.startUrl || '');
  $('recorded-url').title = scenario?.startUrl || '';
  show('steps-empty', !scenario?.events.length);
  show('assertions-empty', !draft?.scenario.assertions.length);
  text(
    'editor-heading',
    recording ? scenario?.name || 'New recording' : draft?.name || 'New recording',
  );
  updateSemantics();
  const signature = JSON.stringify(recording ? scenario : draft);
  if (!force && (caseDirty || editorSignature === signature) && !recording) return;
  if (editorSignature === signature && !force) return;
  editorSignature = signature;
  if (draft) {
    input('case-name').value = draft.name;
    select('case-kind').value = draft.kind;
    select('case-priority').value = draft.priority;
    input('case-tags').value = draft.tags.join(', ');
    input('case-enabled').checked = draft.enabled;
  }
  renderSteps(scenario?.events ?? []);
  renderAssertions();
  renderWarnings('scenario-warnings', scenario?.warnings ?? []);
}
function renderSteps(events: InteractionEvent[]) {
  const openIds = new Set(
    Array.from($('event-ledger').querySelectorAll<HTMLDetailsElement>('details[open]')).map(
      (node) => node.dataset.eventId,
    ),
  );
  const symbols: Record<InteractionEvent['action'], string> = {
    navigate: '↗',
    click: '↖',
    fill: 'T',
    check: '✓',
    uncheck: '□',
    select: '⌄',
    press: '↵',
    popup: '↗',
    note: '·',
  };
  $('event-ledger').replaceChildren(
    ...events.map((event, index) => {
      const card = el('details', 'step-card');
      card.dataset.eventId = event.id;
      card.dataset.testid = 'recorded-step';
      card.open = openIds.has(event.id);
      const summary = el('summary');
      const detail = el('div', 'step-summary');
      const heading = el('strong', '', event.label || capitalize(event.action));
      const caption = el(
        'small',
        '',
        `${capitalize(event.action)}${event.value !== undefined ? ` · ${event.redacted ? 'Value redacted' : event.value}` : event.locators[0] ? ` · ${event.locators[0].value}` : event.url ? ` · ${event.url}` : ''}`,
      );
      detail.append(heading, caption);
      summary.append(
        el('span', 'step-number', String(index + 1).padStart(2, '0')),
        el('span', 'step-symbol', symbols[event.action]),
        detail,
        el('span', 'step-chevron', '›'),
      );
      const body = el('div', 'step-body');
      const label = control('input', `step-${index}-label`, event.label, (value) => {
        event.label = value;
        heading.textContent = value || capitalize(event.action);
      });
      body.append(field('Step label', label));
      if (event.action === 'navigate' || event.action === 'popup')
        body.append(
          field(
            'Destination URL',
            control('input', `step-${index}-url`, event.url, (value) => {
              event.url = value;
              if (index === 0 && draft && event.action === 'navigate')
                draft.scenario.startUrl = value;
            }),
          ),
        );
      if (['fill', 'select', 'press'].includes(event.action) || event.value !== undefined) {
        const value = control(
          'input',
          `step-${index}-value`,
          event.redacted ? '' : (event.value ?? ''),
          (value) => {
            event.value = value;
            event.redacted = false;
            caption.textContent = `${capitalize(event.action)} · ${value}`;
          },
        );
        value.dataset.testid = 'step-value';
        value.placeholder = event.redacted ? 'Enter a safe test value' : 'Input value';
        body.append(field(event.action === 'press' ? 'Key to press' : 'Input value', value));
        if (event.redacted)
          body.append(
            el(
              'p',
              'field-hint',
              'The recorded value was redacted. Enter a safe test value before generation.',
            ),
          );
      }
      if (!['navigate', 'popup', 'note'].includes(event.action) || event.locators.length) {
        const header = el('div', 'locator-heading');
        header.append(el('span', '', 'LOCATORS · in preference order'));
        const add = mutable(el('button', 'text-button', '+ Add locator'));
        add.type = 'button';
        add.setAttribute('aria-label', `Add locator to step ${index + 1}`);
        const locatorList = el('div');
        const fillLocators = () => {
          locatorList.replaceChildren(
            ...event.locators.map((locator, locatorIndex) => {
              const grid = el('div', 'locator-grid');
              grid.dataset.testid = 'step-locator';
              const prefix = `step-${index}-locator-${locatorIndex}`;
              const name = control('input', `${prefix}-name`, locator.name ?? '', (value) => {
                locator.name = value || undefined;
              });
              name.placeholder = 'Optional';
              const strategy = control(
                'select',
                `${prefix}-strategy`,
                locator.strategy,
                (value) => {
                  locator.strategy = value as LocatorSpec['strategy'];
                  name.parentElement!.hidden = value !== 'role';
                  if (value !== 'role') delete locator.name;
                },
                strategies,
              );
              const value = control('input', `${prefix}-value`, locator.value, (value) => {
                locator.value = value;
              });
              value.dataset.testid = 'locator-value';
              const nameField = field('Accessible name', name);
              nameField.hidden = locator.strategy !== 'role';
              const remove = mutable(el('button', 'icon-button', '×'));
              remove.type = 'button';
              remove.setAttribute(
                'aria-label',
                `Remove locator ${locatorIndex + 1} from step ${index + 1}`,
              );
              remove.addEventListener('click', () => {
                if (!idle()) return;
                event.locators.splice(locatorIndex, 1);
                changedCase();
                fillLocators();
                add.focus();
              });
              grid.append(
                field('Strategy', strategy),
                field('Locator value', value),
                nameField,
                remove,
              );
              return grid;
            }),
          );
          renderControls();
        };
        add.addEventListener('click', () => {
          if (!idle()) return;
          event.locators.push({ strategy: 'testId', value: '' });
          changedCase();
          fillLocators();
          input(`step-${index}-locator-${event.locators.length - 1}-value`).focus();
        });
        header.append(add);
        body.append(header, locatorList);
        fillLocators();
      }
      if (event.screenshot)
        body.append(el('p', 'field-hint', 'Screenshot captured with this step.'));
      if (event.frameSelectors?.length)
        body.append(el('p', 'field-hint', `Inside frame: ${event.frameSelectors.join(' → ')}`));
      event.warnings?.forEach((warning) => body.append(el('p', 'field-hint', warning)));
      card.append(summary, body);
      return card;
    }),
  );
}
function renderAssertions() {
  const assertions = state?.phase === 'recording' ? [] : (draft?.scenario.assertions ?? []);
  $('assertion-list').replaceChildren(
    ...assertions.map((assertion, index) => {
      const card = el('article', 'assertion-card');
      card.dataset.assertionId = assertion.id;
      card.dataset.testid = 'expectation';
      const header = el('div', 'assertion-topline');
      const remove = mutable(el('button', 'icon-button', '×'));
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete expectation ${index + 1}`);
      remove.addEventListener('click', () => {
        if (!idle() || !draft) return;
        draft.scenario.assertions.splice(index, 1);
        changedCase();
        renderAssertions();
        renderControls();
        $('add-assertion').focus();
      });
      header.append(el('strong', '', `EXPECTATION ${String(index + 1).padStart(2, '0')}`), remove);
      card.append(header);
      const kind = control(
        'select',
        `assertion-${index}-kind`,
        assertion.kind,
        (value) => {
          assertion.kind = value as Assertion['kind'];
          if (value === 'text' || value === 'visible')
            assertion.locator ??= { strategy: 'testId', value: '' };
          else delete assertion.locator;
          renderAssertions();
          renderControls();
          $(`assertion-${index}-kind`).focus();
        },
        [
          ['text', 'Text equals'],
          ['visible', 'Element is visible'],
          ['url', 'URL equals'],
          ['custom', 'Custom outcome'],
        ],
      );
      card.append(field('Expectation type', kind));
      if (assertion.kind === 'text' || assertion.kind === 'visible') {
        assertion.locator ??= { strategy: 'testId', value: '' };
        const locator = assertion.locator;
        const grid = el('div', 'assertion-locator-grid');
        const name = control(
          'input',
          `assertion-${index}-accessible-name`,
          locator.name ?? '',
          (value) => {
            locator.name = value || undefined;
          },
        );
        name.placeholder = 'e.g. Apply coupon';
        const nameField = field('Accessible name (optional)', name);
        nameField.hidden = locator.strategy !== 'role';
        const strategy = control(
          'select',
          `assertion-${index}-strategy`,
          locator.strategy,
          (value) => {
            locator.strategy = value as LocatorSpec['strategy'];
            nameField.hidden = value !== 'role';
            if (value !== 'role') delete locator.name;
          },
          strategies,
        );
        const value = control('input', `assertion-${index}-value`, locator.value, (value) => {
          locator.value = value;
        });
        value.placeholder = 'e.g. coupon-message';
        value.dataset.testid = 'expectation-locator';
        grid.append(field('Locator strategy', strategy), field('Locator value', value));
        card.append(grid, nameField);
      }
      if (assertion.kind !== 'visible') {
        const expected = control(
          'input',
          `assertion-${index}-expected`,
          assertion.expected,
          (value) => {
            assertion.expected = value;
          },
        );
        expected.dataset.testid = 'expectation-expected';
        expected.placeholder =
          assertion.kind === 'url'
            ? 'https://example.com/success'
            : assertion.kind === 'custom'
              ? 'Describe the expected behavior'
              : 'e.g. This coupon is not valid';
        card.append(field('Expected outcome', expected));
      } else
        card.append(
          el(
            'p',
            'field-hint',
            'Passes when the located element is visible. Use a validation-message locator for a negative case.',
          ),
        );
      const description = control(
        'textarea',
        `assertion-${index}-description`,
        assertion.description,
        (value) => {
          assertion.description = value;
        },
      );
      description.rows = 2;
      description.placeholder = 'What this expectation proves';
      card.append(field('Description', description));
      return card;
    }),
  );
  text('assertion-count', String(assertions.length));
  show('assertions-empty', assertions.length === 0);
}
function changedSettings() {
  if (!idle()) return;
  settingsDirty = true;
  invalidatePrompt();
  renderProvider();
  renderControls();
}
function renderSettings() {
  const signature = JSON.stringify(settingsDraft);
  if (!settingsDirty && settingsSignature !== signature) {
    settingsSignature = signature;
    select('generator-mode').value = settingsDraft.provider;
    input('model-name').value = settingsDraft.model;
    select('agent-effort').value = settingsDraft.effort;
    input('agent-timeout').value = String(settingsDraft.timeoutSeconds);
    input('claude-budget').value = String(settingsDraft.claudeBudgetUsd ?? 1);
    $<HTMLTextAreaElement>('agent-instructions').value = settingsDraft.instructions;
  }
  renderProvider();
  const repository = state?.project?.repository;
  show('repository-summary', !!state?.project);
  text(
    'repository-scan',
    repository
      ? `${repository.fileCount.toLocaleString()} indexed ${repository.fileCount === 1 ? 'file' : 'files'} · scan ${repository.scanDurationMs < 1000 ? `${Math.round(repository.scanDurationMs)} ms` : `${(repository.scanDurationMs / 1000).toFixed(1)} s`}`
      : 'Repository scan details are unavailable. Reconnect the project to refresh.',
  );
  show('repository-scanned-at', !!repository);
  text('repository-scanned-at', repository ? `Scanned ${formatDate(repository.scannedAt)}` : '');
  const paths = state?.project?.examples.map((example) => example.path) ?? [];
  const context = JSON.stringify([state?.project?.id, paths]);
  if (contextSignature !== context) {
    contextSignature = context;
    $('context-paths').replaceChildren(
      ...paths.map((path) => {
        const label = el('label', 'context-path');
        const checkbox = mutable(el('input'));
        checkbox.type = 'checkbox';
        checkbox.dataset.contextPath = path;
        checkbox.setAttribute('aria-label', `Include ${path}`);
        checkbox.addEventListener('change', () => {
          if (!idle()) return;
          const excluded = new Set(settingsDraft.excludedContextPaths);
          checkbox.checked ? excluded.delete(path) : excluded.add(path);
          settingsDraft.excludedContextPaths = [...excluded];
          changedSettings();
          updateContextCount();
        });
        label.append(checkbox, el('span', '', path));
        return label;
      }),
    );
  }
  document.querySelectorAll<HTMLInputElement>('[data-context-path]').forEach((node) => {
    node.checked = !settingsDraft.excludedContextPaths.includes(node.dataset.contextPath!);
  });
  updateContextCount();
  show('context-empty', !paths.length);
  text(
    'context-empty',
    state?.project
      ? 'No context files yet. Add tests, page objects, helpers, or config from your project.'
      : 'Open a project to see its context files.',
  );
}
function updateContextCount() {
  const paths = state?.project?.examples.map((example) => example.path) ?? [];
  text(
    'context-count',
    `${paths.filter((path) => !settingsDraft.excludedContextPaths.includes(path)).length}/${paths.length}`,
  );
}
function renderProvider() {
  const provider = settingsDraft.provider;
  show('agent-options', provider !== 'portable');
  show('claude-budget-field', provider === 'claude');
  const status = provider === 'portable' ? undefined : state?.[provider];
  text(
    'agent-status',
    provider === 'portable'
      ? 'Always available'
      : status?.available
        ? `Available${status.version ? ` · ${status.version}` : ''}`
        : `${providers[provider]} is unavailable`,
  );
  $('agent-status').className =
    provider === 'portable' || status?.available ? 'available' : 'unavailable';
  text(
    'provider-help',
    provider === 'portable'
      ? 'Uses your recorded steps and supported expectations directly. No model or agent account is needed.'
      : provider === 'claude'
        ? 'Uses your local Claude setup. Time and spending limits apply separately to each case in a batch.'
        : 'Uses your local Codex setup. The time limit applies separately to each case in a batch.',
  );
  renderAgentSession();
}
function renderAgentSession() {
  const provider = settingsDraft.provider;
  const item = activeCase();
  const session = selectedAgentSession();
  const usesAgent = provider !== 'portable';
  text('session-case', item ? draft?.name || item.name : 'Open a case to view its agent session.');
  show('session-status', usesAgent && !!item);
  text('session-status', session ? capitalize(session.status) : 'New session');
  $('session-status').className = `badge ${session?.status ?? ''}`;
  show('session-details', usesAgent && !!item);
  text(
    'session-details',
    session
      ? `${providers[provider]} · ${plural(session.turns, 'turn')} · ${session.id.slice(0, 8)}${session.id.length > 8 ? '…' : ''}`
      : `${providers[provider]} · Starts with the next generation`,
  );
  $('session-details').title = session ? `Session ${session.id}` : '';
  text(
    'session-help',
    usesAgent
      ? 'New cases start fresh. Regenerating continues this case’s conversation.'
      : 'Portable does not use agent sessions. Codex and Claude keep their own case memory.',
  );
  show('session-error', usesAgent && !!session?.lastError);
  text('session-error', session?.lastError ?? '');
  show('reset-agent-session', usesAgent && !!session);
  show('session-native-help', usesAgent);
  text(
    'session-native-help',
    provider === 'claude' ? 'Saved by Claude Code on this Mac.' : 'Saved by Codex on this Mac.',
  );
  show('session-reset-help', usesAgent && !!session);
  text('session-reset-help', `Starts a new conversation for this case. Previous history is kept.`);
}
function renderWarnings(id: string, warnings: string[]) {
  show(id, warnings.length > 0);
  const node = $(id);
  const signature = JSON.stringify(warnings);
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;
  const list = el('ul');
  warnings.forEach((warning) => list.append(el('li', '', warning)));
  node.replaceChildren(el('strong', '', 'Review notes'), list);
}
function renderResults() {
  const generation = state?.generation;
  show('generation-empty', !generation);
  show('generation-content', !!generation);
  text('file-count', String(generation?.files.length ?? 0));
  const signature = JSON.stringify(generation);
  if (generationSignature !== signature) {
    generationSignature = signature;
    selectedFile = 0;
    text('generation-summary', generation?.summary ?? '');
    text('generation-provider', generation ? providers[generation.provider] : '');
    renderWarnings('generation-warnings', generation?.warnings ?? []);
    $('file-list').replaceChildren(
      ...(generation?.files ?? []).map((file, index) => {
        const button = el('button', '', file.path);
        button.dataset.fileIndex = String(index);
        button.addEventListener('click', () => {
          selectedFile = index;
          showFile();
        });
        return button;
      }),
    );
    showFile();
  }
  const commands = JSON.stringify([state?.project?.id, state?.project?.commands]);
  if (commands !== commandsSignature) {
    commandsSignature = commands;
    select('test-command').replaceChildren();
    (state?.project?.commands ?? []).forEach((command, index) =>
      select('test-command').add(
        new Option(
          command.label || `${command.executable} ${command.args.join(' ')}`,
          String(index),
        ),
      ),
    );
    select('test-command').add(new Option('Custom command…', 'custom'));
    select('test-command').value = state?.project?.commands.length ? '0' : 'custom';
    updateCommand();
  }
  const verification = state?.verification;
  const verificationKey = JSON.stringify(verification);
  if (verificationKey !== verificationSignature) {
    verificationSignature = verificationKey;
    text(
      'verification-statement',
      verification?.statement || 'No verification yet. Generate a test, then run it here.',
    );
    $('verification-summary').replaceChildren();
    $('verification-runs').replaceChildren();
    if (verification) {
      $('verification-summary').append(
        el('span', `badge ${verification.status}`, capitalize(verification.status)),
        el(
          'code',
          '',
          `${verification.command.executable} ${verification.command.args.map((arg) => JSON.stringify(arg)).join(' ')}`,
        ),
      );
      $('verification-runs').replaceChildren(
        ...verification.runs.map((run) => {
          const details = el('details', 'run-details');
          details.open = run.status !== 'passed';
          details.dataset.runIndex = String(run.index);
          details.dataset.testid = 'verification-run';
          const summary = el('summary');
          summary.append(
            el('strong', '', `Run ${run.index}`),
            el('span', `badge ${run.status}`, capitalize(run.status)),
            el(
              'span',
              'run-duration',
              `${(run.durationMs / 1000).toFixed(1)}s · exit ${run.exitCode ?? '—'}`,
            ),
          );
          details.append(
            summary,
            el('pre', 'run-output', run.output || 'No command output was captured.'),
          );
          return details;
        }),
      );
    }
  }
  const history = state?.history ?? [];
  text('history-count', String(history.length));
  show('history-empty', !history.length);
  const historyKey = JSON.stringify(history);
  if (historyKey !== historySignature) {
    historySignature = historyKey;
    $('history-list').replaceChildren(
      ...[...history]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((run) => {
          const card = el('article', 'history-card');
          card.dataset.historyId = run.id;
          card.dataset.testid = 'history-row';
          const body = el('div');
          body.append(
            el('h3', '', run.caseNames.join(', ') || 'Test generation'),
            el('p', '', run.summary),
            el(
              'small',
              '',
              `${formatDate(run.createdAt)} · ${providers[run.provider]} · ${plural(run.fileCount, 'file')}`,
            ),
          );
          card.append(body, el('span', `badge ${run.status}`, capitalize(run.status)));
          return card;
        }),
    );
  }
}
function showFile() {
  const file = state?.generation?.files[selectedFile];
  text('code-path', file?.path ?? 'No files returned');
  text(
    'code-content',
    file?.content ?? 'No generated files were returned. Check the review notes and Activity.',
  );
  enable('copy-code', !!file);
  document
    .querySelectorAll<HTMLButtonElement>('[data-file-index]')
    .forEach((button) =>
      button.setAttribute(
        'aria-pressed',
        String(Number(button.dataset.fileIndex) === selectedFile),
      ),
    );
}
function renderActivity() {
  const entries = state?.activity ?? [];
  const log = $('activity-log');
  const signature = JSON.stringify(entries);
  if (log.dataset.signature === signature) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.dataset.signature = signature;
  log.replaceChildren(
    ...entries.slice(-100).map((entry) => {
      const row = el('div', 'activity-entry');
      row.append(el('time', '', formatDate(entry.time, true)), el('p', '', entry.message));
      return row;
    }),
  );
  if (!entries.length) log.append(el('p', 'field-hint', 'Workspace activity will appear here.'));
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function formatDate(value: string, timeOnly = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return timeOnly
    ? date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}
function setSubTab(group: 'editor' | 'result', tab: string) {
  const attr = group === 'editor' ? 'data-editor-tab' : 'data-result-tab';
  document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((button) => {
    const active = button.getAttribute(attr) === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $<HTMLElement>(button.getAttribute('aria-controls')!).hidden = !active;
  });
}
function focusField(id: string, tab?: typeof editorTab) {
  if (tab) {
    currentPage = 'editor';
    editorTab = tab;
    renderNavigation();
  }
  // Validation can finish while a save action still has the form disabled.
  window.setTimeout(() => {
    const node = document.getElementById(id);
    node?.closest('details')?.setAttribute('open', '');
    node?.focus();
  }, 0);
}
function invalid(message: string, id: string, tab?: typeof editorTab): never {
  focusField(id, tab);
  throw new Error(message);
}
function validateCase(): TestCase {
  if (!draft) throw new Error('Open a case first.');
  const result = clone(draft);
  result.name = result.name.trim();
  result.scenario.name = result.name;
  if (!result.name || result.name.length > 120)
    invalid('Give the case a name between 1 and 120 characters.', 'case-name', 'details');
  result.tags = [...new Set(result.tags.map((tag) => tag.trim()).filter(Boolean))];
  if (result.tags.length > 12 || result.tags.some((tag) => tag.length > 40))
    invalid('Use up to 12 tags, with no more than 40 characters per tag.', 'case-tags', 'details');
  for (const [index, event] of result.scenario.events.entries()) {
    if (event.action === 'navigate' || event.action === 'popup') {
      try {
        const url = new URL(event.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        invalid(
          `Step ${index + 1} needs a complete HTTP or HTTPS URL.`,
          `step-${index}-url`,
          'steps',
        );
      }
    }
    if (!['navigate', 'popup', 'note'].includes(event.action) && !event.locators.length)
      invalid(`Add a locator to step ${index + 1}.`, `step-${index}-label`, 'steps');
    for (const [locatorIndex, locator] of event.locators.entries()) {
      if (!locator.value.trim())
        invalid(
          `Locator ${locatorIndex + 1} in step ${index + 1} needs a value.`,
          `step-${index}-locator-${locatorIndex}-value`,
          'steps',
        );
    }
  }
  for (const [index, assertion] of result.scenario.assertions.entries()) {
    if (
      (assertion.kind === 'text' || assertion.kind === 'visible') &&
      !assertion.locator?.value.trim()
    )
      invalid(
        `Expectation ${index + 1} needs a locator value.`,
        `assertion-${index}-value`,
        'expectations',
      );
    if (assertion.kind === 'url' && !assertion.expected.trim())
      invalid(
        `Expectation ${index + 1} needs an expected outcome.`,
        `assertion-${index}-expected`,
        'expectations',
      );
    if (assertion.kind === 'custom' && !assertion.expected.trim() && !assertion.description.trim())
      invalid(
        `Describe the outcome for expectation ${index + 1}.`,
        `assertion-${index}-description`,
        'expectations',
      );
    assertion.source = 'user';
  }
  result.updatedAt = new Date().toISOString();
  return result;
}
async function saveDraft(force = false) {
  if (!draft || (!caseDirty && !force)) return;
  const saved = validateCase();
  const next = await callState(() => api!.saveCase(saved));
  caseDirty = false;
  retainedDrafts.delete(saved.id);
  draft = clone(
    state?.cases.find((item) => item.id === saved.id) ??
      next.cases.find((item) => item.id === saved.id) ??
      saved,
  );
  editorSignature = '';
  renderEditor(true);
  invalidatePrompt();
}
function resetDraft() {
  if (draft) retainedDrafts.delete(draft.id);
  draft = activeCase() ? clone(activeCase()!) : undefined;
  caseDirty = false;
  editorSignature = '';
  invalidatePrompt();
  render();
}
function validateSettings(): AgentSettings {
  const value = clone(settingsDraft);
  const time = Number(input('agent-timeout').value);
  if (!Number.isInteger(time) || time < 30 || time > 1800)
    invalid('Time per case must be a whole number from 30 to 1,800 seconds.', 'agent-timeout');
  value.timeoutSeconds = time;
  if (value.instructions.length > 8000)
    invalid('Custom instructions must be 8,000 characters or fewer.', 'agent-instructions');
  const budget = input('claude-budget').value.trim() ? Number(input('claude-budget').value) : 1;
  if (!Number.isFinite(budget) || budget < 0.01 || budget > 20)
    invalid('Budget per case must be between $0.01 and $20.', 'claude-budget');
  value.claudeBudgetUsd = budget;
  value.model = value.model.trim();
  return value;
}
async function saveSettingsDraft() {
  if (!settingsDirty) return;
  const saved = validateSettings();
  const next = await callState(() => api!.saveSettings(saved));
  settingsDirty = false;
  settingsDraft = clone(state?.settings ?? next.settings);
  settingsSignature = '';
  invalidatePrompt();
  renderSettings();
}
function resetSettings() {
  settingsDirty = false;
  settingsDraft = clone(state?.settings ?? defaults);
  settingsSignature = '';
  invalidatePrompt();
  renderSettings();
  renderControls();
}
function askConfirm(
  title: string,
  description: string,
  accept: string,
  action: () => void,
  cancel = 'Keep editing',
) {
  confirmAction = action;
  text('confirm-heading', title);
  text('confirm-description', description);
  text('confirm-accept', accept);
  text('confirm-cancel', cancel);
  dialog('confirm-dialog').showModal();
  $('confirm-cancel').focus();
}
function navigate(action: () => void | Promise<void>) {
  if (!idle()) {
    // Reading results and activity is allowed during a run; case mutations remain locked.
    if (!caseDirty) {
      void action();
      renderNavigation();
      renderControls();
    }
    return;
  }
  if (caseDirty) {
    try {
      validateCase();
    } catch (error) {
      askConfirm(
        'Keep your changes?',
        `${error instanceof Error ? error.message : error} Fix this before saving, or explicitly discard your changes to continue.`,
        'Discard & continue',
        () => {
          resetDraft();
          navigate(action);
        },
      );
      return;
    }
    void perform('Saving case', async () => {
      await saveDraft();
      await action();
    });
  } else {
    // Use the same action lock for native selections and project changes.
    void perform('Opening view', async () => {
      await action();
    });
  }
}
function openRecord() {
  if (!idle() || !state?.project) return;
  navigate(() => {
    input('record-name').value = '';
    input('start-url').value =
      state?.scenario?.startUrl ||
      draft?.scenario.startUrl ||
      (state?.project?.isDemo ? 'http://127.0.0.1:4318' : '');
    input('capture-screenshots').checked = false;
    show('screenshot-help', false);
    show('record-error', false);
    dialog('record-dialog').showModal();
    window.setTimeout(() => input('record-name').focus(), 0);
  });
}
function openSettings() {
  if (dialog('settings-dialog').open) return;
  savedFocus = document.activeElement as HTMLElement;
  renderSettings();
  renderControls();
  show('settings-error', false);
  dialog('settings-dialog').showModal();
}
function closeSettings() {
  if (settingsDirty) {
    if (!idle()) return;
    try {
      validateSettings();
    } catch (error) {
      askConfirm(
        'Keep these settings?',
        `${error instanceof Error ? error.message : error} Correct the value, or discard your changes to close settings.`,
        'Discard & close',
        () => {
          resetSettings();
          dialog('settings-dialog').close();
        },
      );
      return;
    }
    void perform('Saving settings', async () => {
      await saveSettingsDraft();
      dialog('settings-dialog').close();
    });
  } else dialog('settings-dialog').close();
}
function updateCommand() {
  show('custom-command', select('test-command').value === 'custom');
}
function getCommand(): TestCommand {
  if (select('test-command').value !== 'custom') {
    const command = state?.project?.commands[Number(select('test-command').value)];
    if (!command) throw new Error('Select a test command.');
    return clone(command);
  }
  const executable = input('command-executable').value.trim();
  if (!executable) invalid('Enter the executable, such as npm, npx, or mvn.', 'command-executable');
  let args: unknown;
  try {
    args = JSON.parse(input('command-args').value);
  } catch {
    invalid('Arguments must be a JSON array, such as ["run", "test"].', 'command-args');
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))
    invalid('Arguments must be an array of strings, such as ["run", "test"].', 'command-args');
  return { executable, args, label: 'Custom command' };
}

// Navigation and all native actions use the existing window.journey contract.
$('home-link').addEventListener('click', (event) => {
  event.preventDefault();
  navigate(() => {
    currentPage = 'cases';
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) =>
  button.addEventListener('click', () => {
    const page = button.dataset.page as typeof currentPage;
    navigate(() => {
      currentPage = page;
    });
  }),
);
['open-project', 'rail-project'].forEach((id) =>
  $(id).addEventListener('click', () => {
    if (!idle()) return;
    navigate(async () => {
      await saveSettingsDraft();
      await callState(() => api!.chooseProject());
      currentPage = 'cases';
    });
  }),
);
$('load-demo').addEventListener('click', () => {
  if (!idle()) return;
  navigate(async () => {
    await callState(() => api!.loadDemo());
    currentPage = 'cases';
    toast('Three cases, ready to explore. Select them to generate a suite.');
  });
});
['record-button', 'empty-record'].forEach((id) => $(id).addEventListener('click', openRecord));
['close-record', 'cancel-record'].forEach((id) =>
  $(id).addEventListener('click', () => {
    if (!pending) dialog('record-dialog').close();
  }),
);
dialog('record-dialog').addEventListener('cancel', (event) => {
  if (pending) event.preventDefault();
});
input('capture-screenshots').addEventListener('change', () =>
  show('screenshot-help', input('capture-screenshots').checked),
);
$('record-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!idle()) return;
  const url = input('start-url').value.trim();
  const name = input('record-name').value.trim();
  try {
    if (!name || name.length > 120)
      invalid('Enter a case name between 1 and 120 characters.', 'record-name');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      invalid('Enter a complete HTTP or HTTPS starting URL.', 'start-url');
    }
  } catch (error) {
    report(error, 'Check the recording details');
    return;
  }
  void perform('Starting recording', async () => {
    await callState(() =>
      api!.startRecording({
        url,
        name,
        captureScreenshots: input('capture-screenshots').checked,
      }),
    );
    dialog('record-dialog').close();
    currentPage = 'editor';
    editorTab = 'steps';
  });
});
$('stop-recording').addEventListener('click', async () => {
  if (!api || pending || state?.phase !== 'recording') return;
  pending = 'Stopping recording';
  renderControls();
  try {
    await callState(() => api.stopRecording());
  } catch (error) {
    report(error, 'Recording couldn’t stop');
  } finally {
    pending = '';
    render();
  }
});
input('case-search').addEventListener('input', () => {
  renderLibrary();
  renderControls();
});
document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((button) =>
  button.addEventListener('click', () => {
    filter = button.dataset.filter as typeof filter;
    renderLibrary();
    renderControls();
  }),
);
$('clear-filters').addEventListener('click', () => {
  filter = 'all';
  input('case-search').value = '';
  renderLibrary();
  renderControls();
  input('case-search').focus();
});
input('select-all-cases').addEventListener('change', () => {
  if (!idle()) return;
  const cases = visibleCases().filter((item) => item.enabled);
  if (input('select-all-cases').checked) {
    for (const item of cases) {
      if (selectedIds.size >= 20) break;
      selectedIds.add(item.id);
    }
    if (cases.some((item) => !selectedIds.has(item.id))) toast('Selected up to the 20-case limit.');
  } else cases.forEach((item) => selectedIds.delete(item.id));
  renderLibrary();
  renderControls();
});
$('clear-selection').addEventListener('click', () => {
  if (!idle()) return;
  selectedIds.clear();
  renderLibrary();
  renderControls();
});
$('case-name').addEventListener('input', () => {
  if (idle() && draft) {
    draft.name = input('case-name').value;
    changedCase();
  }
});
$('case-kind').addEventListener('change', () => {
  if (idle() && draft) {
    draft.kind = select('case-kind').value as CaseKind;
    changedCase();
  }
});
$('case-priority').addEventListener('change', () => {
  if (idle() && draft) {
    draft.priority = select('case-priority').value as TestCase['priority'];
    changedCase();
  }
});
$('case-tags').addEventListener('input', () => {
  if (idle() && draft) {
    draft.tags = input('case-tags')
      .value.split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    changedCase();
  }
});
$('case-enabled').addEventListener('change', () => {
  if (idle() && draft) {
    draft.enabled = input('case-enabled').checked;
    changedCase();
  }
});
$('save-case').addEventListener(
  'click',
  () =>
    void perform('Saving case', async () => {
      await saveDraft();
      toast('Case saved.');
    }),
);
$('discard-case').addEventListener('click', () => {
  if (idle())
    askConfirm(
      'Discard these changes?',
      'This restores the last saved version of this case.',
      'Discard changes',
      () => {
        resetDraft();
        toast('Restored the saved case.');
      },
    );
});
function addAssertion() {
  if (!idle() || !draft) return;
  draft.scenario.assertions.push({
    id: crypto.randomUUID(),
    kind: 'text',
    locator: { strategy: 'testId', value: '' },
    expected: '',
    description: '',
    source: 'user',
  });
  changedCase();
  editorTab = 'expectations';
  renderAssertions();
  renderNavigation();
  renderControls();
  input(`assertion-${draft.scenario.assertions.length - 1}-value`).focus();
}
['add-assertion', 'empty-assertion'].forEach((id) => $(id).addEventListener('click', addAssertion));
$('review-expectations').addEventListener('click', () => {
  editorTab = 'expectations';
  renderNavigation();
  $('tab-expectations').focus();
});
document.querySelectorAll<HTMLButtonElement>('[data-duplicate]').forEach((button) =>
  button.addEventListener('click', () => {
    if (!idle() || !draft) return;
    const id = draft.id;
    const kind = button.dataset.duplicate as CaseKind;
    $<HTMLDetailsElement>('case-menu').open = false;
    void perform('Duplicating case', async () => {
      await saveDraft();
      await callState(() => api!.duplicateCase({ id, kind }));
      currentPage = 'editor';
      editorTab = 'expectations';
      toast(`${capitalize(kind)} copy created. Review its inputs and expectations.`);
    });
  }),
);
$('delete-case').addEventListener('click', () => {
  if (!idle() || !draft) return;
  const item = clone(draft);
  $<HTMLDetailsElement>('case-menu').open = false;
  askConfirm(
    'Delete this case?',
    `“${item.name}” will be removed from the library${caseDirty ? ', including your unsaved changes' : ''}. Other cases are unaffected.`,
    'Delete case',
    () => {
      void perform('Deleting case', async () => {
        await callState(() => api!.deleteCase({ id: item.id }));
        retainedDrafts.delete(item.id);
        selectedIds.delete(item.id);
        if (draft?.id === item.id) {
          caseDirty = false;
          draft = undefined;
          editorSignature = '';
        }
        currentPage = 'cases';
        toast('Case deleted.');
      });
    },
    'Keep case',
  );
});
$('generate').addEventListener('click', () => {
  if (!idle()) return;
  const ids = generationIds();
  void perform('Generating tests', async () => {
    if (!ids.length || ids.length > 20)
      throw new Error('Select between 1 and 20 cases to generate.');
    // Persist edits before the service reads cases to construct its generation prompt.
    await saveDraft(true);
    await saveSettingsDraft();
    for (const id of ids) {
      const item = state?.cases.find((item) => item.id === id);
      if (!item?.enabled) throw new Error('Every selected case must be enabled.');
      if (!item.scenario.assertions.length)
        throw new Error(`Add an expectation to “${item.name}” before generation.`);
    }
    const settings = state!.settings;
    currentPage = 'results';
    resultTab = 'generated';
    renderNavigation();
    await callState(() =>
      api!.generate({
        mode: settings.provider,
        ...(settings.model ? { model: settings.model } : {}),
        caseIds: ids,
      }),
    );
    if (state?.generation?.files.length) toast('Tests generated. Review the code, then verify.');
  });
});
$('import-suite').addEventListener('click', () => {
  if (idle())
    navigate(async () => {
      await callState(() => api!.importSuite());
      currentPage = 'cases';
    });
});
$('export-suite').addEventListener(
  'click',
  () =>
    void perform('Exporting suite', async () => {
      await saveDraft();
      const path = await api!.exportSuite();
      if (path) toast(`Suite exported to ${path}`);
    }),
);
$('results-to-cases').addEventListener('click', () =>
  navigate(() => {
    currentPage = 'cases';
  }),
);
$('test-command').addEventListener('change', updateCommand);
$('verify').addEventListener(
  'click',
  () =>
    void perform('Running verification', async () => {
      const command = getCommand();
      const repeats = Number(select('verify-repeats').value);
      if (![1, 2, 3].includes(repeats)) throw new Error('Choose between 1 and 3 runs.');
      resultTab = 'verification';
      renderNavigation();
      await callState(() => api!.verify({ command, repeats }));
    }),
);
$('export-bundle').addEventListener(
  'click',
  () =>
    void perform('Exporting results', async () => {
      const path = await api!.exportBundle();
      if (path) {
        text('export-result', `Exported to ${path}`);
        show('export-result', true);
        toast('Results exported.');
      }
    }),
);
$('reveal-workspace').addEventListener(
  'click',
  () => void perform('Opening workspace', () => api!.revealWorkspace()),
);
$('cancel-run').addEventListener('click', async () => {
  if (!api || cancelling) return;
  cancelling = true;
  renderControls();
  try {
    await callState(() => api.cancelRun());
  } catch (error) {
    report(error, 'Cancellation couldn’t finish');
  } finally {
    cancelling = false;
    render();
  }
});
$('copy-code').addEventListener('click', async () => {
  const file = state?.generation?.files[selectedFile];
  if (!file) return;
  try {
    await navigator.clipboard.writeText(file.content);
    toast('Code copied.');
  } catch {
    report('Select the code and press ⌘C, or export the results.', 'The code couldn’t be copied');
  }
});
$('open-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
dialog('settings-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeSettings();
});
dialog('settings-dialog').addEventListener('close', () => savedFocus?.focus());
select('generator-mode').addEventListener('change', () => {
  settingsDraft.provider = select('generator-mode').value as AgentProvider;
  changedSettings();
});
input('model-name').addEventListener('input', () => {
  settingsDraft.model = input('model-name').value;
  changedSettings();
});
select('agent-effort').addEventListener('change', () => {
  settingsDraft.effort = select('agent-effort').value as AgentSettings['effort'];
  changedSettings();
});
input('agent-timeout').addEventListener('input', () => {
  settingsDraft.timeoutSeconds = Number(input('agent-timeout').value);
  changedSettings();
});
input('claude-budget').addEventListener('input', () => {
  settingsDraft.claudeBudgetUsd = Number(input('claude-budget').value);
  changedSettings();
});
$('agent-instructions').addEventListener('input', () => {
  settingsDraft.instructions = $<HTMLTextAreaElement>('agent-instructions').value;
  changedSettings();
});
$('save-settings').addEventListener(
  'click',
  () =>
    void perform('Saving settings', async () => {
      await saveSettingsDraft();
      toast('Agent settings saved.');
    }),
);
$('discard-settings').addEventListener('click', () => {
  if (idle()) {
    resetSettings();
    show('settings-error', false);
    toast('Restored the saved settings.');
  }
});
$('refresh-agents').addEventListener(
  'click',
  () =>
    void perform('Checking agents', async () => {
      await callState(() => api!.refreshAgents());
      toast('Agent availability refreshed.');
    }),
);
$('reset-agent-session').addEventListener('click', () => {
  const item = activeCase();
  const provider = settingsDraft.provider;
  const session = selectedAgentSession();
  if (!item || provider === 'portable' || !session || session.status === 'running') return;
  void perform('Starting fresh session', async () => {
    await callState(() => api!.resetAgentSession({ caseId: item.id, provider }));
    invalidatePrompt();
    toast(
      `${providers[provider]} will start fresh on the next generation. Old native history is kept.`,
    );
  });
});
$('add-context-files').addEventListener(
  'click',
  () =>
    void perform('Adding context files', async () => {
      await saveSettingsDraft();
      await callState(() => api!.chooseContextFiles());
      invalidatePrompt();
    }),
);
$('preview-prompt').addEventListener(
  'click',
  () =>
    void perform('Preparing prompt preview', async () => {
      await saveDraft(true);
      await saveSettingsDraft();
      const prompt = await api!.previewPrompt({ caseId: draft?.id });
      text('prompt-preview', prompt);
      show('prompt-preview', true);
      text(
        'prompt-help',
        `Exact prompt for “${draft?.name ?? 'the active case'}”, using saved settings and included context.`,
      );
    }),
);
$('confirm-accept').addEventListener('click', () => {
  const action = confirmAction;
  confirmAction = undefined;
  dialog('confirm-dialog').close();
  action?.();
});
$('confirm-cancel').addEventListener('click', () => {
  confirmAction = undefined;
  dialog('confirm-dialog').close();
});
dialog('confirm-dialog').addEventListener('cancel', () => {
  confirmAction = undefined;
});
$('dismiss-error').addEventListener('click', () => {
  dismissedError = state?.error ?? '';
  show('error-banner', false);
});
function toggleActivity(open: boolean) {
  show('activity-panel', open);
  $('activity-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('activity-log').scrollTop = $('activity-log').scrollHeight;
}
$('activity-toggle').addEventListener('click', () => toggleActivity($('activity-panel').hidden));
$('close-activity').addEventListener('click', () => {
  toggleActivity(false);
  $('activity-toggle').focus();
});
for (const group of ['editor', 'result'] as const) {
  const attr = group === 'editor' ? 'data-editor-tab' : 'data-result-tab';
  document.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((button) => {
    button.addEventListener('click', () => {
      if (group === 'editor') editorTab = button.getAttribute(attr) as typeof editorTab;
      else resultTab = button.getAttribute(attr) as typeof resultTab;
      setSubTab(group, button.getAttribute(attr)!);
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(`[${attr}]`));
      const index = tabs.indexOf(button);
      const target =
        event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs[tabs.length - 1]
            : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      target.click();
      target.focus();
    });
  });
}
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === ',') {
    event.preventDefault();
    openSettings();
  }
  if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (dialog('settings-dialog').open) $('save-settings').click();
    else if (caseDirty) $('save-case').click();
  }
  if (event.key.toLowerCase() === 'f' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    navigate(() => {
      currentPage = 'cases';
      window.setTimeout(() => input('case-search').focus(), 0);
    });
  }
});
document.addEventListener('click', (event) => {
  if (event.target instanceof Node && !$('case-menu').contains(event.target))
    $<HTMLDetailsElement>('case-menu').open = false;
});
window.addEventListener('beforeunload', () => unsubscribe?.());
async function connect() {
  render();
  if (!api) {
    report(
      'Open Testloom in the desktop app to connect to your workspace.',
      'Desktop connection unavailable',
    );
    return;
  }
  try {
    unsubscribe = api.onUpdate((next) => {
      streamVersion++;
      receive(next);
    });
    const version = streamVersion;
    const initial = await api.getState();
    if (streamVersion === version) receive(initial);
  } catch (error) {
    report(error, 'The workspace couldn’t connect');
  }
}
void connect();
