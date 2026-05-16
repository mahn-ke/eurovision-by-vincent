const STORAGE_KEY = 'eurovision-ranking-state-v1';
const SHARED_STORAGE_KEY_PREFIX = 'eurovision-shared-ranking-state-v1';
const DEFAULT_POLL_MS = 2_000;
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
const sortableByList = new WeakMap();
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
  unrankedListEl: null,
  localUnranked: [],
  ownRanking: [],
  hasOwnRanking: false,
  sortableInitialized: false,
  dragging: false,
  hasSnapshotBaseline: false,
  pendingRemoteIntroAnims: [],
};

function sharedStorageKey(username) {
  return `${SHARED_STORAGE_KEY_PREFIX}:${username}:${QUERY_TOKEN}`;
}

function toSongId(song) {
  const artist = String(song.artist || song.arist || '').trim();
  const title = String(song.title || '').trim();
  const country = String(song.country || '').trim().toUpperCase();
  return `${country}::${artist}::${title}`;
}

function resolveFlatFlag(country, flatflag) {
  const explicitFlatFlag = String(flatflag || '').trim();
  if (explicitFlatFlag) return explicitFlatFlag;

  const normalizedCountry = String(country || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(normalizedCountry)) {
    return `https://flagcdn.com/${normalizedCountry.toLowerCase()}.svg`;
  }

  return '';
}

function normalizeSong(raw) {
  const artist = String(raw.artist || raw.arist || '').trim();
  const title = String(raw.title || '').trim();
  const country = String(raw.country || '').trim().toUpperCase();
  const flatflag = resolveFlatFlag(country, raw.flatflag);
  const youtube = String(raw.youtube || '').trim();
  const spotify = String(raw.spotify || '').trim();
  const id = toSongId({ artist, title, country });
  return { id, artist, title, country, flatflag, youtube, spotify };
}

function sanitizeRanking(ranking) {
  if (!Array.isArray(ranking)) return [];

  const seen = new Set();
  const cleaned = [];

  for (const songId of ranking) {
    if (typeof songId !== 'string' || !songId || seen.has(songId)) continue;
    seen.add(songId);
    cleaned.push(songId);
  }

  return cleaned;
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

function hasPersistedSingleplayerState() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function applyRankingToSingleplayerState(ranking) {
  const nextRanked = sanitizeRanking(ranking);
  const seen = new Set(nextRanked);
  const ordered = sanitizeRanking([...state.ranked, ...state.notRanked]);
  const nextNotRanked = [];

  for (const songId of ordered) {
    if (!songId || seen.has(songId)) continue;
    seen.add(songId);
    nextNotRanked.push(songId);
  }

  state.ranked = nextRanked;
  state.notRanked = nextNotRanked;
  saveState();
}

function saveSharedOwnRanking() {
  if (!sharedState.enabled || !sharedState.username) return;

  const payload = {
    ranking: sharedState.ownRanking.slice(),
  };

  localStorage.setItem(sharedStorageKey(sharedState.username), JSON.stringify(payload));
}

function loadSharedOwnRanking() {
  if (!sharedState.username) {
    sharedState.ownRanking = [];
    sharedState.hasOwnRanking = false;
    return;
  }

  try {
    const raw = localStorage.getItem(sharedStorageKey(sharedState.username));
    if (!raw) {
      sharedState.ownRanking = [];
      sharedState.hasOwnRanking = false;
      return;
    }

    const parsed = JSON.parse(raw);
    sharedState.ownRanking = sanitizeRanking(parsed.ranking);
    sharedState.hasOwnRanking = true;
  } catch {
    sharedState.ownRanking = [];
    sharedState.hasOwnRanking = false;
  }
}

function setOwnRanking(ranking, source = 'local') {
  const nextRanking = sanitizeRanking(ranking);
  sharedState.ownRanking = nextRanking;
  sharedState.hasOwnRanking = true;

  if (sharedState.username) {
    sharedState.rankingsByUser[sharedState.username] = nextRanking.slice();
  }

  if (source !== 'remote') {
    saveSharedOwnRanking();
  }

  // Keep the last own ranking consistent across singleplayer and multiplayer.
  applyRankingToSingleplayerState(nextRanking);
}

async function resubmitOwnRankingIfNeeded() {
  if (!sharedState.enabled || !sharedState.username || !sharedState.hasOwnRanking) return;
  await persistOwnRanking(sharedState.ownRanking);
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

function applySongToElement(li, songId, isDraggable) {
  const song = state.songsById[songId];
  if (!song) return;

  li.classList.remove('sortable-ghost', 'sortable-chosen', 'sortable-drag', 'sortable-fallback');
  li.style.removeProperty('transform');
  li.style.removeProperty('transition');
  li.style.removeProperty('left');
  li.style.removeProperty('top');
  li.style.removeProperty('position');

  li.dataset.songId = songId;
  li.setAttribute('draggable', isDraggable ? 'true' : 'false');
  li.classList.toggle('read-only-item', !isDraggable);

  const flagEl = li.querySelector('.flag');
  if (flagEl) {
    const nextFlagSrc = song.flatflag || '';
    if (flagEl.getAttribute('src') !== nextFlagSrc) {
      flagEl.src = nextFlagSrc;
    }
    flagEl.alt = `${song.country} flag`;
  }

  const titleEl = li.querySelector('.song-title');
  if (titleEl) titleEl.textContent = song.title;

  const artistEl = li.querySelector('.song-artist');
  if (artistEl) artistEl.textContent = song.artist;

  const youtubeEl = li.querySelector('.link-youtube');
  if (youtubeEl) youtubeEl.href = song.youtube;

  const spotifyEl = li.querySelector('.link-spotify');
  if (spotifyEl) spotifyEl.href = song.spotify;
}

function songElementWithDrag(songId, isDraggable) {
  const fragment = songTemplate.content.cloneNode(true);
  const li = fragment.querySelector('.song-item');
  applySongToElement(li, songId, isDraggable);
  return li;
}

function collectSongItemPool(containers) {
  const pool = new Map();

  for (const container of containers) {
    if (!container) continue;
    for (const item of container.querySelectorAll('.song-item')) {
      const songId = item.dataset.songId;
      if (!songId || pool.has(songId)) continue;
      pool.set(songId, item);
    }
  }

  return pool;
}

function cssEscape(value) {
  const raw = String(value || '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(raw);
  }

  return raw.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function ensureSortable(container, options) {
  const existing = sortableByList.get(container);
  if (existing) return existing;

  const sortable = Sortable.create(container, {
    animation: 150,
    dataIdAttr: 'data-song-id',
    ...options,
  });

  sortableByList.set(container, sortable);
  return sortable;
}

function renderSongListWithPool(container, songIds, pool, isDraggable) {
  const seen = new Set();
  const orderedIds = [];

  for (const songId of songIds) {
    if (!state.songsById[songId] || seen.has(songId)) continue;
    seen.add(songId);
    orderedIds.push(songId);

    const item = pool.get(songId) || songElementWithDrag(songId, isDraggable);
    pool.delete(songId);
    applySongToElement(item, songId, isDraggable);

    // Only append if needed (new item or moved across lists); reorder is animated by Sortable.sort.
    if (item.parentElement !== container) {
      container.appendChild(item);
    }
  }

  const inDomSeen = new Set();
  for (const item of [...container.querySelectorAll('.song-item')]) {
    const songId = item.dataset.songId;
    if (!songId || !seen.has(songId)) {
      item.remove();
      continue;
    }

    if (inDomSeen.has(songId)) {
      item.remove();
      continue;
    }

    inDomSeen.add(songId);
  }

  const sortable = sortableByList.get(container);
  const animateReorder = container.dataset.animateReorder === 'true';
  if (sortable && animateReorder) {
    sortable.sort(orderedIds, true);
  } else {
    for (const songId of orderedIds) {
      const item = container.querySelector(`.song-item[data-song-id="${cssEscape(songId)}"]`);
      if (item) container.appendChild(item);
    }
  }
}

function renderSongList(container, songIds, isDraggable) {
  const pool = collectSongItemPool([container]);
  renderSongListWithPool(container, songIds, pool, isDraggable);
  for (const staleItem of pool.values()) {
    staleItem.remove();
  }
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

function render(reuseNodes = false) {
  if (sharedState.enabled) {
    renderShared(reuseNodes);
    return;
  }

  if (dragState.active) {
    renderWhileDragging();
    return;
  }

  if (reuseNodes) {
    const pool = collectSongItemPool([rankedListEl, notRankedListEl]);
    renderSongListWithPool(rankedListEl, state.ranked, pool, true);
    renderSongListWithPool(notRankedListEl, state.notRanked, pool, true);
    for (const staleItem of pool.values()) {
      staleItem.remove();
    }
  } else {
    rankedListEl.innerHTML = '';
    notRankedListEl.innerHTML = '';

    state.ranked.forEach((id) => {
      if (state.songsById[id]) rankedListEl.appendChild(songElement(id));
    });

    state.notRanked.forEach((id) => {
      if (state.songsById[id]) notRankedListEl.appendChild(songElement(id));
    });
  }

  updateEmptyState();
  initSortableHandlers();
  saveState();
}

function arrangeUsers(users, ownUsername) {
  const filtered = Array.isArray(users) ? users.filter((name) => typeof name === 'string' && name) : [];
  if (!ownUsername || !filtered.includes(ownUsername)) return filtered;
  return [ownUsername, ...filtered.filter((name) => name !== ownUsername)];
}

function allKnownSongIds() {
  return baseSongOrder().filter((songId) => Boolean(songId && state.songsById[songId]));
}

function normalizeLocalUnranked() {
  const validSongs = new Set(allKnownSongIds());
  const ownRanking = new Set(getRankedOnlyForUser(sharedState.username));
  const deduped = [];
  const seen = new Set();

  for (const songId of sharedState.localUnranked) {
    if (!validSongs.has(songId) || ownRanking.has(songId) || seen.has(songId)) continue;
    seen.add(songId);
    deduped.push(songId);
  }

  for (const songId of allKnownSongIds()) {
    if (ownRanking.has(songId) || seen.has(songId)) continue;
    seen.add(songId);
    deduped.push(songId);
  }

  sharedState.localUnranked = deduped;
}

function createPanel({
  role,
  username,
  editable,
  title,
  hint,
  listAria,
  listDataset,
}) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  if (role) panel.dataset.panelRole = role;
  if (username) panel.dataset.username = username;
  if (editable !== undefined) panel.dataset.editable = editable ? 'true' : 'false';

  if (role === 'user') {
    panel.dataset.userPanel = 'true';
  }

  const heading = document.createElement('h2');
  heading.textContent = title;

  const list = document.createElement('ul');
  list.className = 'song-list';
  list.setAttribute('aria-label', listAria);
  Object.entries(listDataset).forEach(([key, value]) => {
    list.dataset[key] = value;
  });

  const hintEl = document.createElement('p');
  hintEl.className = 'hint';
  hintEl.innerHTML = hint;

  panel.appendChild(heading);
  panel.appendChild(list);
  panel.appendChild(hintEl);

  return { panel, list };
}

function ensureSharedShell() {
  if (!columnsEl) return;

  const signature = `${sharedState.username || ''}::${sharedState.users.join('|')}`;
  if (sharedState.shellSignature === signature) return;

  columnsEl.innerHTML = '';
  sharedState.listByUser = new Map();
  sharedState.unrankedListEl = null;

  const unrankedPanel = createPanel({
    role: 'unranked',
    editable: true,
    title: 'Noch nicht bewertet',
    hint: 'Diese Spalte siehst nur du. <br />Ziehe Lieder in deine Rangliste, um deine Auswahl zu teilen.',
    listAria: 'Noch nicht bewertete Lieder',
    listDataset: {
      unrankedList: 'true',
    },
  });

  columnsEl.appendChild(unrankedPanel.panel);
  sharedState.unrankedListEl = unrankedPanel.list;

  for (const username of sharedState.users) {
    const isOwn = username === sharedState.username;

    const userPanel = createPanel({
      role: 'user',
      username,
      editable: isOwn,
      title: isOwn ? `${username} (du)` : username,
      hint: isOwn
        ? 'Ziehe Lieder aus der "Noch nicht bewertet" Spalte in diese Liste.<br />Anderungen werden live geteilt.'
        : '',
      listAria: `Rangliste von ${username}`,
      listDataset: {
        userList: 'true',
        username,
        animateReorder: isOwn ? 'false' : 'true',
      },
    });

    columnsEl.appendChild(userPanel.panel);
    sharedState.listByUser.set(username, userPanel.list);
  }

  sharedState.sortableInitialized = false;
  sharedState.shellSignature = signature;
}

function getRankedOnlyForUser(user) {
  const raw = Array.isArray(sharedState.rankingsByUser[user]) ? sharedState.rankingsByUser[user] : [];
  const seen = new Set();
  return raw.filter((songId) => {
    if (!songId || !state.songsById[songId] || seen.has(songId)) return false;
    seen.add(songId);
    return true;
  });
}

function detectRemoteIntroducedSongs(previousRankings, nextRankings) {
  const introduced = [];

  for (const user of sharedState.users) {
    if (!user || user === sharedState.username) continue;

    const previous = Array.isArray(previousRankings[user]) ? previousRankings[user] : [];
    const previousSet = new Set(previous);
    const next = Array.isArray(nextRankings[user]) ? nextRankings[user] : [];

    for (let index = 0; index < next.length; index += 1) {
      const songId = next[index];
      if (!songId || previousSet.has(songId)) continue;
      introduced.push({ user, songId, index });
    }
  }

  return introduced;
}

function getSongElementFromList(list, songId) {
  if (!list || !songId) return null;
  return list.querySelector(`.song-item[data-song-id="${cssEscape(songId)}"]`);
}

function findLocalSourceSongElement(songId) {
  const ownList = sharedState.listByUser.get(sharedState.username);
  const ownItem = getSongElementFromList(ownList, songId);
  if (ownItem) return ownItem;
  return getSongElementFromList(sharedState.unrankedListEl, songId);
}

function preComputeIntroTargetRect(user, songId, index) {
  // Called BEFORE renderSongList so element positions are not yet affected by Sortable's
  // FLIP animation transforms. songId is not yet in the remote user's list at this point.
  const list = sharedState.listByUser.get(user);
  if (!list) return null;

  const ranking = getRankedOnlyForUser(user);
  const previousId = index > 0 ? ranking[index - 1] : null;
  const nextId = index < ranking.length - 1 ? ranking[index + 1] : null;
  const previousEl = previousId ? getSongElementFromList(list, previousId) : null;
  const nextEl = nextId ? getSongElementFromList(list, nextId) : null;

  const referenceEl = previousEl || nextEl;
  if (!referenceEl) return null;

  const style = window.getComputedStyle(referenceEl);
  const gap = Number.parseFloat(style.marginBottom) || 0;
  const referenceRect = referenceEl.getBoundingClientRect();

  if (previousEl) {
    return {
      left: referenceRect.left,
      top: referenceRect.bottom + gap,
      width: referenceRect.width,
      height: referenceRect.height,
    };
  }

  // No previous element: newSong goes before nextEl, which currently holds the target slot.
  return {
    left: referenceRect.left,
    top: referenceRect.top,
    width: referenceRect.width,
    height: referenceRect.height,
  };
}

function computeIntroTargetRect(user, songId, index, targetEl) {
  const fallback = targetEl.getBoundingClientRect();
  const list = sharedState.listByUser.get(user);
  if (!list) return fallback;

  const ranking = getRankedOnlyForUser(user);
  const previousId = index > 0 ? ranking[index - 1] : null;
  const nextId = index < ranking.length - 1 ? ranking[index + 1] : null;
  const previousEl = previousId ? getSongElementFromList(list, previousId) : null;
  const nextEl = nextId ? getSongElementFromList(list, nextId) : null;
  const style = window.getComputedStyle(targetEl);
  const gap = Number.parseFloat(style.marginBottom) || 0;

  if (previousEl) {
    const previousRect = previousEl.getBoundingClientRect();
    return {
      left: previousRect.left,
      top: previousRect.bottom + gap,
      width: fallback.width,
      height: fallback.height,
    };
  }

  if (nextEl) {
    const nextRect = nextEl.getBoundingClientRect();
    return {
      left: nextRect.left,
      top: nextRect.top - fallback.height - gap,
      width: fallback.width,
      height: fallback.height,
    };
  }

  return fallback;
}

function placeSongAtRankingIndex(user, songId, index) {
  const list = sharedState.listByUser.get(user);
  const target = getSongElementFromList(list, songId);
  if (!list || !target) return;

  const ranking = getRankedOnlyForUser(user);
  const nextId = index < ranking.length - 1 ? ranking[index + 1] : null;
  const nextEl = nextId ? getSongElementFromList(list, nextId) : null;
  list.insertBefore(target, nextEl || null);
}

function animateRemoteSongIntroduction(user, songId, index, preComputedTargetRect) {
  const prefersReducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) return false;

  const source = findLocalSourceSongElement(songId);
  const targetList = sharedState.listByUser.get(user);
  const target = getSongElementFromList(targetList, songId);
  if (!source || !target) return false;

  const sourceRect = source.getBoundingClientRect();
  const targetRect = preComputedTargetRect || computeIntroTargetRect(user, songId, index, target);
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return false;

  target.classList.add('remote-intro-target-hidden');

  const clone = source.cloneNode(true);
  clone.classList.add('remote-intro-clone');
  clone.style.left = `${sourceRect.left}px`;
  clone.style.top = `${sourceRect.top}px`;
  clone.style.width = `${sourceRect.width}px`;
  clone.style.height = `${sourceRect.height}px`;
  document.body.appendChild(clone);

  const deltaX = targetRect.left - sourceRect.left;
  const deltaY = targetRect.top - sourceRect.top;
  const scaleX = targetRect.width / sourceRect.width;
  const scaleY = targetRect.height / sourceRect.height;

  const animation = clone.animate([
    {
      transform: 'translate(0px, 0px) scale(1, 1)',
      opacity: 0.95,
    },
    {
      transform: `translate(${deltaX}px, ${deltaY}px) scale(${scaleX}, ${scaleY})`,
      opacity: 0.6,
    },
  ], {
    duration: 460,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'forwards',
  });

  const finish = () => {
    clone.remove();
    placeSongAtRankingIndex(user, songId, index);
    target.classList.remove('remote-intro-target-hidden');
    target.classList.add('remote-intro-target-highlight');
    window.setTimeout(() => target.classList.remove('remote-intro-target-highlight'), 500);
  };

  if (typeof animation.addEventListener === 'function') {
    animation.addEventListener('finish', finish, { once: true });
    animation.addEventListener('cancel', finish, { once: true });
  } else {
    animation.onfinish = finish;
    animation.oncancel = finish;
  }

  return true;
}

function runPendingRemoteIntroAnimations() {
  if (sharedState.pendingRemoteIntroAnims.length === 0) return;

  const entries = sharedState.pendingRemoteIntroAnims.slice();
  sharedState.pendingRemoteIntroAnims = [];

  for (const entry of entries) {
    try {
      animateRemoteSongIntroduction(entry.user, entry.songId, entry.index, entry.preComputedTargetRect);
    } catch {
      // Animation failures must never interrupt shared-mode rendering.
    }
  }
}

function renderShared(reuseNodes = false) {
  ensureSharedShell();
  if (sharedState.dragging) return;

  normalizeLocalUnranked();

  // Pre-compute intro animation target rects before renderSongList runs, so we read
  // element positions before Sortable's FLIP transforms make them appear at old locations.
  for (const entry of sharedState.pendingRemoteIntroAnims) {
    entry.preComputedTargetRect = preComputeIntroTargetRect(entry.user, entry.songId, entry.index);
  }

  if (sharedState.unrankedListEl) {
    if (reuseNodes) {
      renderSongList(sharedState.unrankedListEl, sharedState.localUnranked, true);
    } else {
      sharedState.unrankedListEl.innerHTML = '';
      for (const songId of sharedState.localUnranked) {
        sharedState.unrankedListEl.appendChild(songElementWithDrag(songId, true));
      }
    }
  }

  for (const user of sharedState.users) {
    const list = sharedState.listByUser.get(user);
    if (!list) continue;

    const isOwn = user === sharedState.username;
    if (reuseNodes || !isOwn) {
      renderSongList(list, getRankedOnlyForUser(user), isOwn);
    } else {
      list.innerHTML = '';
      for (const songId of getRankedOnlyForUser(user)) {
        list.appendChild(songElementWithDrag(songId, isOwn));
      }
    }
  }

  if (emptyStateEl) {
    emptyStateEl.hidden = baseSongOrder().length > 0;
  }

  initSharedSortable();
  runPendingRemoteIntroAnimations();
}

function syncOwnRankingFromDom() {
  const ownList = sharedState.listByUser.get(sharedState.username);
  if (!ownList) return [];
  return [...ownList.querySelectorAll('.song-item')]
    .filter((item) => !isTransientSortableItem(item))
    .map((item) => item.dataset.songId)
    .filter((songId) => Boolean(songId && state.songsById[songId]));
}

function syncLocalUnrankedFromDom() {
  if (!sharedState.unrankedListEl) return [];
  return [...sharedState.unrankedListEl.querySelectorAll('.song-item')]
    .filter((item) => !isTransientSortableItem(item))
    .map((item) => item.dataset.songId)
    .filter((songId) => Boolean(songId && state.songsById[songId]));
}

function isTransientSortableItem(item) {
  return item.classList.contains('sortable-ghost')
    || item.classList.contains('sortable-chosen')
    || item.classList.contains('sortable-drag')
    || item.classList.contains('sortable-fallback');
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
  const unrankedList = sharedState.unrankedListEl;
  if (!ownList || !unrankedList) return;

  const onDragEnd = () => {
    sharedState.dragging = false;
    const ranking = syncOwnRankingFromDom();
    setOwnRanking(ranking);
    sharedState.localUnranked = syncLocalUnrankedFromDom();
    normalizeLocalUnranked();
    persistOwnRanking(ranking);
    renderShared(true);
  };

  const onDragStart = () => {
    sharedState.dragging = true;
  };

  ensureSortable(ownList, {
    group: 'shared-songs',
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  ensureSortable(unrankedList, {
    group: 'shared-songs',
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  for (const [user, list] of sharedState.listByUser.entries()) {
    if (user === sharedState.username) continue;
    ensureSortable(list, {
      sort: false,
    });
  }

  sharedState.sortableInitialized = true;
}

function applySharedSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return;
  const previousRankings = { ...sharedState.rankingsByUser };
  const users = arrangeUsers(payload.users, sharedState.username);
  if (users.length > 0) {
    sharedState.users = users;
  }

  let nextRankings = null;
  if (payload.rankings && typeof payload.rankings === 'object') {
    nextRankings = {};
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

  if (sharedState.hasOwnRanking && sharedState.username) {
    sharedState.rankingsByUser[sharedState.username] = sharedState.ownRanking.slice();
  } else if (sharedState.username) {
    setOwnRanking(sharedState.rankingsByUser[sharedState.username] || [], 'remote');
  }

  if (sharedState.hasSnapshotBaseline && nextRankings) {
    sharedState.pendingRemoteIntroAnims = detectRemoteIntroducedSongs(previousRankings, nextRankings);
  }

  renderShared();
  sharedState.hasSnapshotBaseline = true;
}

async function fetchSharedRankings() {
  const response = await fetch(`/api/rankings?token=${encodeURIComponent(QUERY_TOKEN)}`, {
    cache: 'no-store',
  });
  if (!response.ok) return;
  const payload = await response.json();
  applySharedSnapshot(payload);
  await resubmitOwnRankingIfNeeded();
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

    loadState();
    const hasSingleplayerState = hasPersistedSingleplayerState();
    const singleplayerRanking = sanitizeRanking(state.ranked);

    loadSharedOwnRanking();

    if (hasSingleplayerState) {
      setOwnRanking(singleplayerRanking);
    } else if (sharedState.hasOwnRanking) {
      sharedState.rankingsByUser[sharedState.username] = sharedState.ownRanking.slice();
      applyRankingToSingleplayerState(sharedState.ownRanking);
    }

    sharedState.localUnranked = allKnownSongIds();

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
    dedupeDomSongs();
    updateEmptyState();
    saveState();
  };

  const onDragStart = (event) => {
    dragState.active = true;
    dragState.songId = event.item?.dataset.songId || null;
  };

  ensureSortable(rankedListEl, {
    group: 'songs',
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  ensureSortable(notRankedListEl, {
    group: 'songs',
    onStart: onDragStart,
    onEnd: onDragEnd,
  });

  sortablesInitialized = true;
}

async function fetchSongs() {
  try {
    const response = await fetch(`https://vimaster.de/prj/2026_eurovision/songs.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to fetch songs.json');

    const payload = await response.json();
    const songs = Array.isArray(payload)
      ? payload
          .map(normalizeSong)
          .filter((s) => s.artist && s.title && s.country)
      : [];

    mergeSongs(songs);

    if (sharedState.enabled) {
      renderShared(true);
    } else {
      render(true);
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
