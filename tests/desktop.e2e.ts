import { _electron as electron, chromium, type Page } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { AppState } from '../src/shared/types';
import { serializeSuite } from '../src/core/suite';

const root = await mkdtemp(path.join(tmpdir(), 'testloom-desktop-'));
const executable = process.env.TESTLOOM_EXECUTABLE || process.env.JOURNEYPROOF_EXECUTABLE;
const desktop = await electron.launch({
  ...(executable ? { executablePath: executable } : {}),
  args: executable ? [] : [path.resolve('.')],
  env: {
    ...process.env,
    TESTLOOM_DATA_DIR: root,
    JOURNEYPROOF_E2E: '1',
    JOURNEYPROOF_CDP_PORT: '9437',
  },
});
const errors: string[] = [];
async function state(page: Page): Promise<AppState> {
  return page.evaluate(() => (window as any).journey.getState());
}
async function settled(
  page: Page,
  condition: (s: AppState) => boolean = () => true,
  limit = 120_000,
): Promise<AppState> {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const current = await state(page);
    if (current.error) throw new Error(current.error);
    if (current.phase === 'idle' && condition(current)) return current;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Desktop operation exceeded its test deadline.');
}
try {
  const window = await desktop.firstWindow();
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('#load-demo:not([disabled])').waitFor();
  await mkdir('assets', { recursive: true });
  await window.screenshot({ path: 'assets/overview.png', style: '#toast { visibility: hidden; }' });
  assert.equal((await state(window)).settings.provider, 'codex');
  await window.locator('#load-demo').click();
  let current = await settled(window, (s) => s.cases.length === 3);
  await window.getByTestId('case-row').nth(2).waitFor();
  await window.screenshot({
    path: 'assets/case-library.png',
    style: '#toast { visibility: hidden; }',
  });
  const positive = current.cases[0],
    negative = current.cases[1];
  await window.locator(`[data-case-id="${negative.id}"]`).click();
  await window.locator('#tab-details').click();
  await window.locator('#case-name').fill('Expired coupon is rejected');
  await window.locator('#tab-steps').click();
  await window.getByTestId('recorded-step').nth(3).locator('summary').click();
  await window.locator('#step-3-value').fill('EXPIRED');
  await window.locator('#tab-expectations').click();
  await window
    .locator('#assertion-1-expected')
    .fill('Coupon EXPIRED has expired. No discount applied.');
  await window.locator('#save-case').click();
  current = await settled(
    window,
    (s) => s.cases.find((c) => c.id === negative.id)?.name === 'Expired coupon is rejected',
  );
  assert.equal(current.cases[0].scenario.events[3].value, 'SAVE10');
  await window.screenshot({
    path: 'assets/recorded-journey.png',
    style: '#toast { visibility: hidden; }',
  });
  await window.locator('#case-menu summary').click();
  await window.locator('[data-duplicate="negative"]').click();
  current = await settled(window, (s) => s.cases.length === 4);
  assert.equal(current.cases.at(-1)?.kind, 'negative');
  assert.deepEqual(current.cases.at(-1)?.scenario.assertions, current.cases[1].scenario.assertions);
  await window.locator('#open-settings').click();
  await window.locator('#generator-mode').selectOption('claude');
  await window.locator('#agent-effort').selectOption('high');
  await window.locator('#agent-timeout').fill('90');
  await window.locator('#claude-budget').fill('0.50');
  await window
    .locator('#agent-instructions')
    .fill('Use the existing project conventions. Keep all expected outcomes exact.');
  await window.locator('#save-settings').click();
  await settled(
    window,
    (s) => s.settings.provider === 'claude' && s.settings.timeoutSeconds === 90,
  );
  await window.locator('#preview-prompt').click();
  await window.locator('#prompt-preview').filter({ hasText: 'EXPIRED' }).waitFor();
  await window.locator('.drawer-body').evaluate((node) => {
    node.scrollTop = 0;
  });
  await window.screenshot({
    path: 'assets/agent-controls.png',
    style: '#toast { visibility: hidden; }',
  });
  await window.locator('#generator-mode').selectOption('portable');
  await window.locator('#save-settings').click();
  await settled(window, (s) => s.settings.provider === 'portable');
  await window.locator('#close-settings').click();
  await window.locator('#nav-cases').click();
  await window.locator('#case-search').fill('Expired');
  assert.equal(await window.getByTestId('case-row').count(), 2);
  await window.locator('#case-search').fill('');
  for (const c of current.cases.slice(0, 3))
    await window.locator(`[data-select-case="${c.id}"]`).check();
  await window.locator('#generate').click();
  await settled(window, (s) => s.generation?.files.length === 3);
  await window.locator('#tab-verification').click();
  await window.locator('#verify').click();
  current = await settled(window, (s) => !!s.verification);
  assert.equal(current.verification?.status, 'passed');
  assert.equal(current.verification?.runs.length, 2);
  assert.equal(current.verification?.discoveredTests?.length, 3);
  await window.screenshot({
    path: 'assets/verified-journey.png',
    style: '#toast { visibility: hidden; }',
  });
  const exportRoot = path.join(root, 'exports');
  await mkdir(exportRoot);
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as typeof dialog.showOpenDialog;
  }, exportRoot);
  await window.locator('#export-bundle').click();
  await window.locator('#export-result').filter({ hasText: 'Exported to' }).waitFor();
  const exported = path.join(exportRoot, (await readdir(exportRoot))[0]);
  const report = JSON.parse(await readFile(path.join(exported, 'verification.json'), 'utf8'));
  assert.deepEqual(report.fileHashes, current.verification?.fileHashes);
  assert.equal(
    JSON.parse(await readFile(path.join(exported, 'generated-suite.json'), 'utf8')).cases.length,
    3,
  );
  assert.equal(
    await readFile(path.join(exported, 'tests', current.generation!.files[0].path), 'utf8'),
    current.generation!.files[0].content,
  );
  // Record a fresh manual journey through the real desktop controls.
  await window.locator('#record-button').click();
  await window.locator('#record-name').fill('Recorded cart discount');
  await window.locator('#start-url').fill(positive.scenario.startUrl);
  await window.locator('#start-recording').click();
  await window.locator('#stop-recording').waitFor({ state: 'visible' });
  let browser;
  for (let i = 0; i < 50; i++) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9437');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert.ok(browser);
  const page = browser.contexts()[0].pages()[0];
  await page.getByTestId('add-notebook').click();
  await page.getByTestId('add-bag').click();
  await page.getByTestId('coupon').fill('SAVE10');
  await page.getByTestId('apply-coupon').click();
  await page.getByTestId('total').filter({ hasText: '$90.00' }).waitFor();
  await window.locator('#stop-recording').click();
  current = await settled(window, (s) => s.cases.length === 5);
  assert.equal(
    current.scenario?.assertions.length,
    0,
    'Fresh recordings never inherit unrelated requirements',
  );
  await window.locator('#add-assertion').click();
  await window.locator('#assertion-0-value').fill('total');
  await window.locator('#assertion-0-expected').fill('$90.00');
  await window
    .locator('#assertion-0-description')
    .fill('SAVE10 must reduce the $100 total to $90.');
  await window.locator('#generate').click();
  await settled(
    window,
    (s) => s.generation?.caseIds?.length === 1 && s.generation.caseIds[0] === s.activeCaseId,
  );
  await window.locator('#tab-verification').click();
  await window.locator('#verify').click();
  current = await settled(window, (s) => !!s.verification);
  assert.equal(current.verification?.status, 'passed');
  assert.equal(current.scenario?.events.length, 5);
  // Import a large suite through the native picker and exercise the batch ceiling.
  const extra = Array.from({ length: 495 }, (_, i) => {
    const c = structuredClone(current.cases[i % 3]);
    const id = randomUUID();
    c.id = id;
    c.scenario.id = id;
    c.name = `Regression case ${String(i + 1).padStart(3, '0')}`;
    c.scenario.name = c.name;
    return c;
  });
  const suitePath = path.join(root, 'scale-suite.json');
  await writeFile(suitePath, JSON.stringify(serializeSuite(extra)));
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file],
    })) as typeof dialog.showOpenDialog;
  }, suitePath);
  await window.locator('#nav-cases').click();
  await window.locator('#import-suite').click();
  await settled(window, (s) => s.cases.length === 500);
  await window.getByTestId('case-row').nth(499).waitFor();
  await window.locator('#clear-selection').click();
  await window.locator('#select-all-cases').click();
  assert.equal(await window.locator('[data-select-case]:checked').count(), 20);
  await window.locator('#case-search').fill('Regression case 495');
  assert.equal(await window.getByTestId('case-row').count(), 1);
  await mkdir('work', { recursive: true });
  await writeFile(
    'work/desktop-validation.json',
    JSON.stringify(
      {
        cases: 500,
        selectedLimit: 20,
        batch: 3,
        batchRuns: 2,
        recordedEvents: 5,
        recordedRuns: 2,
        exportVerified: true,
        claudeSettingsSaved: true,
        promptPreview: true,
        packaged: !!executable,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'passed',
      cases: 500,
      batch: 3,
      recording: true,
      exportVerified: true,
      packaged: !!executable,
      rendererErrors: errors,
    }),
  );
} catch (error) {
  const window = desktop.windows()[0];
  if (window) {
    await mkdir('work', { recursive: true });
    await window.screenshot({ path: 'work/desktop-failure.png' }).catch(() => {});
    const failed = await state(window).catch(() => undefined);
    console.error(
      JSON.stringify(
        {
          error: String(error),
          phase: failed?.phase,
          cases: failed?.cases.length,
          serviceError: failed?.error,
          lastActivity: failed?.activity.slice(-3),
          rendererErrors: errors,
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await desktop.close();
  await rm(root, { recursive: true, force: true });
}
