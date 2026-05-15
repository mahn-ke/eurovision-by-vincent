const STORAGE_KEY = 'eurovision-ranking-state-v1';
const DEFAULT_POLL_MS = 20_000;
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const QUERY_TOKEN = QUERY_PARAMS.get('token') || '';

function resolvePollMs() {
  const overrideValue = Number.parseInt(QUERY_PARAMS.get('pollMs') || '', 10);
  if (!Number.isFinite(overrideValue)) return DEFAULT_POLL_MS;
  return Math.max(250, overrideValue);
}

const POLL_MS = resolvePollMs();

const rankedListEl = document.getElementById('rankedList');
const notRankedListEl = document.getElementById('notRankedList');
const songTemplate = document.getElementById('songTemplate');
const emptyStateEl = document.getElementById('emptyState');
const columnsEl = document.querySelector('.columns');

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

const sharedState = {
  enabled: false,
  username: null,
  users: [],
  rankingsByUser: {},
  socket: null,
  shellSignature: '',
  listByUser: new Map(),
  sortableInitialized: false,
  dragging: false,
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

function baseSongOrder() {
  const seen = new Set();
  const ordered = [];

  for (const id of [...state.ranked, ...state.notRanked]) {
    if (!state.songsById[id] || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered;
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
  return songElementWithDrag(songId, true);
}

function songElementWithDrag(songId, isDraggable) {
  const song = state.songsById[songId];
  const fragment = songTemplate.content.cloneNode(true);
  const li = fragment.querySelector('.song-item');
  li.dataset.songId = songId;
  li.setAttribute('draggable', isDraggable ? 'true' : 'false');
  if (!isDraggable) li.classList.add('read-only-item');
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
  if (sharedState.enabled) {
    renderShared();
    return;
  }

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

function arrangeUsers(users, ownUsername) {
  const filtered = Array.isArray(users) ? users.filter((name) => typeof name === 'string' && name) : [];
  if (!ownUsername || !filtered.includes(ownUsername)) return filtered;
  return [ownUsername, ...filtered.filter((name) => name !== ownUsername)];
}

function ensureSharedShell() {
  if (!columnsEl) return;

  const signature = `${sharedState.username || ''}::${sharedState.users.join('|')}`;
  if (sharedState.shellSignature === signature) return;

  columnsEl.innerHTML = '';
  sharedState.listByUser = new Map();

  for (const username of sharedState.users) {
    const isOwn = username === sharedState.username;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.dataset.userPanel = 'true';
    panel.dataset.username = username;
    panel.dataset.editable = isOwn ? 'true' : 'false';

    const title = document.createElement('h2');
    title.textContent = isOwn ? `${username} (you)` : username;

    const list = document.createElement('ul');
    list.className = 'song-list';
    list.setAttribute('aria-label', `${username} ranking`);
    list.dataset.userList = 'true';
    list.dataset.username = username;

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = isOwn
      ? 'Reorder your ranking. Changes are shared live.'
      : 'Live view. This ranking updates from the server.';

    panel.appendChild(title);
    panel.appendChild(list);
    panel.appendChild(hint);

    columnsEl.appendChild(panel);
    sharedState.listByUser.set(username, list);
  }

  sharedState.sortableInitialized = false;
  sharedState.shellSignature = signature;
}

function getUserRanking(user) {
  const raw = Array.isArray(sharedState.rankingsByUser[user]) ? sharedState.rankingsByUser[user] : [];
  const valid = raw.filter((songId) => Boolean(songId && state.songsById[songId]));
  const used = new Set(valid);
  const order = valid.slice();

  for (const songId of baseSongOrder()) {
    if (used.has(songId)) continue;
    used.add(songId);
    order.push(songId);
  }

  return order;
}

function renderShared() {
  ensureSharedShell();
  if (sharedState.dragging) return;

  for (const user of sharedState.users) {
    const list = sharedState.listByUser.get(user);
    if (!list) continue;

    const isOwn = user === sharedState.username;
    list.innerHTML = '';

    for (const songId of getUserRanking(user)) {
      list.appendChild(songElementWithDrag(songId, isOwn));
    }
  }

  if (emptyStateEl) {
    emptyStateEl.hidden = baseSongOrder().length > 0;
  }

  initSharedSortable();
}

function syncOwnRankingFromDom() {
  const ownList = sharedState.listByUser.get(sharedState.username);
  if (!ownList) return [];
  return [...ownList.querySelectorAll('.song-item')]
    .map((item) => item.dataset.songId)
    .filter((songId) => Boolean(songId && state.songsById[songId]));
}

async function persistOwnRanking(ranking) {
  try {
    await fetch(`/api/rankings?token=${encodeURIComponent(QUERY_TOKEN)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ ranking }),
    });
  } catch (error) {
    console.error(`Could not persist ranking: ${error.message}`);
  }
}

function initSharedSortable() {
  if (sharedState.sortableInitialized) return;
  const ownList = sharedState.listByUser.get(sharedState.username);
  if (!ownList) return;

  Sortable.create(ownList, {
    animation: 150,
    onStart: () => {
      sharedState.dragging = true;
    },
    onEnd: () => {
      sharedState.dragging = false;
      const ranking = syncOwnRankingFromDom();
      sharedState.rankingsByUser[sharedState.username] = ranking;
      persistOwnRanking(ranking);
      renderShared();
    },
  });

  sharedState.sortableInitialized = true;
}

function applySharedSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return;
  const users = arrangeUsers(payload.users, sharedState.username);
  if (users.length > 0) {
    sharedState.users = users;
  }

  if (payload.rankings && typeof payload.rankings === 'object') {
    const nextRankings = {};
    for (const user of sharedState.users) {
      nextRankings[user] = Array.isArray(payload.rankings[user]) ? payload.rankings[user].slice() : [];
    }
    sharedState.rankingsByUser = nextRankings;
  }

  for (const user of sharedState.users) {
    if (!Array.isArray(sharedState.rankingsByUser[user])) {
      sharedState.rankingsByUser[user] = [];
    }
  }

  renderShared();
}

async function fetchSharedRankings() {
  const response = await fetch(`/api/rankings?token=${encodeURIComponent(QUERY_TOKEN)}`, {
    cache: 'no-store',
  });
  if (!response.ok) return;
  const payload = await response.json();
  applySharedSnapshot(payload);
}

function connectSharedSocket() {
  if (!QUERY_TOKEN) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(QUERY_TOKEN)}`;
  const socket = new WebSocket(url);

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'rankings') {
        applySharedSnapshot(payload);
      }
    } catch {
      // Ignore malformed messages.
    }
  });

  socket.addEventListener('close', () => {
    if (sharedState.enabled) {
      window.setTimeout(connectSharedSocket, 1_500);
    }
  });

  sharedState.socket = socket;
}

async function tryEnableSharedMode() {
  if (!QUERY_TOKEN) return false;

  try {
    const response = await fetch(`/api/auth?token=${encodeURIComponent(QUERY_TOKEN)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return false;

    const payload = await response.json();
    if (!payload.authenticated || !payload.username) return false;

    sharedState.enabled = true;
    sharedState.username = payload.username;
    sharedState.users = arrangeUsers(payload.users, payload.username);
    sharedState.rankingsByUser = {};
    for (const user of sharedState.users) {
      sharedState.rankingsByUser[user] = [];
    }

    renderShared();
    await fetchSharedRankings();
    connectSharedSocket();
    return true;
  } catch {
    return false;
  }
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

    if (sharedState.enabled) {
      renderShared();
    } else {
      render();
    }
  } catch (error) {
    console.error(`Could not load songs: ${error.message}`);
  }
}

async function start() {
  const sharedEnabled = await tryEnableSharedMode();

  if (!sharedEnabled) {
    loadState();
  }

  fetchSongs();
  setInterval(fetchSongs, POLL_MS);
}

start();
