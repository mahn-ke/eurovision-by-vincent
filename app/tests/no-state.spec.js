const { test, expect } = require('@playwright/test');
const { installSongsMock } = require('./helpers/songs-mock');

async function expectUniqueSongTitles(page) {
  const titles = await page.locator('#rankedList .song-title, #notRankedList .song-title').allTextContents();
  const counts = new Map();

  for (const title of titles.map((item) => item.trim())) {
    counts.set(title, (counts.get(title) || 0) + 1);
  }

  for (const [, count] of counts) {
    expect(count).toBe(1);
  }
}

test.describe('suite no state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?pollMs=1000');
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload();
  });

  test('on empty json no songs', async ({ page }) => {
    const songsMock = await installSongsMock(page, []);
    songsMock.setSongs([]);
    await page.reload();

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(0);
    await expect(page.locator('#rankedList .song-item')).toHaveCount(0);
    await expect(page.getByText('Noch keine Lieder verfuegbar.')).toBeVisible();
    await expectUniqueSongTitles(page);
  });

  test('on entries in json: two songs and then one appears without refresh', async ({ page }) => {
    const songsMock = await installSongsMock(page, [
      { artist: 'Alpha', title: 'Eins', country: 'DE' },
      { artist: 'Beta', title: 'Zwei', country: 'GB' },
    ]);

    await page.reload();
    await expect(page.locator('#notRankedList .song-item')).toHaveCount(2);
    await expectUniqueSongTitles(page);

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Eins', country: 'DE' },
      { artist: 'Beta', title: 'Zwei', country: 'GB' },
      { artist: 'Gamma', title: 'Drei', country: 'SE' },
    ]);

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(3, {
      timeout: 2_000,
    });
    await expect(page.locator('#notRankedList')).toContainText('Drei');
    await expectUniqueSongTitles(page);
  });

  test('keeps existing flag image nodes stable after one 2s refresh when songs update', async ({ page }) => {
    const songsMock = await installSongsMock(page, [
      { artist: 'Alpha', title: 'Eins', country: 'DE' },
      { artist: 'Beta', title: 'Zwei', country: 'GB' },
    ]);

    await page.goto('/?pollMs=2000');
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload();

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(2);

    const firstSongFlagBefore = await page
      .locator('#notRankedList .song-item', { hasText: 'Eins' })
      .locator('img.flag')
      .first()
      .elementHandle();

    expect(firstSongFlagBefore).not.toBeNull();

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Eins', country: 'DE' },
      { artist: 'Beta', title: 'Zwei', country: 'GB' },
      { artist: 'Gamma', title: 'Drei', country: 'SE' },
    ]);

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(3, {
      timeout: 2_500,
    });

    const firstSongFlagAfter = await page
      .locator('#notRankedList .song-item', { hasText: 'Eins' })
      .locator('img.flag')
      .first()
      .elementHandle();

    expect(firstSongFlagAfter).not.toBeNull();

    const sameNode = await page.evaluate(
      ([before, after]) => before === after,
      [firstSongFlagBefore, firstSongFlagAfter],
    );

    expect(sameNode).toBe(true);
  });
});
