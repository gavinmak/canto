/* Offline study client.
 *
 * Talks to the Mac (same Wi-Fi) only to (a) list sources and (b) download a
 * deck bundle. Everything else — search, audio, dictionary popups, SM-2 review
 * — runs against IndexedDB + the service-worker caches, so it works with the
 * Mac off. dict.js is reused as-is: its /api/define fetches are served from the
 * canto-defs cache we populate at download time.
 *
 * Stores (IndexedDB "canto"):
 *   cards — full card objects, keyPath "id" (carries .source for delete).
 *   srs   — review state per card id (SM-2), keyPath "id".
 */
(function () {
  'use strict';

  // ---- data source: live server (FastAPI) vs static GitHub Pages build ----
  // The same client runs two ways. On the server it hits /api/*. In the static
  // export (build_static.py) window.CANTO_STATIC is set and the deck list +
  // bundles are plain JSON files committed next to this script. Everything else
  // (search, review, caching) is identical.
  const STATIC = !!window.CANTO_STATIC;
  const SOURCES_URL = STATIC ? 'data/sources.json' : '/api/sources';
  const bundleURL = (row) =>
    STATIC ? 'data/bundles/' + row.slug + '.json'
           : '/api/bundle?source=' + encodeURIComponent(row.source);

  // ---- tiny IndexedDB helpers --------------------------------------------
  const DB_NAME = 'canto';
  const MEDIA_CACHE = 'canto-media';
  const DEFS_CACHE = 'canto-defs';
  const PROFILES = ['Gavin', 'Kita'];
  // Downloaded decks (cards/media/defs) are shared; only review state is
  // per-profile, in its own object store so Gavin and Kita keep separate decks.
  const srsStore = (p) => 'srs_' + p;
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cards'))
          db.createObjectStore('cards', { keyPath: 'id' }).createIndex('source', 'source');
        PROFILES.forEach((p) => {
          if (!db.objectStoreNames.contains(srsStore(p)))
            db.createObjectStore(srsStore(p), { keyPath: 'id' });
        });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return openDB().then((db) => db.transaction(store, mode).objectStore(store));
  }
  function asPromise(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }
  const getAll = (s) => tx(s, 'readonly').then((o) => asPromise(o.getAll()));
  const getOne = (s, k) => tx(s, 'readonly').then((o) => asPromise(o.get(k)));
  const putOne = (s, v) => tx(s, 'readwrite').then((o) => asPromise(o.put(v)));
  const delOne = (s, k) => tx(s, 'readwrite').then((o) => asPromise(o.delete(k)));
  function bulkPut(store, vals) {
    return openDB().then((db) => new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite');
      const o = t.objectStore(store);
      vals.forEach((v) => o.put(v));
      t.oncomplete = res; t.onerror = () => rej(t.error);
    }));
  }

  // ---- media URLs from a card --------------------------------------------
  // Card paths look like "media/peppa/00001.mp3". Kept relative (no leading
  // slash) so they resolve correctly both on the server (/study at root) and on
  // Pages under a subpath (canto.gavinmak.com OR gavinmak.com/canto/).
  const mediaUrls = (c) => [c.audio, c.image].filter(Boolean).map((p) => p);

  // ---- SM-2 (ported from srs.py) -----------------------------------------
  const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;
  const MIN_EASE = 1.3, DEFAULT_EASE = 2.5, FIRST_GOOD = 1.0, FIRST_EASY = 4.0;
  const DAY_MS = 86400000;

  function newState() {
    const now = new Date().toISOString();
    return { ease: DEFAULT_EASE, interval: 0, reps: 0, lapses: 0, due: now, added: now, last: null };
  }
  function schedule(st, grade) {
    let { ease, interval, reps } = st;
    if (grade === AGAIN) {
      st.lapses += 1; st.reps = 0; st.ease = Math.max(MIN_EASE, ease - 0.20); interval = 0;
    } else {
      if (reps === 0) interval = grade === EASY ? FIRST_EASY : FIRST_GOOD;
      else if (grade === HARD) { interval = Math.max(FIRST_GOOD, interval * 1.2); ease = Math.max(MIN_EASE, ease - 0.15); }
      else if (grade === GOOD) interval = interval * ease;
      else { interval = interval * ease * 1.3; ease = ease + 0.15; }
      st.ease = ease; st.reps = reps + 1;
    }
    const now = Date.now();
    st.interval = Math.round(interval * 10000) / 10000;
    st.due = new Date(now + interval * DAY_MS).toISOString();
    st.last = new Date(now).toISOString();
    return st;
  }

  // ---- DOM helpers --------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  // Render one card into the same markup the server uses, so dict.js attaches.
  function cardEl(c, savedSet) {
    const art = document.createElement('article');
    art.className = 'card' + (c.image ? '' : ' nomedia');
    const reading = (c.words || []).map((w) => {
      const latin = w.jyutping ? '' : ' latin';
      return `<span class="w${latin}"><span class="wh han">${esc(w.text)}</span>` +
             `<span class="wj jyut">${esc(w.jyutping || '')}</span></span>`;
    }).join('');
    const saved = savedSet && savedSet.has(c.id);
    art.innerHTML =
      (c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : '') +
      `<div><div class="reading">${reading}</div>` +
      `<div class="eng">${esc(c.english || '(no translation yet)')}</div>` +
      `<audio controls preload="none" src="${esc(c.audio)}"></audio>` +
      `<div class="cardfoot"><div class="src">${esc(c.source)} · ${(+c.start).toFixed(1)}s</div>` +
      `<button class="btn-save${saved ? ' is-saved' : ''}" data-card="${esc(c.id)}" ` +
      `aria-pressed="${saved}"><span class="lbl">${saved ? '✓ Saved' : '+ Save'}</span></button>` +
      `</div></div>`;
    // tones.js colorizes .jyut at DOMContentLoaded, but cards are built later, so
    // run it here over this card's syllables (tone color + contour glyphs).
    if (window.colorizeJyutping) art.querySelectorAll('.jyut').forEach(window.colorizeJyutping);
    return art;
  }
  function esc(s) { return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- profile (Gavin / Kita) --------------------------------------------
  // No real auth — a static picker that selects whose review deck + theme to
  // use. Persisted in localStorage; each profile gets its own srs store.
  let PROFILE = null;
  let SRS = null;          // current profile's srs object store name

  function applyTheme(p) {
    document.body.classList.toggle('theme-kita', p === 'Kita');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', p === 'Kita' ? '#9b7ef0' : '#11785e');
  }

  function setProfile(p) {
    PROFILE = p;
    SRS = srsStore(p);
    try { localStorage.setItem('canto-profile', p); } catch (e) {}
    applyTheme(p);
    const chip = $('whoami');
    chip.hidden = false;
    chip.innerHTML = '<b>' + esc(p) + '</b> · switch';
  }

  function showGate() {
    $('profile-gate').hidden = false;
  }

  // ---- state --------------------------------------------------------------
  let savedSet = new Set();   // card ids in the srs deck

  async function refreshSaved() {
    const all = await getAll(SRS);
    savedSet = new Set(all.map((s) => s.id));
    updateDueBadge(all);
  }
  function updateDueBadge(srsAll) {
    const now = Date.now();
    const due = srsAll.filter((s) => Date.parse(s.due) <= now).length;
    const badge = $('due-badge');
    if (due > 0) { badge.textContent = due; badge.hidden = false; } else badge.hidden = true;
  }

  // ---- Library ------------------------------------------------------------
  async function downloadedSources() {
    const cards = await getAll('cards');
    const m = new Map();
    cards.forEach((c) => m.set(c.source, (m.get(c.source) || 0) + 1));
    return m;
  }

  async function renderLibrary() {
    const list = $('lib-list');
    const have = await downloadedSources();
    let remote = null;
    try {
      const r = await fetch(SOURCES_URL, { cache: 'no-store' });
      if (r.ok) remote = await r.json();
    } catch (e) { /* offline */ }
    $('lib-loading').hidden = true;

    // Union: remote sources (when online) plus anything already downloaded.
    const rows = new Map();
    if (remote) remote.forEach((s) => rows.set(s.source, { source: s.source, count: s.count, slug: s.slug }));
    have.forEach((cnt, src) => { if (!rows.has(src)) rows.set(src, { source: src, count: cnt }); });

    if (rows.size === 0) {
      list.innerHTML = '<p class="emptyhint">No decks yet. Open this on the same Wi-Fi as your Mac (with the app running) to load the library.</p>';
      return;
    }
    list.innerHTML = '';
    rows.forEach((s) => {
      const got = have.has(s.source);
      const row = document.createElement('div');
      row.className = 'srcrow';
      row.innerHTML =
        `<div class="meta"><div class="nm">${esc(s.source)}</div>` +
        `<div class="sub">${s.count} cards${got ? ' · downloaded' : ''}</div></div>` +
        `<div class="prog" hidden></div>` +
        (got
          ? `<button class="del">Delete</button>`
          : `<button class="dl"${remote ? '' : ' disabled'}>Download</button>`);
      const prog = row.querySelector('.prog');
      const btn = row.querySelector('button');
      btn.addEventListener('click', () => got ? deleteDeck(s.source, row) : downloadDeck(s, btn, prog));
      list.appendChild(row);
    });
    updateStorageLine();
  }

  async function downloadDeck(s, btn, prog) {
    btn.disabled = true; prog.hidden = false; prog.textContent = 'fetching…';
    try {
      const r = await fetch(bundleURL(s), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const bundle = await r.json();

      // 1) dictionary senses -> defs cache (keyed exactly like dict.js fetches).
      const defs = await caches.open(DEFS_CACHE);
      await Promise.all(Object.entries(bundle.defines || {}).map(([word, senses]) =>
        defs.put('/api/define?word=' + encodeURIComponent(word),
                 new Response(JSON.stringify({ word, senses }), { headers: { 'Content-Type': 'application/json' } }))));

      // 2) media files -> media cache, in small batches with progress.
      const media = await caches.open(MEDIA_CACHE);
      const urls = bundle.cards.flatMap(mediaUrls);
      let done = 0;
      for (let i = 0; i < urls.length; i += 8) {
        await Promise.all(urls.slice(i, i + 8).map(async (u) => {
          try { const resp = await fetch(u); if (resp.ok) await media.put(u, resp); } catch (e) {}
          prog.textContent = `media ${++done}/${urls.length}`;
        }));
      }

      // 3) cards -> IndexedDB.
      await bulkPut('cards', bundle.cards);
      prog.textContent = 'done';
      toast('Downloaded ' + bundle.cards.length + ' cards');
      renderLibrary();
    } catch (e) {
      prog.textContent = 'failed: ' + e.message;
      btn.disabled = false;
    }
  }

  async function deleteDeck(source, row) {
    if (!confirm('Delete this downloaded deck? Your review progress for its cards stays.')) return;
    const cards = (await getAll('cards')).filter((c) => c.source === source);
    const media = await caches.open(MEDIA_CACHE);
    await Promise.all(cards.flatMap((c) => mediaUrls(c)).map((u) => media.delete(u)));
    await Promise.all(cards.map((c) => delOne('cards', c.id)));
    toast('Deleted ' + cards.length + ' cards');
    renderLibrary();
  }

  async function updateStorageLine() {
    let line = '';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      line = fmtBytes(est.usage || 0) + ' used on device';
    }
    const cards = await getAll('cards');
    $('storeline').textContent = (cards.length + ' cards offline' + (line ? ' · ' + line : '')) +
      ' · iOS may clear this if storage runs low';
  }

  // ---- Browse / search ----------------------------------------------------
  async function runSearch(q) {
    const box = $('browse-results');
    q = (q || '').trim().toLowerCase();
    const cards = await getAll('cards');
    if (cards.length === 0) { box.innerHTML = '<p class="emptyhint">Download a deck from the Library tab first.</p>'; return; }
    let hits = cards;
    if (q) hits = cards.filter((c) =>
      c.characters.toLowerCase().includes(q) ||
      c.jyutping.toLowerCase().includes(q) ||
      (c.english || '').toLowerCase().includes(q));
    hits = hits.slice(0, 200);
    box.innerHTML = '';
    if (hits.length === 0) { box.innerHTML = '<p class="emptyhint">No matches.</p>'; return; }
    const frag = document.createDocumentFragment();
    hits.forEach((c) => frag.appendChild(cardEl(c, savedSet)));
    box.appendChild(frag);
  }

  // Save / unsave via event delegation (matches dict.js style).
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.btn-save');
    if (!btn) return;
    const id = btn.dataset.card;
    if (savedSet.has(id)) {
      await delOne(SRS, id); savedSet.delete(id);
      btn.classList.remove('is-saved'); btn.querySelector('.lbl').textContent = '+ Save'; btn.setAttribute('aria-pressed', 'false');
    } else {
      await putOne(SRS, { id, ...newState() }); savedSet.add(id);
      btn.classList.add('is-saved'); btn.querySelector('.lbl').textContent = '✓ Saved'; btn.setAttribute('aria-pressed', 'true');
    }
    refreshSaved();
  });

  // ---- Review -------------------------------------------------------------
  let queue = [];      // card ids due now
  let cardById = {};

  async function startReview() {
    const cards = await getAll('cards');
    cardById = Object.fromEntries(cards.map((c) => [c.id, c]));
    const srsAll = await getAll(SRS);
    const now = Date.now();
    queue = srsAll.filter((s) => Date.parse(s.due) <= now && cardById[s.id])
                  .sort((a, b) => a.due.localeCompare(b.due)).map((s) => s.id);
    renderReview();
  }

  function renderReview() {
    const stage = $('rev-stage');
    $('rev-counts').textContent = queue.length + ' due';
    if (queue.length === 0) {
      stage.innerHTML = '<p class="emptyhint">Nothing due. Save cards from Browse, or come back later.</p>';
      return;
    }
    const card = cardById[queue[0]];
    stage.innerHTML = '';
    const flash = document.createElement('div');
    flash.appendChild(cardEl(card, savedSet));
    // Hide the answer (english) until revealed.
    const eng = flash.querySelector('.eng'); eng.style.display = 'none';
    const reveal = document.createElement('button');
    reveal.className = 'reveal-btn'; reveal.textContent = 'Show answer';
    reveal.onclick = () => { eng.style.display = ''; reveal.remove(); flash.appendChild(grades()); };
    stage.appendChild(flash);
    stage.appendChild(reveal);
  }

  function grades() {
    const wrap = document.createElement('div');
    wrap.className = 'grades';
    [[AGAIN, 'Again', 'now'], [HARD, 'Hard', ''], [GOOD, 'Good', '1d'], [EASY, 'Easy', '4d']].forEach(([g, lbl]) => {
      const b = document.createElement('button');
      b.innerHTML = lbl + '<small>' + ({ 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[g]) + '</small>';
      b.onclick = () => grade(queue[0], g);
      wrap.appendChild(b);
    });
    return wrap;
  }

  async function grade(id, g) {
    const st = (await getOne(SRS, id)) || { id, ...newState() };
    schedule(st, g);
    await putOne(SRS, st);
    queue.shift();
    // "Again" re-queues the card for later in the same session.
    if (g === AGAIN) queue.push(id);
    await refreshSaved();
    renderReview();
  }

  // ---- tabs + boot --------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'lib') renderLibrary();
    if (name === 'browse') runSearch($('search').value);
    if (name === 'review') startReview();
  }
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('search').addEventListener('input', (e) => runSearch(e.target.value));

  function setNet() {
    $('netdot').classList.toggle('online', navigator.onLine);
    $('netdot').title = navigator.onLine ? 'online — can sync' : 'offline';
  }
  window.addEventListener('online', setNet);
  window.addEventListener('offline', setNet);

  // Load (or reload) all profile-specific views. Called after a profile is
  // chosen and whenever it changes.
  async function startApp() {
    await refreshSaved();
    showTab('lib');   // renders the library + storage line
  }

  // Profile picker: choosing closes the gate and (re)loads the deck/theme.
  $('profile-gate').addEventListener('click', (e) => {
    const btn = e.target.closest('.pg-btn');
    if (!btn) return;
    setProfile(btn.dataset.profile);
    $('profile-gate').hidden = true;
    startApp();
  });
  $('whoami').addEventListener('click', showGate);

  async function boot() {
    if ('serviceWorker' in navigator) {
      // Relative registration in the static build (scope = the deploy subpath);
      // root-scoped on the server so /media + /api are covered.
      try {
        await (STATIC ? navigator.serviceWorker.register('sw.js', { scope: './' })
                      : navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      } catch (e) {}
    }
    setNet();
    let saved = null;
    try { saved = localStorage.getItem('canto-profile'); } catch (e) {}
    if (saved && PROFILES.includes(saved)) {
      setProfile(saved);
      await startApp();
    } else {
      showGate();   // first run — pick a profile before anything loads
    }
  }
  boot();
})();
