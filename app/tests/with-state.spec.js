const { test, expect } = require('@playwright/test');
const { installSongsMock } = require('./helpers/songs-mock');

async function dragSongToList(page, songTitle, listSelector) {
  const source = page.locator('.song-item', { hasText: songTitle }).first();
  const target = page.locator(listSelector);
  await source.dragTo(target);
}

async function dragSongBeforeSong(page, sourceTitle, targetTitle) {
  const source = page.locator('.song-item', { hasText: sourceTitle }).first();
  const target = page.locator('.song-item', { hasText: targetTitle }).first();
  await source.dragTo(target, { targetPosition: { x: 8, y: 2 } });
}

async function getRankedTitles(page) {
  return page.locator('#rankedList .song-title').allTextContents();
}

async function getAllVisibleTitles(page) {
  const titles = await page.locator('#rankedList .song-title, #notRankedList .song-title').allTextContents();
  return titles.map((title) => title.trim());
}

async function expectUniqueSongTitles(page) {
  const titles = await getAllVisibleTitles(page);
  const counts = new Map();

  for (const title of titles) {
    counts.set(title, (counts.get(title) || 0) + 1);
  }

  for (const [, count] of counts) {
    expect(count).toBe(1);
  }
}

async function getTitleCount(page, songTitle) {
  const titles = await getAllVisibleTitles(page);
  return titles.filter((title) => title === songTitle).length;
}

async function startDraggingSong(page, songTitle, listSelector) {
  const source = page.locator('.song-item', { hasText: songTitle }).first();
  const target = page.locator(listSelector);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox) throw new Error(`Could not find draggable bounds for ${songTitle}`);
  if (!targetBox) throw new Error(`Could not find drop target bounds for ${listSelector}`);

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const holdX = targetBox.x + targetBox.width / 2;
  const holdY = targetBox.y + Math.min(40, targetBox.height / 2);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 8 });
  await page.mouse.move(holdX, holdY, { steps: 20 });

  return {
    page,
    holdX,
    holdY,
  };
}

async function holdDraggedSong(heldDrag, durationMs) {
  const startTime = Date.now();
  let direction = 1;

  while (Date.now() - startTime < durationMs) {
    await heldDrag.page.mouse.move(heldDrag.holdX + 2 * direction, heldDrag.holdY + 2 * direction, {
      steps: 2,
    });
    direction *= -1;
    await heldDrag.page.waitForTimeout(120);
  }
}

async function dropIntoList(heldDrag) {
  await heldDrag.page.mouse.move(heldDrag.holdX, heldDrag.holdY, { steps: 4 });
  await heldDrag.page.mouse.up();
}

test.describe('suite with state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?pollMs=1000');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('stateful ranking and live additions', async ({ page }) => {
    const songsMock = await installSongsMock(page, [
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
    ]);

    await page.reload();
    await expect(page.locator('#notRankedList .song-item')).toHaveCount(2, {
      timeout: 2_000,
    });
    await expect(page.locator('#rankedList .song-item')).toHaveCount(0);
    await expectUniqueSongTitles(page);

    await dragSongToList(page, 'Lied A', '#rankedList');
    await expect(page.locator('#rankedList .song-item')).toHaveCount(1);
    await expect(page.locator('#rankedList')).toContainText('Lied A');
    await expectUniqueSongTitles(page);

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
    ]);

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(2, {
      timeout: 2_000,
    });
    await expect(page.locator('#notRankedList')).toContainText('Lied C');
    await expectUniqueSongTitles(page);

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
      { artist: 'Delta', title: 'Lied D', country: 'IT' },
      { artist: 'Epsilon', title: 'Lied E', country: 'NO' },
      { artist: 'Zeta', title: 'Lied F', country: 'FI' },
      { artist: 'Eta', title: 'Lied G', country: 'CH' },
    ]);

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(6, {
      timeout: 2_000,
    });
    await expectUniqueSongTitles(page);

    await dragSongToList(page, 'Lied D', '#rankedList');
    await dragSongToList(page, 'Lied E', '#rankedList');

    await expect(page.locator('#rankedList .song-item')).toHaveCount(3);
    await expectUniqueSongTitles(page);

    const rankedBeforeReorder = await getRankedTitles(page);

    await dragSongBeforeSong(page, 'Lied E', 'Lied A');
    let rankedAfterReorder = await getRankedTitles(page);

    // Some browsers can interpret the first drop geometry as a no-op.
    // Try the opposite direction to still validate in-list reordering behavior.
    if (rankedAfterReorder.join('|') === rankedBeforeReorder.join('|')) {
      await dragSongBeforeSong(page, 'Lied A', 'Lied E');
      rankedAfterReorder = await getRankedTitles(page);
    }

    expect(rankedAfterReorder.join('|')).not.toBe(rankedBeforeReorder.join('|'));
    await expectUniqueSongTitles(page);

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
      { artist: 'Delta', title: 'Lied D', country: 'IT' },
      { artist: 'Epsilon', title: 'Lied E', country: 'NO' },
      { artist: 'Zeta', title: 'Lied F', country: 'FI' },
      { artist: 'Eta', title: 'Lied G', country: 'CH' },
      { artist: 'Theta', title: 'Lied H', country: 'ES' },
      { artist: 'Iota', title: 'Lied I', country: 'PT' },
    ]);

    await expect(page.locator('#notRankedList .song-item')).toHaveCount(6, {
      timeout: 2_000,
    });
    await expect(page.locator('#notRankedList')).toContainText('Lied H');
    await expect(page.locator('#notRankedList')).toContainText('Lied I');
    await expectUniqueSongTitles(page);
  });

  test('no duplicate after long hold during live update', async ({ page }) => {
    const songsMock = await installSongsMock(page, [
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
    ]);

    await page.reload();
    await expect(page.locator('#notRankedList .song-item')).toHaveCount(3, {
      timeout: 2_000,
    });
    await expectUniqueSongTitles(page);

    const heldDrag = await startDraggingSong(page, 'Lied A', '#rankedList');

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
      { artist: 'Delta', title: 'Lied D', country: 'IT' },
    ]);

    await holdDraggedSong(heldDrag, 2_000);
    await expect(page.locator('#notRankedList')).toContainText('Lied D', {
      timeout: 2_000,
    });
    await expectUniqueSongTitles(page);

    await dropIntoList(heldDrag);

    await expect.poll(async () => getTitleCount(page, 'Lied A')).toBe(1);
    await expectUniqueSongTitles(page);
  });

  test('new song is added normally while another song is held', async ({ page }) => {
    const songsMock = await installSongsMock(page, [
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
    ]);

    await page.reload();
    await expect(page.locator('#notRankedList .song-item')).toHaveCount(3, {
      timeout: 2_000,
    });
    await expectUniqueSongTitles(page);

    const heldDrag = await startDraggingSong(page, 'Lied B', '#rankedList');

    songsMock.setSongs([
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
      { artist: 'Delta', title: 'Lied D', country: 'IT' },
    ]);

    await holdDraggedSong(heldDrag, 2_000);
    await expect(page.locator('#notRankedList')).toContainText('Lied D', {
      timeout: 2_000,
    });
    await expect.poll(async () => getTitleCount(page, 'Lied D')).toBe(1);
    await expectUniqueSongTitles(page);

    await dropIntoList(heldDrag);

    await expect.poll(async () => getTitleCount(page, 'Lied B')).toBe(1);
    await expectUniqueSongTitles(page);
  });
});
