/**
 * End-game win/loss visual QA.
 * Run: npx playwright test nardi-endgame.visual.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'visual-output', 'nardi-endgame');

async function openEndgame(page: Page, scenario: 'win' | 'loss'): Promise<void> {
  await page.goto(`/dev/nardi-board?scenario=${scenario}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.endgame-layer', { timeout: 15000 });
  await page.waitForSelector('.endgame-card-in', { timeout: 5000 });
  await page.waitForTimeout(scenario === 'win' ? 900 : 400);
}

async function assertCardFits(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const card = document.querySelector('.endgame-card') as HTMLElement | null;
    const layer = document.querySelector('.endgame-layer') as HTMLElement | null;
    if (!card || !layer) return { ok: false, reason: 'missing' };
    const cr = card.getBoundingClientRect();
    const lr = layer.getBoundingClientRect();
    const overflow =
      cr.top < lr.top - 2 ||
      cr.bottom > lr.bottom + 2 ||
      cr.left < lr.left - 2 ||
      cr.right > lr.right + 2 ||
      cr.width > lr.width + 2;
    const btns = [...document.querySelectorAll('.endgame-actions .btn')] as HTMLElement[];
    const shortBtn = btns.some((b) => b.getBoundingClientRect().height < 36);
    return {
      ok: !overflow && !shortBtn && cr.width > 200,
      overflow,
      shortBtn,
      w: Math.round(cr.width),
      h: Math.round(cr.height),
    };
  });
  expect(report.ok, JSON.stringify(report)).toBeTruthy();
}

test.describe('Nardi end-game visuals', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
  });

  test('desktop winner', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEndgame(page, 'win');
    await expect(page.getByRole('heading', { name: 'თქვენ გაიმარჯვეთ' })).toBeVisible();
    await expect(page.getByText('გილოცავთ!')).toBeVisible();
    await assertCardFits(page);
    await page.screenshot({ path: path.join(OUT, 'desktop-winner.png'), fullPage: true });
  });

  test('desktop loser', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openEndgame(page, 'loss');
    await expect(page.getByRole('heading', { name: 'სამწუხაროდ, თქვენ დამარცხდით' })).toBeVisible();
    await expect(page.locator('.endgame-canvas')).toBeAttached();
    await assertCardFits(page);
    await page.screenshot({ path: path.join(OUT, 'desktop-loser.png'), fullPage: true });
  });

  for (const { w, h, label } of [
    { w: 390, h: 844, label: 'portrait-390x844' },
    { w: 320, h: 568, label: 'portrait-320x568' },
  ]) {
    test(`mobile ${label} winner`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openEndgame(page, 'win');
      await assertCardFits(page);
      await page.screenshot({ path: path.join(OUT, `${label}-winner.png`), fullPage: true });
    });

    test(`mobile ${label} loser`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await openEndgame(page, 'loss');
      await assertCardFits(page);
      await page.screenshot({ path: path.join(OUT, `${label}-loser.png`), fullPage: true });
    });
  }

  test('landscape winner fits', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openEndgame(page, 'win');
    await assertCardFits(page);
    await page.screenshot({ path: path.join(OUT, 'landscape-844x390-winner.png'), fullPage: true });
  });

  test('landscape loser fits', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openEndgame(page, 'loss');
    await assertCardFits(page);
    await page.screenshot({ path: path.join(OUT, 'landscape-844x390-loser.png'), fullPage: true });
  });

  test('loser has no celebration particles active meaning', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openEndgame(page, 'loss');
    // Defeat screen must not show victory copy.
    await expect(page.getByText('გილოცავთ!')).toHaveCount(0);
    await expect(page.getByText('თქვენ გაიმარჯვეთ')).toHaveCount(0);
  });
});
