async function installSongsMock(page, initialSongs = []) {
  let currentSongs = initialSongs.slice();

  await page.route('**/songs.json*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
      body: JSON.stringify(currentSongs),
    });
  });

  return {
    setSongs(nextSongs) {
      currentSongs = nextSongs.slice();
    },
  };
}

module.exports = {
  installSongsMock,
};
