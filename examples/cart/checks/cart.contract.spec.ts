import { test, expect } from '@playwright/test';

test('SAVE10 applies ten percent and quantity changes recalculate cents', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-notebook').click();
  await page.getByTestId('add-bag').click();
  await expect(page.getByTestId('subtotal')).toHaveText('$100.00');
  await page.getByLabel('Coupon code').fill('SAVE10');
  await page.getByTestId('apply-coupon').click();
  await expect(page.getByTestId('total')).toHaveText('$90.00');
  await expect(page.getByTestId('discount')).toHaveText('$10.00');
  await page.getByLabel('Field notebook quantity').fill('2');
  await page.getByLabel('Field notebook quantity').press('Tab');
  await expect(page.getByTestId('total')).toHaveText('$126.00');
});

for (const code of ['INVALID', 'EXPIRED']) {
  test(`${code} clears any previous discount and reports the reason`, async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('add-notebook').click();
    await page.getByTestId('add-bag').click();
    await page.getByTestId('coupon').fill('SAVE10');
    await page.getByTestId('apply-coupon').click();
    await expect(page.getByTestId('coupon-status')).toHaveText('SAVE10 applied.');
    await page.getByTestId('coupon').fill(code);
    await page.getByTestId('apply-coupon').click();
    await expect(page.getByTestId('coupon-error')).toHaveText(code === 'EXPIRED'
      ? 'Coupon EXPIRED has expired. No discount applied.' : 'Coupon INVALID is invalid. No discount applied.');
    await expect(page.getByTestId('discount')).toHaveText('$0.00');
    await expect(page.getByTestId('total')).toHaveText('$100.00');
  });
}

test('a browser session survives reload but a separate context has an empty cart', async ({ page, browser, baseURL }) => {
  await page.goto('/');
  await page.getByTestId('add-bag').click();
  await expect(page.getByTestId('total')).toHaveText('$60.00');
  await page.reload();
  await expect(page.getByTestId('total')).toHaveText('$60.00');
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(baseURL!);
    await expect(second.getByTestId('add-notebook')).toBeVisible();
    await expect(second.getByTestId('total')).toHaveText('$0.00');
    await second.getByTestId('add-notebook').click();
    await expect(second.getByTestId('total')).toHaveText('$40.00');
    await page.reload();
    await expect(page.getByTestId('total')).toHaveText('$60.00');
  } finally { await other.close(); }
});

test('zero quantity removes the item and reset clears a coupon error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-bag').click();
  await page.getByLabel('Canvas bag quantity').fill('0');
  await page.getByLabel('Canvas bag quantity').press('Tab');
  await expect(page.getByTestId('total')).toHaveText('$0.00');
  await expect(page.getByLabel('Canvas bag quantity')).toHaveCount(0);
  await page.getByTestId('coupon').fill('INVALID');
  await page.getByTestId('apply-coupon').click();
  await expect(page.getByTestId('coupon-error')).toBeVisible();
  await page.getByTestId('reset-cart').click();
  await expect(page.getByTestId('coupon-error')).toBeHidden();
  await expect(page.getByTestId('coupon')).toHaveValue('');
});
