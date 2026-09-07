import type { Assertion, GeneratedFile, InteractionEvent, LocatorSpec, Project, Scenario } from '../shared/types';

const q = (value: string) => JSON.stringify(value);
export function validateScenario(scenario: Scenario): void {
  if (!scenario || scenario.schemaVersion !== 1 || !Array.isArray(scenario.events) || !scenario.events.length) throw new Error('Record a journey before generating tests.');
  if (!scenario.assertions?.length) throw new Error('Add at least one expected result. A recording alone cannot establish correctness.');
  if (scenario.events.length > 500 || scenario.assertions.length > 30) throw new Error('Split this journey into smaller scenarios (500 actions / 30 assertions maximum).');
  for (const assertion of scenario.assertions) {
    if (assertion.source !== 'user' || !assertion.description?.trim() || !['text', 'visible', 'url', 'custom'].includes(assertion.kind)) throw new Error('Every assertion needs a description and an explicit expected result.');
    if (assertion.kind !== 'visible' && !assertion.expected?.trim()) throw new Error('Enter the expected value for each assertion.');
    if (['text','visible'].includes(assertion.kind) && !assertion.locator?.value?.trim()) throw new Error('Text and visibility assertions need an element locator.');
  }
}
function locator(spec: LocatorSpec, java: boolean): string {
  if (!spec?.value) throw new Error('An action is missing an element locator. Record it again.');
  const methods = { testId: 'getByTestId', label: 'getByLabel', placeholder: 'getByPlaceholder', text: 'getByText', css: 'locator', role: 'getByRole' };
  if (!(spec.strategy in methods)) throw new Error('Unknown locator strategy.');
  if (spec.strategy === 'role') {
    if (!/^[a-z]+$/.test(spec.value)) throw new Error('Invalid accessibility role.');
    return java ? `page.getByRole(AriaRole.${spec.value.toUpperCase()}, new Page.GetByRoleOptions().setName(${q(spec.name || '')}).setExact(true))` : `page.getByRole(${q(spec.value)}, { name: ${q(spec.name || '')}, exact: true })`;
  }
  return `page.${methods[spec.strategy]}(${q(spec.value)}${!java && ['text','label','placeholder'].includes(spec.strategy) ? ', { exact: true }' : ''})`;
}
function actionCode(event: InteractionEvent, java: boolean): string | undefined {
  if (event.redacted) throw new Error(`“${event.label}” contains a redacted value. Use Codex with an existing test fixture, or record with non-sensitive sample data.`);
  if (event.frameSelectors?.length || event.action === 'popup' || event.pageId && event.pageId !== 'page-1' && event.pageId !== 'main') throw new Error('This recording uses frames or multiple pages. Use Codex to adapt it to your project.');
  if (event.action === 'note') throw new Error(`Recording needs review: ${event.label}`);
  if (event.action === 'navigate') return undefined; // A start URL is explicit; subsequent full navigations are handled below.
  const target = locator(event.locators[0], java);
  const prefix = java ? '' : 'await ';
  const methods = { click: 'click()', fill: `fill(${q(event.value || '')})`, check: 'check()', uncheck: 'uncheck()', select: `selectOption(${q(event.value || '')})`, press: `press(${q(event.value || 'Enter')})` };
  const method = methods[event.action as keyof typeof methods];
  if (!method) throw new Error(`Unsupported action: ${event.action}`);
  return prefix + target + '.' + method + ';';
}
function assertionCode(assertion: Assertion, java: boolean): string {
  if (assertion.kind === 'custom') throw new Error('Use Codex for business-rule assertions written in plain language. Portable generation supports exact text, visibility, and URL checks.');
  const target = assertion.kind === 'url' ? 'page' : locator(assertion.locator!, java);
  const method = assertion.kind === 'text' ? java ? 'hasText' : 'toHaveText' : assertion.kind === 'visible' ? java ? 'isVisible' : 'toBeVisible' : java ? 'hasURL' : 'toHaveURL';
  return `${java ? 'assertThat' : 'await expect'}(${target}).${method}(${assertion.kind === 'visible' ? '' : q(assertion.expected)});`;
}
export function portableGenerate(project: Project, scenario: Scenario): { summary: string; files: GeneratedFile[]; warnings: string[] } {
  validateScenario(scenario);
  if (!['playwright-ts','playwright-java'].includes(project.framework)) throw new Error('Portable generation requires an existing Playwright TypeScript or Playwright Java project. Choose Codex for repository-specific adaptation.');
  if (scenario.warnings.some(w => !/Screenshots are enabled|using installed Google Chrome/i.test(w))) throw new Error('The recording has unsupported or incomplete steps. Review the warnings and use Codex for an explicit adaptation.');
  const java = project.framework === 'playwright-java';
  const lines: string[] = [];
  let started = false;
  for (const event of scenario.events) {
    if (event.action === 'navigate') {
      if (!started) { started = true; continue; }
      // Do not replay later navigation observations as goto: that would bypass a broken navigation action.
      const pattern = '^' + event.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[?#].*)?$';
      lines.push(java ? `assertThat(page).hasURL(java.util.regex.Pattern.compile(${q(pattern)}));` : `await expect(page).toHaveURL(new RegExp(${q(pattern)}));`);
    } else { const code = actionCode(event, java); if (code) lines.push(code); }
  }
  const assertions = scenario.assertions.map(a => `// Requirement ${a.id.replace(/[^a-zA-Z0-9_-]/g,'')}: ${a.description.replace(/[\r\n]/g, ' ')}\n    ${assertionCode(a, java)}`).join('\n    ');
  const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'journey';
  const shortId = scenario.id.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  if (java) {
    const className = 'Journey' + shortId + 'Test';
    return { summary: 'Playwright Java / JUnit 5 test generated from explicit actions and expected results.', warnings: ['Requires JUnit 5 and Playwright in the existing Java project. Review package and fixture conventions before adopting.'], files: [{ path: `${project.outputDir}/${className}.java`, content: `package journeyproof;\n\nimport com.microsoft.playwright.*;\nimport com.microsoft.playwright.options.AriaRole;\nimport org.junit.jupiter.api.Test;\nimport static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;\n\npublic class ${className} {\n  @Test\n  void recordedJourney() {\n    try (Playwright playwright = Playwright.create();\n         Browser browser = playwright.chromium().launch();\n         BrowserContext context = browser.newContext()) {\n      Page page = context.newPage();\n      page.navigate(${q(scenario.startUrl)});\n      ${lines.join('\n      ')}\n      ${assertions}\n    }\n  }\n}\n` }] };
  }
  return { summary: 'Playwright test generated with fresh browser context, condition-based waits, and explicit assertions.', warnings: ['Portable generation does not reuse company page objects. Choose Codex for that adaptation.'], files: [{ path: `${project.outputDir}/${slug}-${shortId}.spec.ts`, content: `import { test, expect } from '@playwright/test';\n\n// Scenario ${scenario.id.replace(/[^a-zA-Z0-9_-]/g, '')}. Expected results supplied by the tester.\ntest(${q(scenario.name)}, async ({ page }) => {\n    await page.goto(${q(scenario.startUrl)});\n    ${lines.join('\n    ')}\n    ${assertions}\n});\n` }] };
}
