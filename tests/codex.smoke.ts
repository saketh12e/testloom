import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectProject, snapshotProject, writeGeneratedFiles } from '../src/core/repository';
import { codexGenerate } from '../src/core/codex';
import type { Scenario, InteractionEvent } from '../src/shared/types';

const project = await inspectProject(path.resolve('examples/cart'));
const workspace = path.resolve('work/codex-validation', String(Date.now()), 'project');
await snapshotProject(project, workspace);
const url = 'http://127.0.0.1:4318/';
const steps: [InteractionEvent['action'], string, string?][] = [
  ['navigate', ''],
  ['click', 'add-notebook'],
  ['click', 'add-bag'],
  ['fill', 'coupon', 'SAVE10'],
  ['click', 'apply-coupon'],
];
const scenario: Scenario = {
  schemaVersion: 1,
  id: 'codex-demo-01',
  name: 'Codex cart discount verification',
  startUrl: url,
  createdAt: new Date().toISOString(),
  warnings: [],
  network: [],
  events: steps.map(([action, target, value], i) => ({
    id: `step-${i}`,
    sequence: i + 1,
    timestamp: new Date().toISOString(),
    action,
    url,
    pageId: 'page-1',
    label: action + ' ' + target,
    locators: target ? [{ strategy: 'testId', value: target }] : [],
    ...(value ? { value } : {}),
  })),
  assertions: [
    {
      id: 'discount-total',
      description: 'SAVE10 applies a 10% discount to the $100 subtotal, resulting in $90.00.',
      kind: 'text',
      locator: { strategy: 'testId', value: 'total' },
      expected: '$90.00',
      source: 'user',
    },
  ],
};
const result = await codexGenerate(project, scenario, workspace, { onProgress: console.log });
await writeGeneratedFiles(workspace, result.files, project.outputDir);
await mkdir('work', { recursive: true });
await writeFile(
  'work/codex-validation.json',
  JSON.stringify({ workspace, result, scenario }, null, 2),
);
console.log(
  JSON.stringify(
    {
      workspace,
      summary: result.summary,
      files: result.files.map((f) => f.path),
      warnings: result.warnings,
    },
    null,
    2,
  ),
);
