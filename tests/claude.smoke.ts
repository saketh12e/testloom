// Opt-in, paid smoke: npx tsx tests/claude.smoke.ts. No live run in npm test.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transform } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectAgents, generateWithAgent, validateAgentSettings } from '../src/core/agents';
import { CLAUDE_RUN_ENV } from '../src/core/claude';
import type { Project, Scenario } from '../src/shared/types';

const workspace = await mkdtemp(path.join(tmpdir(), 'testloom-claude-smoke-'));
try {
  const { claude } = await detectAgents();
  let authenticated = false;
  if (claude.available) {
    // auth status emits a pretty-printed JSON document, unlike generation NDJSON.
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(claude.path!, ['auth', 'status', '--json'], {
        cwd: workspace,
        timeout: 10_000,
        maxBuffer: 100_000,
        env: { ...process.env, ...CLAUDE_RUN_ENV },
      }));
    } catch {
      throw new Error(
        'Claude auth status --json failed. Check the installed CLI; this smoke has not been skipped.',
      );
    }
    let status: { loggedIn?: boolean };
    try {
      status = JSON.parse(stdout);
    } catch {
      throw new Error('Claude auth status returned invalid JSON; this smoke has not been skipped.');
    }
    if (typeof status?.loggedIn !== 'boolean')
      throw new Error(
        'Claude auth status did not report loggedIn; this smoke has not been skipped.',
      );
    authenticated = status.loggedIn;
  }
  if (!authenticated) {
    console.log(
      JSON.stringify({
        smoke: 'skipped',
        reason: 'Existing Claude authentication is unavailable.',
      }),
    );
  } else {
    const project: Project = {
      id: 'synthetic-cart',
      name: 'Synthetic cart',
      path: workspace,
      framework: 'playwright-ts',
      buildTool: 'npm',
      summary: '',
      commands: [],
      outputDir: 'tests/testloom',
      examples: [
        {
          path: 'package.json',
          content: JSON.stringify({ devDependencies: { '@playwright/test': '1.63.0' } }),
        },
        {
          path: 'tests/cart.spec.ts',
          content:
            "import { test, expect } from '@playwright/test';\ntest('cart total', async ({ page }) => { await page.goto('https://cart.example.test/'); await expect(page.getByTestId('total')).toHaveText('$100.00'); });",
        },
      ],
    };
    const scenario: Scenario = {
      schemaVersion: 1,
      id: 'synthetic-discount',
      name: 'SAVE10 applies a ten percent discount',
      startUrl: 'https://cart.example.test/',
      createdAt: '2026-09-07T00:00:00Z',
      warnings: [],
      network: [],
      events: [
        {
          id: 'navigate',
          sequence: 1,
          timestamp: '',
          action: 'navigate',
          url: 'https://cart.example.test/',
          pageId: 'page-1',
          label: 'Open the demo cart, containing a $100 subtotal',
          locators: [],
        },
        {
          id: 'coupon',
          sequence: 2,
          timestamp: '',
          action: 'fill',
          url: 'https://cart.example.test/',
          pageId: 'page-1',
          label: 'Coupon',
          locators: [{ strategy: 'testId', value: 'coupon' }],
          value: 'SAVE10',
        },
        {
          id: 'apply',
          sequence: 3,
          timestamp: '',
          action: 'click',
          url: 'https://cart.example.test/',
          pageId: 'page-1',
          label: 'Apply coupon',
          locators: [{ strategy: 'testId', value: 'apply-coupon' }],
        },
      ],
      assertions: [
        {
          id: 'discount-total',
          description: 'SAVE10 reduces the $100 subtotal to $90.00.',
          kind: 'text',
          locator: { strategy: 'testId', value: 'total' },
          expected: '$90.00',
          source: 'user',
        },
      ],
    };
    const settings = validateAgentSettings({
      provider: 'claude',
      model: 'haiku',
      effort: 'low',
      timeoutSeconds: 120,
      claudeBudgetUsd: 0.5,
      instructions: 'Generate one concise TypeScript spec with one test.',
    });
    const result = await generateWithAgent(project, scenario, workspace, settings, {
      onProgress: console.log,
    });
    assert.equal(result.files.length, 1);
    for (const file of result.files) {
      assert.match(file.content, /discount-total/);
      assert.match(file.content, /\$90\.00/);
      assert.match(file.content, /toHaveText/);
      assert.doesNotMatch(file.content, /test\.skip|waitForTimeout|force:\s*true/);
      await transform(file.content, { loader: 'ts', format: 'esm' });
    }
    console.log(
      JSON.stringify({
        smoke: 'passed',
        version: claude.version,
        authentication: 'existing',
        model: settings.model,
        budgetUsd: settings.claudeBudgetUsd,
        files: result.files.map((file) => file.path),
        syntax: 'passed',
        assertions: 'preserved',
        execution: 'not run (synthetic generation only)',
      }),
    );
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
