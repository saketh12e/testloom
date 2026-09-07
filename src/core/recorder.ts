import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import type { InteractionEvent, LocatorSpec, Scenario } from '../shared/types.js';

type Result = { events: InteractionEvent[]; network: Scenario['network']; warnings: string[] };
type Packet = Pick<
  InteractionEvent,
  'action' | 'url' | 'label' | 'locators' | 'value' | 'redacted'
> & {
  warning?: string;
};
type RecorderOptions = {
  artifactDir: string;
  onEvent: (event: InteractionEvent) => void;
  onWarning?: (warning: string) => void;
};

const ACTIONS = new Set([
  'navigate',
  'click',
  'fill',
  'check',
  'uncheck',
  'select',
  'press',
  'popup',
  'note',
]);
const STRATEGIES = new Set(['testId', 'role', 'label', 'placeholder', 'text', 'css']);
function validPacket(input: unknown): input is Packet {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const p = input as Record<string, unknown>;
  const string = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && value.length <= limit;
  if (
    Object.keys(p).some(
      (key) =>
        !['action', 'url', 'label', 'locators', 'value', 'redacted', 'warning'].includes(key),
    )
  )
    return false;
  if (
    !string(p.action, 16) ||
    !ACTIONS.has(p.action) ||
    !string(p.url, 8192) ||
    !string(p.label, 512)
  )
    return false;
  if (
    (p.value !== undefined && !string(p.value, 8192)) ||
    (p.warning !== undefined && !string(p.warning, 512)) ||
    (p.redacted !== undefined && typeof p.redacted !== 'boolean')
  )
    return false;
  if (
    !Array.isArray(p.locators) ||
    p.locators.length > 8 ||
    (!['navigate', 'popup', 'note'].includes(p.action) && !p.locators.length)
  )
    return false;
  if (
    p.action === 'press' &&
    (!string(p.value, 128) ||
      !/^(?:(?:Control|Alt|Meta|Shift)\+)*(?:Enter|Tab|Escape|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(
        p.value,
      ))
  )
    return false;
  return p.locators.every((locator: unknown) => {
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) return false;
    const l = locator as Record<string, unknown>;
    return (
      Object.keys(l).every((key) => ['strategy', 'value', 'name'].includes(key)) &&
      string(l.strategy, 16) &&
      STRATEGIES.has(l.strategy) &&
      string(l.value, 2048) &&
      !!l.value &&
      (l.name === undefined || string(l.name, 512))
    );
  });
}

async function withinDeadline(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only origin and path enter the recording; never credentials, queries or fragments. */
function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}` : '';
  } catch {
    return '';
  }
}

// This function runs in the page. Keep it self-contained; sensitive values must
// be removed here, before exposeBinding sends any event to the native process.
function installRecorder(binding: string, control: string, nonce: string): void {
  const host = window as unknown as Record<string, unknown>;
  if (host[control]) return;
  // Capture before application scripts run. Looking up the global on each send
  // would let a page replace it with a wrapper that steals the closure's nonce.
  const bridge = host[binding] as (nonce: string, packet: Packet) => Promise<unknown>;
  let active = true;
  const inFrame = window.top !== window;
  const inFlight = new Set<Promise<unknown>>();
  const pending = new Map<Element, Packet>();
  const previous = new WeakMap<Element, string>();
  const warned = new Set<string>();
  let keyboardActivation = false;
  const sensitive =
    /password|passwd|passphrase|secret|token|api.?key|authorization|credential|email|e-mail|card|credit|debit|cvv|cvc|cc-|ssn|social.security|otp|one.time|pin\b|phone|mobile|address|birth|iban|account/i;
  const privateValue = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\d[ -]?){13,19}|\beyJ[A-Za-z0-9_-]+\./;
  const clean = (value: string): string =>
    value
      .replace(/https?:\/\/[^\s]+/g, (raw) => {
        try {
          const u = new URL(raw);
          return `${u.origin}${u.pathname}`;
        } catch {
          return '[redacted URL]';
        }
      })
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[REDACTED]')
      .replace(/(?:\d[ -]?){13,19}/g, '[REDACTED]')
      .slice(0, 200);
  const url = (): string =>
    /^https?:$/.test(location.protocol) ? `${location.origin}${location.pathname}` : '';
  const send = (packet: Packet): void => {
    if (!active) return;
    if (inFlight.size >= 64) {
      active = false;
      pending.clear();
      const warning = 'Page event buffer limit reached; the recording is truncated.';
      void bridge(nonce, {
        action: 'note',
        url: url(),
        label: warning,
        locators: [],
        warning,
      }).catch(() => undefined);
      return;
    }
    const promise = bridge(nonce, packet).catch(() => undefined);
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  };
  const warn = (warning: string): void => {
    if (warned.has(warning)) return;
    warned.add(warning);
    send({ action: 'note', url: url(), label: warning, locators: [], warning });
  };
  const flush = (): void => {
    for (const packet of pending.values()) send(packet);
    pending.clear();
  };
  const stop = async (token: unknown): Promise<boolean> => {
    if (token !== nonce) return false;
    flush();
    active = false;
    await Promise.all([...inFlight]);
    return true;
  };
  Object.defineProperty(host, control, {
    value: stop,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  if (inFrame) {
    warn('Frames are unsupported; interactions inside frames require manual recording.');
    return;
  }
  const target = (event: Event): Element | undefined =>
    event.composedPath().find((item) => item instanceof Element) as Element | undefined;
  const field = (el: Element): boolean =>
    el.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  const isSensitive = (el: Element): boolean => {
    const labels =
      'labels' in el
        ? Array.from((el as HTMLInputElement).labels ?? [])
            .map((l) => l.textContent)
            .join(' ')
        : '';
    return (
      sensitive.test(
        ['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder', 'data-testid']
          .map((key) => el.getAttribute(key) ?? '')
          .join(' ') + labels,
      ) || !!el.closest('[data-sensitive],[data-private],[data-redact]')
    );
  };
  const describe = (el: Element, action: InteractionEvent['action'], value?: string): Packet => {
    const redacted = isSensitive(el) || (value !== undefined && privateValue.test(value));
    const locators: LocatorSpec[] = [];
    const safe = (text: string): boolean =>
      !!text &&
      !privateValue.test(text) &&
      !/https?:\/\//.test(text) &&
      !(redacted && value && text.includes(value));
    const testId = el.getAttribute('data-testid');
    if (testId && safe(testId)) locators.push({ strategy: 'testId', value: testId });
    const associated =
      'labels' in el
        ? Array.from((el as HTMLInputElement).labels ?? [])
            .map((l) => l.textContent ?? '')
            .join(' ')
            .trim()
        : '';
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    const name =
      el.getAttribute('aria-label') ||
      labelledBy ||
      associated ||
      (!field(el) ? (el.textContent ?? '').trim() : '');
    let role = el.getAttribute('role') ?? '';
    if (!role) {
      if (el.matches('button,input[type="button"],input[type="submit"]')) role = 'button';
      else if (el.matches('a[href]')) role = 'link';
      else if (el.matches('input[type="checkbox"]')) role = 'checkbox';
      else if (el.matches('input[type="radio"]')) role = 'radio';
      else if (el.matches('select'))
        role = (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
      else if (
        el.matches(
          'textarea,input:not([type]),input[type="text"],input[type="email"],input[type="tel"],input[type="url"]',
        )
      )
        role = 'textbox';
    }
    // An unnamed role such as "textbox" is ambiguous and must not outrank CSS.
    if (role && !redacted && safe(name))
      locators.push({ strategy: 'role', value: role, name: clean(name) });
    if (!redacted && safe(associated))
      locators.push({ strategy: 'label', value: clean(associated) });
    // Structural CSS never contains a user's input value or an href with secrets.
    const path: string[] = [];
    let node: Element | null = el;
    while (node && path.length < 12) {
      const id = node.getAttribute('id');
      if (id && safe(id)) {
        path.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const siblings: Element[] = node.parentElement
        ? Array.from(node.parentElement.children).filter((s) => s.tagName === node!.tagName)
        : [];
      path.unshift(
        `${node.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`,
      );
      node = node.parentElement;
    }
    locators.push({ strategy: 'css', value: path.join(' > ') });
    return {
      action,
      url: url(),
      label: redacted
        ? `${action} sensitive field`
        : `${action} ${clean(name || el.getAttribute('name') || el.localName)}`,
      locators,
      ...(value !== undefined ? { value: redacted ? '[REDACTED]' : value } : {}),
      ...(redacted ? { redacted: true } : {}),
    };
  };
  const captureValue = (el: Element, fromInput = false): void => {
    if (el.matches('input[type="file"]')) {
      warn('File uploads are unsupported; choose and verify files manually.');
      return;
    }
    if (!field(el)) return;
    if (el.matches('input[type="checkbox"],input[type="radio"]')) {
      flush();
      const checked = (el as HTMLInputElement).checked;
      const state = String(checked);
      if (previous.get(el) !== state) send(describe(el, checked ? 'check' : 'uncheck'));
      previous.set(el, state);
      return;
    }
    if (el.matches('select[multiple]')) {
      warn('Multiple selection is unsupported; review selected options manually.');
      return;
    }
    const value = el.matches('input,textarea,select')
      ? (el as HTMLInputElement).value
      : (el.textContent ?? '');
    // Store only the redacted representation in our deduplication ledger.
    const packet = describe(el, el.matches('select') ? 'select' : 'fill', value);
    const signature = `${packet.action}:${packet.value}`;
    if (previous.get(el) === signature && !(fromInput && packet.redacted)) return;
    previous.set(el, signature);
    for (const [other, prior] of pending)
      if (other !== el) {
        send(prior);
        pending.delete(other);
      }
    pending.set(el, packet);
    if (el.matches('select')) flush();
  };
  document.addEventListener(
    'input',
    (event) => {
      if (!active || !event.isTrusted) return;
      const el = target(event);
      if (el) captureValue(el, true);
    },
    true,
  );
  document.addEventListener(
    'change',
    (event) => {
      if (!active || !event.isTrusted) return;
      const el = target(event);
      if (el) captureValue(el);
      flush();
    },
    true,
  );
  document.addEventListener('focusout', () => flush(), true);
  document.addEventListener(
    'pointerdown',
    () => {
      keyboardActivation = false;
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!active || !event.isTrusted) return;
      flush();
      // Enter/Space already replay the browser's generated activation click.
      if (event.detail === 0 && keyboardActivation) {
        keyboardActivation = false;
        return;
      }
      const raw = target(event);
      if (!raw) return;
      if (raw.closest('canvas')) {
        warn('Canvas interactions are unsupported; add manual steps.');
        return;
      }
      if (raw.matches('input[type="file"]')) {
        warn('File uploads are unsupported; choose and verify files manually.');
        return;
      }
      // Focus clicks and native control activation are represented by their value/change event.
      const label = raw.closest('label') as HTMLLabelElement | null;
      if (field(raw) || label?.control) return;
      const el = raw.closest('button,a,[role="button"],[role="link"],[data-testid]') ?? raw;
      send(describe(el, 'click'));
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (!active || !event.isTrusted || event.isComposing || event.repeat) return;
      keyboardActivation = false;
      const el = target(event);
      if (!el) return;
      // Printable keys, deletion and editing shortcuts are already captured as fills.
      const spaceActivation =
        event.key === ' ' && el.matches('button,a,[role="button"],[role="link"]');
      if (
        !spaceActivation &&
        ![
          'Enter',
          'Tab',
          'Escape',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      )
        return;
      if (
        el.matches('select,input[type="checkbox"],input[type="radio"]') &&
        !['Tab', 'Escape'].includes(event.key)
      )
        return;
      if (field(el) && !['Enter', 'Tab', 'Escape'].includes(event.key)) return;
      flush();
      keyboardActivation = event.key === 'Enter' || spaceActivation;
      const key = [
        event.ctrlKey && 'Control',
        event.altKey && 'Alt',
        event.metaKey && 'Meta',
        event.shiftKey && 'Shift',
        spaceActivation ? 'Space' : event.key,
      ]
        .filter(Boolean)
        .join('+');
      const packet = describe(el, 'press');
      packet.value = key; // A semantic key name is safe even for a password field.
      send(packet);
    },
    true,
  );
  for (const event of ['dragstart', 'drop'])
    document.addEventListener(
      event,
      () => {
        if (!active) return;
        flush();
        warn('Drag and drop is unsupported; add manual steps.');
      },
      true,
    );
  window.addEventListener('pagehide', flush, true);
  window.addEventListener('beforeunload', flush, true);
  // Flush a pending edit before script-driven navigation as well as link clicks.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (...args: Parameters<History[typeof method]>) {
      flush();
      return original.apply(this, args);
    };
  }
}

/**
 * Records a fresh, non-persistent browser context without bodies, headers or cookies.
 * Screenshots are opt-in. All form fields, editable content, frames and explicitly
 * sensitive regions are masked, but screenshots may still contain visible data
 * (for example personal text, images, or an unmarked account summary). Review them
 * before sharing. They are observations taken after an action, not replay proof.
 */
export class BrowserRecorder {
  private browser?: Browser;
  private context?: BrowserContext;
  private mainPage?: Page;
  private state: 'idle' | 'starting' | 'recording' | 'stopping' | 'stopped' = 'idle';
  private accepting = false;
  private screenshots = false;
  private events: InteractionEvent[] = [];
  private network: Scenario['network'] = [];
  private warnings: string[] = [];
  private pages = new WeakMap<Page, string>();
  private pageCount = 0;
  private requests = new WeakMap<Request, Scenario['network'][number]>();
  private queue: Promise<void> = Promise.resolve();
  private starting?: Promise<void>;
  private stopping?: Promise<Result>;
  private control = '';
  private nonce = '';
  private sequence = 0;

  constructor(private readonly options: RecorderOptions) {}

  get page(): Page {
    if (!this.mainPage) throw new Error('Recording browser is not open.');
    return this.mainPage;
  }

  async start(
    url: string,
    options: { headless?: boolean; captureScreenshots?: boolean } = {},
  ): Promise<void> {
    if (this.state === 'starting' || this.state === 'recording' || this.state === 'stopping')
      throw new Error('A recording is already active.');
    if (!normalizedUrl(url)) throw new Error('Recording requires an HTTP or HTTPS URL.');
    this.state = 'starting';
    this.accepting = true;
    this.events = [];
    this.network = [];
    this.warnings = [];
    this.pages = new WeakMap();
    this.pageCount = 0;
    this.requests = new WeakMap();
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.stopping = undefined;
    this.screenshots = options.captureScreenshots === true;
    const suffix = randomUUID().replaceAll('-', '');
    this.control = `__journeyproof_stop_${suffix}`;
    this.nonce = randomBytes(32).toString('hex');
    this.starting = this.launch(url, options.headless ?? false, `__journeyproof_event_${suffix}`);
    return this.starting;
  }

  private async launch(url: string, headless: boolean, binding: string): Promise<void> {
    try {
      const testPort =
        process.env.JOURNEYPROOF_E2E === '1' &&
        /^\d{4,5}$/.test(process.env.JOURNEYPROOF_CDP_PORT || '')
          ? process.env.JOURNEYPROOF_CDP_PORT
          : undefined;
      try {
        this.browser = await chromium.launch({
          headless,
          ...(testPort ? { args: [`--remote-debugging-port=${testPort}`] } : {}),
        });
      } catch (error) {
        if (this.state === 'stopping') throw new Error('Recording cancelled.');
        if (
          !/executable.*(doesn.t exist|not found)|browser.*not found|please run.*playwright install/is.test(
            String(error),
          )
        )
          throw error;
        this.warn(
          'Playwright Chromium is missing; using installed Google Chrome in a fresh context.',
        );
        this.browser = await chromium.launch({ channel: 'chrome', headless });
      }
      this.checkCancelled();
      this.context = await this.browser.newContext({ acceptDownloads: false });
      this.checkCancelled();
      if (this.screenshots) {
        await mkdir(this.options.artifactDir, { recursive: true, mode: 0o700 });
        this.warn(
          'Screenshots are enabled and may still contain visible data despite masking. Review before sharing.',
        );
      }
      this.context.on('page', (page) => this.attach(page));
      this.context.on('request', (request) => {
        if (!this.accepting) return;
        if (this.network.length >= 2000) {
          this.warn('Network limit of 2000 reached; the network ledger is truncated.');
          return;
        }
        const url = normalizedUrl(request.url());
        if (!url) return;
        if (url.length > 8192 || request.method().length > 32) {
          this.warn('Oversized network metadata was omitted; the network ledger is incomplete.');
          return;
        }
        const entry = { method: request.method(), url, status: 0 };
        this.requests.set(request, entry);
        this.network.push(entry);
      });
      this.context.on('response', (response) => {
        if (!this.accepting) return;
        const entry = this.requests.get(response.request());
        if (entry) entry.status = response.status();
      });
      this.context.on('requestfailed', () => {
        if (this.accepting)
          this.warn(
            'A network request failed; status 0 means no response was received before recording stopped.',
          );
      });
      await this.context.exposeBinding(
        binding,
        ({ page, frame }, token: unknown, packet: unknown) => {
          if (!this.accepting) return;
          if (typeof token !== 'string' || token !== this.nonce) {
            this.warn('An unauthenticated recorder bridge call was rejected.');
            return;
          }
          if (!validPacket(packet)) {
            this.warn(
              'An invalid or oversized recorder packet was rejected; the recording is incomplete.',
            );
            return;
          }
          if (frame !== page.mainFrame()) {
            this.warn(
              'Frames are unsupported; interactions inside frames require manual recording.',
            );
            return;
          }
          if (packet.warning) this.warn(packet.warning);
          this.enqueue(page, packet);
        },
      );
      // esbuild/tsx may insert __name into serialized nested functions.
      await this.context.addInitScript({
        content: `(() => { const __name = (fn) => fn; (${installRecorder.toString()})(${JSON.stringify(binding)}, ${JSON.stringify(this.control)}, ${JSON.stringify(this.nonce)}); })();`,
      });
      this.checkCancelled();
      this.mainPage = await this.context.newPage();
      this.checkCancelled();
      await this.mainPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      this.checkCancelled();
      this.state = 'recording';
    } catch {
      const cancelled = this.state === 'stopping';
      this.accepting = false;
      await this.close();
      await this.queue;
      if (!cancelled) this.state = 'stopped';
      // Playwright errors may embed the original URL or page content.
      throw new Error(
        cancelled
          ? 'Recording cancelled.'
          : 'Could not start recording. Check the URL and install Chromium (npx playwright install chromium) or Google Chrome.',
      );
    }
  }

  private checkCancelled(): void {
    if (this.state === 'stopping') throw new Error('Recording cancelled.');
  }

  private attach(page: Page): void {
    if (this.pages.has(page)) return;
    const pageId = `page-${++this.pageCount}`;
    this.pages.set(page, pageId);
    if (this.pageCount > 1)
      this.enqueue(page, {
        action: 'popup',
        url: page.url(),
        label: 'New browser tab or popup',
        locators: [],
      });
    const navigation = (): void => {
      if (!normalizedUrl(page.url())) return;
      this.enqueue(page, { action: 'navigate', url: page.url(), label: 'Navigate', locators: [] });
    };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigation();
    });
    page.on('frameattached', () =>
      this.warn('Frames are unsupported; interactions inside frames require manual recording.'),
    );
    page.on('filechooser', () =>
      this.warn('File uploads are unsupported; choose and verify files manually.'),
    );
    page.on('download', () =>
      this.warn('Downloads are unsupported; verify downloaded files manually.'),
    );
    page.on('crash', () => this.warn('The recording page crashed; the journey is incomplete.'));
    page.on('close', () => {
      if (this.accepting && this.state !== 'stopping')
        this.warn('A recording tab was closed; uncommitted edits may be missing.');
    });
    if (normalizedUrl(page.url())) navigation();
  }

  private warn(warning: string): void {
    if (this.state === 'stopped') return;
    if (this.warnings.length >= 64) return;
    if (this.warnings.includes(warning)) return;
    this.warnings.push(warning);
    try {
      this.options.onWarning?.(warning);
    } catch {
      /* Consumer failures cannot break capture. */
    }
  }

  private enqueue(page: Page, packet: Packet): void {
    if (!this.accepting) return;
    if (!validPacket(packet)) {
      this.warn(
        'An invalid or oversized recorder packet was rejected; the recording is incomplete.',
      );
      return;
    }
    // Count reservations, not only completed callbacks: screenshot work is async.
    if (this.sequence >= 500) {
      this.warn('Event limit of 500 reached; the recording is truncated.');
      return;
    }
    const event: InteractionEvent = {
      id: randomUUID(),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      action: packet.action,
      url: normalizedUrl(packet.url),
      pageId: this.pages.get(page) ?? 'page-1',
      label: packet.label,
      locators: packet.locators,
      ...(packet.value !== undefined
        ? { value: packet.redacted && packet.action !== 'press' ? '[REDACTED]' : packet.value }
        : {}),
      ...(packet.redacted ? { redacted: true } : {}),
      ...(packet.warning ? { warnings: [packet.warning] } : {}),
    };
    this.queue = this.queue
      .then(async () => {
        if (this.screenshots && !page.isClosed()) {
          try {
            const mask = page.locator(
              'input,textarea,select,[contenteditable],iframe,frame,canvas,[data-sensitive],[data-private],[data-redact],[autocomplete],[class*="password" i],[class*="secret" i],[class*="token" i],[class*="email" i],[class*="account" i],[id*="password" i],[id*="secret" i],[id*="token" i],[id*="email" i],[id*="account" i]',
            );
            const path = join(
              this.options.artifactDir,
              `${String(event.sequence).padStart(5, '0')}-${event.id}.png`,
            );
            await page.screenshot({
              path,
              mask: [mask],
              maskColor: '#000000',
              animations: 'disabled',
              timeout: 3_000,
            });
            event.screenshot = path;
          } catch {
            this.warn('A masked screenshot could not be captured; that event has no screenshot.');
          }
        }
        this.events.push(event);
        try {
          this.options.onEvent(structuredClone(event));
        } catch {
          this.warn('An event callback failed; the event remains in the recording.');
        }
      })
      .catch(() =>
        this.warn('An event could not be processed; review the recording for missing steps.'),
      );
  }

  async stop(): Promise<Result> {
    if (this.stopping) return this.stopping;
    const wasStarting = this.state === 'starting';
    this.state = 'stopping';
    this.stopping = this.finish(wasStarting);
    return this.stopping;
  }

  private async finish(wasStarting: boolean): Promise<Result> {
    try {
      if (wasStarting) {
        this.accepting = false;
        await this.close();
        await this.starting?.catch(() => undefined);
      } else if (this.context) {
        // Page code cannot be trusted to settle, even with an immutable callback.
        const flushed = await withinDeadline(
          Promise.all(
            this.context
              .pages()
              .filter((page) => !page.isClosed())
              .map((page) =>
                page.evaluate(
                  async ({ control, nonce }) => {
                    const flush = (window as unknown as Record<string, unknown>)[control];
                    if (typeof flush !== 'function' || (await flush(nonce)) !== true)
                      throw new Error('Recorder flush unavailable');
                  },
                  { control: this.control, nonce: this.nonce },
                ),
              ),
          ),
          1500,
        );
        if (!flushed)
          this.warn(
            'Recorder flush did not complete within 1500ms; the recording is incomplete and final edits may be missing.',
          );
      }
      this.accepting = false;
      if (!(await withinDeadline(this.queue, 1500)))
        this.warn(
          'Recorder queue did not drain before cancellation; screenshots may be incomplete.',
        );
    } finally {
      this.accepting = false;
      await this.close();
      await this.queue;
    }
    this.state = 'stopped';
    return structuredClone({ events: this.events, network: this.network, warnings: this.warnings });
  }

  private async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    const browser = this.browser;
    this.browser = undefined;
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    this.mainPage = undefined;
  }
}
