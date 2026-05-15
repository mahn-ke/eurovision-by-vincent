const STORAGE_KEY = 'eurovision-ranking-state-v1';
const POLL_MS = 2_000;

const rankedListEl = document.getElementById('rankedList');
const notRankedListEl = document.getElementById('notRankedList');
const songTemplate = document.getElementById('songTemplate');
const emptyStateEl = document.getElementById('emptyState');

const state = {
  songsById: {},
  ranked: [],
  notRanked: [],
};

let sortablesInitialized = false;
const dragState = {
  active: false,
  songId: null,
};

function toSongId(song) {
  const artist = String(song.artist || song.arist || '').trim();
  const title = String(song.title || '').trim();
  const country = String(song.country || '').trim().toUpperCase();
  return `${country}::${artist}::${title}`;
}

function normalizeSong(raw) {
  const artist = String(raw.artist || raw.arist || '').trim();
  const title = String(raw.title || '').trim();
  const country = String(raw.country || '').trim().toUpperCase();
  const id = toSongId({ artist, title, country });
  return { id, artist, title, country };
}

function saveState() {
  const payload = {
    ranked: state.ranked,
    notRanked: state.notRanked,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.ranked)) state.ranked = parsed.ranked.slice();
    if (Array.isArray(parsed.notRanked)) state.notRanked = parsed.notRanked.slice();
  } catch {
    state.ranked = [];
    state.notRanked = [];
  }
}

function getCombinedOrder() {
  return [...state.ranked, ...state.notRanked];
}

function cleanupMissingSongs(validIds) {
  state.ranked = state.ranked.filter((id) => validIds.has(id));
  state.notRanked = state.notRanked.filter((id) => validIds.has(id));
}

function mergeSongs(songs) {
  const validIds = new Set();
  for (const song of songs) {
    state.songsById[song.id] = song;
    validIds.add(song.id);
  }

  cleanupMissingSongs(validIds);

  const orderedKnown = new Set(getCombinedOrder());
  for (const song of songs) {
    if (!orderedKnown.has(song.id)) {
      state.notRanked.push(song.id);
      orderedKnown.add(song.id);
    }
  }
}

function songElement(songId) {
  const song = state.songsById[songId];
  const fragment = songTemplate.content.cloneNode(true);
  const li = fragment.querySelector('.song-item');
  li.dataset.songId = songId;
  li.querySelector('.country-pill span').textContent = song.country;
  li.querySelector('.song-title').textContent = song.title;
  li.querySelector('.song-artist').textContent = song.artist;
  return li;
}

function dedupeDomSongs() {
  const firstSeenById = new Map();
  const items = [
    ...rankedListEl.querySelectorAll('.song-item'),
    ...notRankedListEl.querySelectorAll('.song-item'),
  ];

  for (const item of items) {
    const songId = item.dataset.songId;
    if (!songId) continue;

    const seen = firstSeenById.get(songId);
    if (!seen) {
      firstSeenById.set(songId, item);
      continue;
    }

    const keepCurrent = item.classList.contains('sortable-drag') && !seen.classList.contains('sortable-drag');
    if (keepCurrent) {
      seen.remove();
      firstSeenById.set(songId, item);
    } else {
      item.remove();
    }
  }
}

function renderWhileDragging() {
  const existingNotRanked = new Set(listSongIds(notRankedListEl));
  for (const songId of state.notRanked) {
    if (!state.songsById[songId]) continue;
    if (songId === dragState.songId) continue;
    if (existingNotRanked.has(songId)) continue;
    notRankedListEl.appendChild(songElement(songId));
    existingNotRanked.add(songId);
  }

  dedupeDomSongs();
  updateEmptyState();
  saveState();
}

function updateEmptyState() {
  if (!emptyStateEl) return;
  const hasNoSongs = state.ranked.length === 0 && state.notRanked.length === 0;
  emptyStateEl.hidden = !hasNoSongs;
}

function render() {
  if (dragState.active) {
    renderWhileDragging();
    return;
  }

  rankedListEl.innerHTML = '';
  notRankedListEl.innerHTML = '';

  state.ranked.forEach((id) => {
    if (state.songsById[id]) rankedListEl.appendChild(songElement(id));
  });

  state.notRanked.forEach((id) => {
    if (state.songsById[id]) notRankedListEl.appendChild(songElement(id));
  });

  updateEmptyState();
  initSortableHandlers();
  saveState();
}

function listSongIds(container) {
  return [...container.querySelectorAll('.song-item')]
    .map((item) => item.dataset.songId)
    .filter((songId) => Boolean(songId && state.songsById[songId]));
}

function syncStateFromDom() {
  const rankedIds = listSongIds(rankedListEl);
  const used = new Set(rankedIds);

  const notRankedIds = listSongIds(notRankedListEl).filter((songId) => {
    if (used.has(songId)) return false;
    used.add(songId);
    return true;
  });

  for (const songId of getCombinedOrder()) {
    if (!state.songsById[songId] || used.has(songId)) continue;
    notRankedIds.push(songId);
    used.add(songId);
  }

  state.ranked = rankedIds;
  state.notRanked = notRankedIds;
}

function initSortableHandlers() {
  if (sortablesInitialized) return;

  const onDragEnd = () => {
    dragState.active = false;
    dragState.songId = null;
    syncStateFromDom();
    render();
  };

  const onDragStart = (event) => {
    dragState.active = true;
    dragState.songId = event.item?.dataset.songId || null;
  };

  Sortable.create(rankedListEl, {
    group: 'songs',
    animation: 150,
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  Sortable.create(notRankedListEl, {
    group: 'songs',
    animation: 150,
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  sortablesInitialized = true;
}

async function fetchSongs() {
  try {
    const response = await fetch(`/songs.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to fetch songs.json');

    const payload = await response.json();
    const songs = Array.isArray(payload)
      ? payload
          .map(normalizeSong)
          .filter((s) => s.artist && s.title && s.country)
      : [];

    mergeSongs(songs);
    render();
  } catch (error) {
    console.error(`Could not load songs: ${error.message}`);
  }
}

function start() {
  loadState();
  fetchSongs();
  setInterval(fetchSongs, POLL_MS);
}

start();
