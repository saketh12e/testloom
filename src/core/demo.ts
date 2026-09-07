import { randomUUID } from 'node:crypto';
import type { Scenario, TestCase, CaseKind } from '../shared/types';
import { createCase } from './suite';

/** Hand-authored examples for the bundled cart. These are examples, not user recordings. */
export function demoCases(port = 4318): TestCase[] {
  return [
    {
      name: 'Valid coupon reduces the total',
      kind: 'positive' as CaseKind,
      code: 'SAVE10',
      total: '$90.00',
      error: '',
    },
    {
      name: 'Invalid coupon is rejected',
      kind: 'negative' as CaseKind,
      code: 'INVALID',
      total: '$100.00',
      error: 'Coupon INVALID is invalid. No discount applied.',
    },
    {
      name: 'Empty coupon keeps the full total',
      kind: 'boundary' as CaseKind,
      code: '',
      total: '$100.00',
      error: 'Enter a coupon code. No discount applied.',
    },
  ].map((example) => {
    const now = new Date().toISOString();
    const url = `http://127.0.0.1:${port}/`;
    const scenario: Scenario = {
      schemaVersion: 1,
      id: randomUUID(),
      name: example.name,
      startUrl: url,
      createdAt: now,
      warnings: [],
      network: [],
      events: [
        { action: 'navigate', label: 'Open the sample cart', locators: [] },
        {
          action: 'click',
          label: 'Add field notebook',
          locators: [{ strategy: 'testId', value: 'add-notebook' }],
        },
        {
          action: 'click',
          label: 'Add canvas bag',
          locators: [{ strategy: 'testId', value: 'add-bag' }],
        },
        {
          action: 'fill',
          label: 'Enter coupon',
          locators: [{ strategy: 'testId', value: 'coupon' }],
          value: example.code,
        },
        {
          action: 'click',
          label: 'Apply coupon',
          locators: [{ strategy: 'testId', value: 'apply-coupon' }],
        },
      ].map((event, index) => ({
        ...event,
        id: randomUUID(),
        sequence: index + 1,
        timestamp: now,
        url,
        pageId: 'page-1',
      })) as Scenario['events'],
      assertions: [
        {
          id: randomUUID(),
          description: `The total must be ${example.total}.`,
          kind: 'text',
          locator: { strategy: 'testId', value: 'total' },
          expected: example.total,
          source: 'user',
        },
      ],
    };
    if (example.error)
      scenario.assertions.push({
        id: randomUUID(),
        description: 'Explain why the coupon was rejected.',
        kind: 'text',
        locator: { strategy: 'testId', value: 'coupon-error' },
        expected: example.error,
        source: 'user',
      });
    return {
      ...createCase(scenario, example.kind),
      tags: ['sample', 'cart', 'coupon'],
      priority: 'high',
    };
  });
}
