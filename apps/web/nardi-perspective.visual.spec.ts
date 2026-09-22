/**
 * Player-perspective board visuals (white vs dark seat).
 * Run: npx playwright test nardi-perspective.visual.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'visual-output', 'nardi-perspective');

async function openPreview(page: Page, asSeat: 0 | 1, scenario = 'initial'): Promise<void> {
  await page.goto(`/dev/nardi-board?scenario=${scenario}&asSeat=${asSeat}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('.playing-field', { timeout: 15000 });
  await page.waitForTimeout(400);
}

function quadrantPoints(page: Page, quadrant: string): Promise<string[]> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(`${sel} .point`)].map(
      (el) => el.getAttribute('data-point') ?? '',
    );
  }, quadrant);
}

test.describe('Nardi board perspective', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT, { recursive: true });
  });

  test('white seat keeps home 1-6 on bottom-right', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPreview(page, 0, 'initial');

    const bottomRight = await quadrantPoints(page, '.quadrant.bottom.right-half');
    const localIsP0 = await page.locator('.off-box.local-player .player-disc').evaluate((el) =>
      el.classList.contains('p0'),
    );

    expect(bottomRight).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(localIsP0).toBe(true);
    await page.screenshot({ path: path.join(OUT, 'white-initial.png'), fullPage: true });
  });

  test('dark seat maps home 19-24 onto bottom-right display slots', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPreview(page, 1, 'initial');

    const bottomRight = await quadrantPoints(page, '.quadrant.bottom.right-half');
    const topRight = await quadrantPoints(page, '.quadrant.top.right-half');
    const localIsP1 = await page.locator('.off-box.local-player .player-disc').evaluate((el) =>
      el.classList.contains('p1'),
    );
    const nearIsP1 = await page.locator('.bar-zone.bar-near').evaluate((el) =>
      el.classList.contains('bar-p1'),
    );

    expect(bottomRight).toEqual(['19', '20', '21', '22', '23', '24']);
    expect(topRight).toEqual(['6', '5', '4', '3', '2', '1']);
    expect(localIsP1).toBe(true);
    expect(nearIsP1).toBe(true);
    await page.screenshot({ path: path.join(OUT, 'dark-initial.png'), fullPage: true });
  });

  test('dark legal highlight uses display mapping for stacks scenario', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPreview(page, 1, 'stacks');

    const point12 = page.locator('.point[data-point="12"]');
    await expect(point12).toHaveClass(/selectable/);
    await point12.click();
    await expect(point12).toHaveClass(/selected/);

    const point16 = page.locator('.point[data-point="16"]');
    await expect(point16).toHaveClass(/target/);
    await page.screenshot({ path: path.join(OUT, 'dark-stacks-select.png'), fullPage: true });
  });

  test('white and dark see opposite off-box ownership on same finished board', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openPreview(page, 0, 'bar');
    const whiteLocal = (await page.locator('.off-box.local-player .off-name').innerText()).toLowerCase();
    await page.screenshot({ path: path.join(OUT, 'white-bar-landscape.png'), fullPage: true });

    await openPreview(page, 1, 'bar');
    const darkLocal = (await page.locator('.off-box.local-player .off-name').innerText()).toLowerCase();
    await page.screenshot({ path: path.join(OUT, 'dark-bar-landscape.png'), fullPage: true });

    expect(whiteLocal).toContain('tatulika01');
    expect(darkLocal).toContain('black');
  });

  test('bar re-entry auto-highlights destinations for white and dark', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPreview(page, 0, 'bar');

    await expect(page.locator('.center-bar')).toHaveClass(/must-enter/);
    await expect(page.locator('.bar-zone.must-enter .checker').first()).toBeVisible();
    await expect(page.locator('.point.target')).toHaveCount(2);
    await expect(page.getByText('კენჭი ბარზეა')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, 'white-bar-entry.png'), fullPage: true });

    await openPreview(page, 1, 'bar');
    await expect(page.locator('.center-bar')).toHaveClass(/must-enter/);
    await expect(page.locator('.bar-zone.bar-near.must-enter')).toHaveClass(/bar-p1/);
    await expect(page.locator('.point.target')).toHaveCount(2);
    await page.screenshot({ path: path.join(OUT, 'dark-bar-entry.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await openPreview(page, 0, 'bar');
    await page.screenshot({ path: path.join(OUT, 'white-bar-portrait.png'), fullPage: true });
  });
});
