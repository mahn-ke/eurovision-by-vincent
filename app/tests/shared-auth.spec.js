const { spawn } = require('child_process');
const path = require('path');
const { test, expect } = require('@playwright/test');

const APP_DIR = path.resolve(__dirname, '..');
const TEST_TOKENS = 'YWxpY2U6YWJjLGJvYjpkZWYsw7xzZXJuw6TDn2U6Z2hp';

function testBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function startTestServer(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      TOKENS: TEST_TOKENS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    onExit,
    async waitUntilReady() {
      await expect
        .poll(async () => {
          try {
            const response = await fetch(`${testBaseUrl(port)}/healthz`, { cache: 'no-store' });
            return response.ok ? await response.text() : '';
          } catch {
            return '';
          }
        }, {
          timeout: 10_000,
        })
        .toBe('ok');
    },
    async stop() {
      if (child.exitCode !== null || child.killed) {
        await onExit;
        return;
      }

      child.kill('SIGTERM');
      const result = await onExit;
      if (result.signal === 'SIGTERM' || result.code === 0 || result.code === null) {
        return;
      }

      throw new Error(`Test server exited unexpectedly with code ${result.code}`);
    },
  };
}

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
    await expect(alicePage.locator('[data-panel-role="unranked"] .song-item')).toHaveCount(8);
    await expect(bobPage.locator('[data-panel-role="unranked"] .song-item')).toHaveCount(8);

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

  test('clients re-submit their own rankings after a server restart', async ({ browser }) => {
    const songsPayload = [
      { artist: 'Alpha', title: 'Lied A', country: 'DE' },
      { artist: 'Beta', title: 'Lied B', country: 'GB' },
      { artist: 'Gamma', title: 'Lied C', country: 'SE' },
    ];
    const port = 3101 + Math.floor(Math.random() * 1000);
    const baseUrl = testBaseUrl(port);

    let server = startTestServer(port);
    let alicePage;
    let bobPage;

    try {
      await server.waitUntilReady();

      alicePage = await browser.newPage();
      bobPage = await browser.newPage();

      for (const page of [alicePage, bobPage]) {
        await page.route('https://vimaster.de/prj/2026_eurovision/songs.json*', async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            headers: {
              'cache-control': 'no-store, no-cache, must-revalidate',
            },
            body: JSON.stringify(songsPayload),
          });
        });
      }

      await alicePage.goto(`${baseUrl}/?token=abc&pollMs=250`);
      await bobPage.goto(`${baseUrl}/?token=def&pollMs=250`);

      await expect(alicePage.locator('[data-user-panel][data-username="alice"] .song-item')).toHaveCount(0);
      await expect(bobPage.locator('[data-user-panel][data-username="bob"] .song-item')).toHaveCount(0);

      await dragSongToPanel(
        alicePage,
        '[data-panel-role="unranked"]',
        'Lied A',
        '[data-user-panel][data-username="alice"] [data-user-list="true"]'
      );
      await dragSongToPanel(
        alicePage,
        '[data-panel-role="unranked"]',
        'Lied B',
        '[data-user-panel][data-username="alice"] [data-user-list="true"]'
      );

      await dragSongToPanel(
        bobPage,
        '[data-panel-role="unranked"]',
        'Lied A',
        '[data-user-panel][data-username="bob"] [data-user-list="true"]'
      );
      await dragSongToPanel(
        bobPage,
        '[data-panel-role="unranked"]',
        'Lied C',
        '[data-user-panel][data-username="bob"] [data-user-list="true"]'
      );

      await expect.poll(async () => firstTwoTitles(alicePage, '[data-user-panel][data-username="alice"]')).toEqual(['Lied A', 'Lied B']);
      await expect.poll(async () => firstTwoTitles(alicePage, '[data-user-panel][data-username="bob"]')).toEqual(['Lied A', 'Lied C']);
      await expect.poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="alice"]')).toEqual(['Lied A', 'Lied B']);
      await expect.poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="bob"]')).toEqual(['Lied A', 'Lied C']);

      await server.stop();
      server = startTestServer(port);
      await server.waitUntilReady();

      await alicePage.reload();
      await bobPage.reload();

      await expect.poll(async () => firstTwoTitles(alicePage, '[data-user-panel][data-username="alice"]'), {
        timeout: 10_000,
      }).toEqual(['Lied A', 'Lied B']);
      await expect.poll(async () => firstTwoTitles(alicePage, '[data-user-panel][data-username="bob"]'), {
        timeout: 10_000,
      }).toEqual(['Lied A', 'Lied C']);

      await expect.poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="bob"]'), {
        timeout: 10_000,
      }).toEqual(['Lied A', 'Lied C']);
      await expect.poll(async () => firstTwoTitles(bobPage, '[data-user-panel][data-username="alice"]'), {
        timeout: 10_000,
      }).toEqual(['Lied A', 'Lied B']);
    } finally {
      await alicePage?.close();
      await bobPage?.close();
      await server.stop();
    }
  });
});
