/**
 * Visual layout QA for the Nardi board preview page.
 * Run: npx playwright test nardi-board.visual.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const OUT = path.join(process.cwd(), 'visual-output', 'nardi-board');

const PORTRAIT = [
  { w: 320, h: 568 },
  { w: 360, h: 640 },
  { w: 375, h: 667 },
  { w: 390, h: 844 },
  { w: 393, h: 852 },
  { w: 412, h: 915 },
  { w: 430, h: 932 },
];

const LANDSCAPE = [
  { w: 568, h: 320 },
  { w: 640, h: 360 },
  { w: 667, h: 375 },
  { w: 844, h: 390 },
  { w: 852, h: 393 },
  { w: 915, h: 412 },
  { w: 932, h: 430 },
];

const TABLET = [
  { w: 768, h: 1024 },
  { w: 1024, h: 768 },
  { w: 1280, h: 800 },
];

async function openPreview(page: Page): Promise<void> {
  await page.goto('/dev/nardi-board', { waitUntil: 'networkidle' });
  await page.waitForSelector('.board-frame', { timeout: 15000 });
  await page.waitForTimeout(200);
}

async function assertBoardFits(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const frame = document.querySelector('.board-frame') as HTMLElement | null;
    const stage = document.querySelector('.board-stage') as HTMLElement | null;
    if (!frame || !stage) return { ok: false, reason: 'missing elements' };

    const fr = frame.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const overflowX = doc.scrollWidth > doc.clientWidth + 1;
    const fitsStage =
      fr.width <= st.width + 2 &&
      fr.height <= st.height + 2 &&
      fr.width > 40 &&
      fr.height > 40;

    const checkers = [...document.querySelectorAll('.stack .checker')] as HTMLElement[];
    const pointBoxes = [...document.querySelectorAll('.point')] as HTMLElement[];
    let checkerOutside = 0;
    for (const c of checkers) {
      const cr = c.getBoundingClientRect();
      const point = c.closest('.point') as HTMLElement | null;
      if (!point) continue;
      const pr = point.getBoundingClientRect();
      // Allow 2px tolerance; stacks sit inside point column horizontally.
      if (cr.left < pr.left - 2 || cr.right > pr.right + 2) checkerOutside++;
    }

    // Neighboring stacks should not horizontally collide (centers ≥ checker width).
    let neighborOverlap = 0;
    for (const point of pointBoxes) {
      const stack = point.querySelector('.stack');
      if (!stack) continue;
      const checkersIn = [...stack.querySelectorAll('.checker')] as HTMLElement[];
      if (!checkersIn.length) continue;
      const base = checkersIn[0].getBoundingClientRect();
      const siblings = pointBoxes.filter((p) => p !== point);
      for (const sib of siblings) {
        const other = sib.querySelector('.stack .checker') as HTMLElement | null;
        if (!other) continue;
        const or = other.getBoundingClientRect();
        const sameRow = Math.abs(base.top - or.top) < base.height * 0.5;
        if (!sameRow) continue;
        const gap = Math.abs(base.left + base.width / 2 - (or.left + or.width / 2));
        if (gap < base.width * 0.85) neighborOverlap++;
      }
    }

    return {
      ok: fitsStage && !overflowX && checkerOutside === 0,
      overflowX,
      fitsStage,
      checkerOutside,
      neighborOverlap,
      board: { w: fr.width, h: fr.height },
      stage: { w: st.width, h: st.height },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      checkerCount: checkers.length,
    };
  });

  expect(report.overflowX, JSON.stringify(report)).toBe(false);
  expect(report.fitsStage, JSON.stringify(report)).toBe(true);
  expect(report.checkerOutside, JSON.stringify(report)).toBe(0);
}

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

for (const vp of PORTRAIT) {
  test(`portrait ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await openPreview(page);
    await assertBoardFits(page);
    await page.screenshot({
      path: path.join(OUT, `portrait-${vp.w}x${vp.h}.png`),
      fullPage: true,
    });
  });
}

for (const vp of LANDSCAPE) {
  test(`landscape ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await openPreview(page);
    await assertBoardFits(page);
    await page.screenshot({
      path: path.join(OUT, `landscape-${vp.w}x${vp.h}.png`),
      fullPage: true,
    });
  });
}

for (const vp of TABLET) {
  test(`tablet/desktop ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await openPreview(page);
    await assertBoardFits(page);
    await page.screenshot({
      path: path.join(OUT, `wide-${vp.w}x${vp.h}.png`),
      fullPage: true,
    });
  });
}

test('expanded mode portrait 390x844', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPreview(page);
  await page.click('.expand-btn');
  await page.waitForTimeout(300);
  await assertBoardFits(page);
  await page.screenshot({
    path: path.join(OUT, `expanded-portrait-390x844.png`),
    fullPage: false,
  });
  await page.click('.expand-btn');
  await page.waitForTimeout(200);
});

test('expanded mode landscape 844x390', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openPreview(page);
  const expand = page.locator('.expand-btn').first();
  await expect(expand).toBeVisible();
  await expand.click();
  await page.waitForTimeout(300);
  await assertBoardFits(page);
  await page.screenshot({
    path: path.join(OUT, `expanded-landscape-844x390.png`),
    fullPage: false,
  });
});
