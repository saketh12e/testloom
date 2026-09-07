import { test, expect } from '@playwright/test';

// An existing project test, intentionally independent of the recorded coupon journey.
test('change a notebook quantity and remove it', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-notebook').click();
  await expect(page.getByTestId('total')).toHaveText('$40.00');
  await page.getByLabel('Field notebook quantity').fill('2');
  await page.getByLabel('Field notebook quantity').press('Tab');
  await expect(page.getByTestId('total')).toHaveText('$80.00');
  await page.getByRole('button', { name: 'Remove Field notebook', exact: true }).click();
  await expect(page.getByTestId('total')).toHaveText('$0.00');
});
