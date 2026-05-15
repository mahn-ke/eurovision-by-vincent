const { test, expect } = require('@playwright/test');

async function firstTwoTitles(page, panelSelector) {
  const titles = await page.locator(`${panelSelector} .song-title`).allTextContents();
  return titles.slice(0, 2).map((title) => title.trim());
}

async function dragSongToPanel(page, fromSelector, songTitle, toSelector) {
  const source = page.locator(`${fromSelector} .song-item`, { hasText: songTitle }).first();
  const target = page.locator(toSelector);
  await source.dragTo(target);
}

async function panelSongCount(page, panelSelector) {
  return page.locator(`${panelSelector} .song-item`).count();
}

test.describe('shared auth ranking', () => {
  test('invalid token keeps anonymous two-column behavior', async ({ page }) => {
    await page.goto('/?token=does-not-exist&pollMs=1000');

    await expect(page.locator('#rankedList')).toBeVisible();
    await expect(page.locator('#notRankedList')).toBeVisible();
    await expect(page.locator('[data-user-panel]')).toHaveCount(0);
  });

  test('valid token shows own column first and keeps others read-only', async ({ page }) => {
    await page.goto('/?token=abc&pollMs=1000');

    await expect(page.locator('[data-panel-role="unranked"]')).toHaveCount(1);
    await expect(page.locator('[data-user-panel]')).toHaveCount(3);

    const panelTitles = await page.locator('.columns .panel h2').allTextContents();
    expect(panelTitles.map((title) => title.trim())).toEqual(['Noch nicht bewertet', 'alice (du)', 'bob', 'üsernäße']);

    await expect(page.locator('[data-panel-role="unranked"] .song-item')).toHaveCount(8);
    await expect(page.locator('[data-user-panel][data-username="alice"] .song-item')).toHaveCount(0);
    await expect(page.locator('[data-user-panel][data-username="bob"] .song-item')).toHaveCount(0);

    await expect(page.locator('[data-user-panel][data-username="alice"][data-editable="true"]')).toHaveCount(1);
    await expect(page.locator('[data-user-panel][data-username="bob"][data-editable="false"]')).toHaveCount(1);

    await dragSongToPanel(page, '[data-panel-role="unranked"]', 'Lied A', '[data-user-panel][data-username="bob"] [data-user-list="true"]');

    await expect(page.locator('[data-user-panel][data-username="bob"] .song-item')).toHaveCount(0);
    await expect(page.locator('[data-panel-role="unranked"]')).toContainText('Lied A');

    await dragSongToPanel(page, '[data-panel-role="unranked"]', 'Lied A', '[data-user-panel][data-username="alice"] [data-user-list="true"]');
    await expect(page.locator('[data-user-panel][data-username="alice"]')).toContainText('Lied A');
    await expect(page.locator('[data-panel-role="unranked"]')).not.toContainText('Lied A');

    await dragSongToPanel(page, '[data-user-panel][data-username="alice"]', 'Lied A', '[data-panel-role="unranked"] [data-unranked-list="true"]');
    await expect(page.locator('[data-user-panel][data-username="alice"] .song-item')).toHaveCount(0);
    await expect(page.locator('[data-panel-role="unranked"]')).toContainText('Lied A');

    await expect(page.locator('[data-user-panel][data-username="bob"] .song-item')).toHaveCount(0);
  });

  test('own ranking updates are broadcast while unranked stays local per client', async ({ browser }) => {
    const alicePage = await browser.newPage();
    const bobPage = await browser.newPage();

    await alicePage.goto('/?token=abc&pollMs=1000');
    await bobPage.goto('/?token=def&pollMs=1000');

    await expect(alicePage.locator('[data-user-panel]')).toHaveCount(3);
    await expect(bobPage.locator('[data-user-panel]')).toHaveCount(3);

    const bobUnrankedBefore = await panelSongCount(bobPage, '[data-panel-role="unranked"]');

    await dragSongToPanel(
      alicePage,
      '[data-panel-role="unranked"]',
      'Lied B',
      '[data-user-panel][data-username="alice"] [data-user-list="true"]'
    );

    await expect(alicePage.locator('[data-user-panel][data-username="alice"]')).toContainText('Lied B');
    await expect(alicePage.locator('[data-panel-role="unranked"]')).not.toContainText('Lied B');

    await expect
      .poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="alice"]'), {
        timeout: 10_000,
      })
      .toEqual(['Lied B']);

    await expect.poll(async () => panelSongCount(bobPage, '[data-panel-role="unranked"]'), {
      timeout: 2_000,
    }).toBe(bobUnrankedBefore);

    await expect(bobPage.locator('[data-panel-role="unranked"]')).toContainText('Lied B');

    await alicePage.close();
    await bobPage.close();
  });
});
