const { test, expect } = require('@playwright/test');

async function dragSongBeforeInPanel(page, panelSelector, sourceTitle, targetTitle) {
  const panel = page.locator(panelSelector);
  const source = panel.locator('.song-item', { hasText: sourceTitle }).first();
  const target = panel.locator('.song-item', { hasText: targetTitle }).first();
  await source.dragTo(target, { targetPosition: { x: 8, y: 2 } });
}

async function firstTwoTitles(page, panelSelector) {
  const titles = await page.locator(`${panelSelector} .song-title`).allTextContents();
  return titles.slice(0, 2).map((title) => title.trim());
}

test.describe('shared auth ranking', () => {
  test('invalid token keeps anonymous two-column behavior', async ({ page }) => {
    await page.goto('/?token=does-not-exist');

    await expect(page.locator('#rankedList')).toBeVisible();
    await expect(page.locator('#notRankedList')).toBeVisible();
    await expect(page.locator('[data-user-panel]')).toHaveCount(0);
  });

  test('valid token shows own column first and keeps others read-only', async ({ page }) => {
    await page.goto('/?token=abc');

    await expect(page.locator('[data-user-panel]')).toHaveCount(3);

    const panelUsernames = await page
      .locator('[data-user-panel]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-username')));
    expect(panelUsernames).toEqual(['alice', 'bob', 'üsernäße']);

    await expect(page.locator('[data-user-panel][data-username="alice"][data-editable="true"]')).toHaveCount(1);
    await expect(page.locator('[data-user-panel][data-username="bob"][data-editable="false"]')).toHaveCount(1);

    const before = await firstTwoTitles(page, '[data-user-panel][data-username="bob"]');
    await dragSongBeforeInPanel(page, '[data-user-panel][data-username="bob"]', 'Song B', 'Song A');
    const after = await firstTwoTitles(page, '[data-user-panel][data-username="bob"]');

    expect(after).toEqual(before);
  });

  test('ranking updates are broadcast to other authenticated users', async ({ browser }) => {
    const alicePage = await browser.newPage();
    const bobPage = await browser.newPage();

    await alicePage.goto('/?token=abc');
    await bobPage.goto('/?token=def');

    await expect(alicePage.locator('[data-user-panel]')).toHaveCount(3);
    await expect(bobPage.locator('[data-user-panel]')).toHaveCount(3);

    const aliceOwnBefore = await firstTwoTitles(alicePage, '[data-user-panel][data-username="alice"]');

    await dragSongBeforeInPanel(alicePage, '[data-user-panel][data-username="alice"]', 'Song B', 'Song A');

    await expect
      .poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="alice"]'), {
        timeout: 10_000,
      })
      .not.toEqual(aliceOwnBefore);

    await expect
      .poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="alice"]'), {
        timeout: 10_000,
      })
      .toEqual(['Song B', 'Song A']);

    await alicePage.close();
    await bobPage.close();
  });
});
