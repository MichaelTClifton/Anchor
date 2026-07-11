// Shared helpers: header, sidebar, theme, toasts, auth modal, formatting.

// Apply the saved theme as early as possible to limit any flash.
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';

let ME = null;

// ---------- flat icon set ----------
// Hard-edged inline SVGs (square caps, miter joins) so the whole UI shares one
// geometric, flat style. stroke/fill follow currentColor.

const ICONS = {
  anchor: '<circle cx="12" cy="5" r="2.5"/><path d="M12 7.5V21M4 13c0 5 3.6 8 8 8s8-3 8-8M8 11h8"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  bolt: '<path fill="currentColor" stroke="none" d="M13 2L5 13.5h5L9 22l10-12h-6l2-8h-2z"/>',
  flame: '<path d="M3 17l6-6 4 4 8-9"/><path d="M15 6h6v6"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  tv: '<rect x="3" y="7" width="18" height="13"/><path d="M8 2l4 4.5L16 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5h4.5"/>',
  thumb: '<path d="M7 11v10H3V11h4zm0 0l4-9c1.7 0 2.8 1.1 2.6 2.8L13 9h8l-2.2 12H7"/>',
  thumbdown: '<path d="M17 13V3h4v10h-4zm0 0l-4 9c-1.7 0-2.8-1.1-2.6-2.8L11 15H3l2.2-12H17"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21V3z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sun: '<rect x="8" y="8" width="8" height="8"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22M4.5 4.5L7 7M17 17l2.5 2.5M19.5 4.5L17 7M7 17l-2.5 2.5"/>',
  moon: '<path d="M20 13.5A8.5 8.5 0 1110.5 4 6.8 6.8 0 0020 13.5z"/>',
  gear: '<path d="M3 7h10M19 7h2M3 17h6M15 17h6"/><rect x="13" y="4.5" width="6" height="5"/><rect x="9" y="14.5" width="6" height="5"/>',
  x: '<path d="M5 5l14 14M19 5L5 19"/>',
  comment: '<path d="M3 4h18v13H9l-6 5V4z"/>',
  sound: '<path d="M4 9v6h4l6 5V4L8 9H4z"/><path d="M17 8.5c2 2 2 5 0 7"/>',
  mute: '<path d="M4 9v6h4l6 5V4L8 9H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
  share: '<path d="M12 15V3M7 8l5-5 5 5M5 13v8h14v-8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5l12 7-12 7V5z"/>',
  pip: '<rect x="2" y="4" width="20" height="15"/><rect x="12" y="11" width="8" height="6" fill="currentColor" stroke="none"/>',
  theater: '<rect x="2" y="6" width="20" height="12"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.5 11.5L21 2M16 7l3 3M13 10l2.5 2.5"/>',
  phone: '<rect x="7" y="2" width="10" height="20"/><path d="M10.5 18.5h3"/>',
  mic: '<rect x="9" y="2" width="6" height="12"/><path d="M5 11a7 7 0 0014 0M12 18v4M8 22h8"/>',
  shield: '<path d="M12 2l8 3v7c0 5-3.5 8-8 10-4.5-2-8-5-8-10V5l8-3z"/>',
  user: '<circle cx="12" cy="7.5" r="3.5"/><path d="M4 21c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5"/>',
  check: '<path d="M4 12.5L10 18 20 6"/>',
  upload: '<path d="M12 16V3M7 8l5-5 5 5M4 14v7h16v-7"/>',
  flag: '<path d="M5 21V3h14l-3 5 3 5H5"/>',
  live: '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M7.5 16.5a6.5 6.5 0 010-9M16.5 7.5a6.5 6.5 0 010 9M4.5 19.5a10.5 10.5 0 010-15M19.5 4.5a10.5 10.5 0 010 15"/>',
};

function icon(name, cls = '') {
  return `<svg class="ic-svg${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter"
    aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Static pages mark elements with data-icon="name"; filled in on load.
function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function timeAgo(unixSeconds) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - unixSeconds));
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'],
    [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
}

function formatViews(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function subscriberLabel(n) {
  return `${formatViews(n)} subscriber${n === 1 ? '' : 's'}`;
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  if (options.json) {
    options.body = JSON.stringify(options.json);
    options.headers = { 'Content-Type': 'application/json' };
    delete options.json;
  }
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- toasts ----------

function toast(msg, type = '') {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

// ---------- skeleton placeholders ----------

function skeletonGrid(n = 8) {
  return Array.from({ length: n }, () => `<div class="card sk-card">
    <div class="thumb skeleton"></div>
    <div class="info"><div class="sk-line skeleton"></div>
      <div class="sk-line short skeleton"></div></div>
  </div>`).join('');
}

// ---------- paginated feed with infinite scroll ----------
// fetchPage(cursor) must resolve to { videos, nextCursor }. Renders into #grid.
// surface ('home' | null) turns on impression logging for signed-in viewers.
async function mountFeed(fetchPage, { emptyMsg = 'Nothing here yet.', card = null, surface = null } = {}) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  if (!card) card = surface === 'home' ? v => videoCard(v, { ni: true }) : videoCard;
  grid.innerHTML = skeletonGrid(8);
  let cursor = null, started = false, busy = false, done = false;

  // Impression logging: observe each card once; when it becomes at least half
  // visible its id joins a pending batch. Batches flush at 20 ids / every 5s /
  // on page exit, and losses are fine — never toast, never send when signed
  // out (ME is checked at flush time since auth may resolve after mount).
  let observeNew = () => {};
  if (surface) {
    const pending = new Set();
    const observed = new WeakSet();
    const take = () => {
      const ids = [...pending].slice(0, 50);
      for (const id of ids) pending.delete(id);
      return ids;
    };
    const flush = () => {
      if (!ME || !pending.size) return;
      fetch('/api/impressions', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface, video_ids: take() }),
      }).catch(() => {});
    };
    const beaconFlush = () => {
      if (!ME) return;
      while (pending.size) {
        navigator.sendBeacon('/api/impressions',
          new Blob([JSON.stringify({ surface, video_ids: take() })], { type: 'application/json' }));
      }
    };
    const impObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        impObserver.unobserve(en.target);
        pending.add(en.target.dataset.id);
      }
      if (pending.size >= 20) flush();
    }, { threshold: 0.5 });
    observeNew = () => {
      for (const el of grid.children) {
        if (el.dataset.id && !observed.has(el)) { observed.add(el); impObserver.observe(el); }
      }
    };
    setInterval(flush, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') beaconFlush();
    });
    window.addEventListener('pagehide', beaconFlush);
  }

  async function fetchInto() {
    busy = true;
    let data;
    try {
      data = await fetchPage(cursor);
    } catch (e) {
      if (!started) grid.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      else toast(e.message, 'error');
      busy = false; done = true;
      return;
    }
    const vids = data.videos || [];
    if (!started) { grid.innerHTML = ''; started = true; }
    grid.insertAdjacentHTML('beforeend', vids.map(card).join(''));
    observeNew();
    cursor = data.nextCursor || null;
    if (!cursor) done = true;
    if (!grid.children.length) grid.innerHTML = `<div class="empty">${esc(emptyMsg)}</div>`;
    busy = false;
  }

  await fetchInto();
  if (done) return;

  const sentinel = document.createElement('div');
  sentinel.className = 'scroll-sentinel';
  grid.after(sentinel);
  const io = new IntersectionObserver(async entries => {
    if (entries[0].isIntersecting && !busy && !done) {
      await fetchInto();
      if (done) { io.disconnect(); sentinel.remove(); }
    }
  }, { rootMargin: '600px' });
  io.observe(sentinel);
}

function videoCard(v, { side = false, remove = null, ni = false } = {}) {
  const thumb = v.thumbnail
    ? `<img src="/thumbs/${esc(v.thumbnail)}" alt="" loading="lazy">`
    : icon('anchor', 'ph');
  const duration = v.is_short
    ? '<span class="duration short-badge">SHORT</span>'
    : (v.duration ? `<span class="duration">${formatDuration(v.duration)}</span>` : '');
  const href = v.is_short ? `/shorts/${esc(v.id)}` : `/watch/${esc(v.id)}`;
  const resume = (v.position && v.duration)
    ? `<div class="resume-bar"><div style="width:${Math.min(100, 100 * v.position / v.duration)}%"></div></div>`
    : '';
  const wl = (ME && !remove)
    ? `<button class="thumb-btn wl-btn" title="Save to Watch Later" aria-label="Save to Watch Later"
        onclick="toggleWatchLater(event,'${esc(v.id)}')">${icon('bookmark')}</button>` : '';
  const rm = remove
    ? `<button class="thumb-btn card-x" title="Remove" aria-label="Remove"
        onclick="removeFromFeed(event,'${remove}','${esc(v.id)}')">${icon('x')}</button>` : '';
  const nib = (ni && ME && !remove)
    ? `<button class="thumb-btn ni-btn" title="Not interested" aria-label="Not interested"
        onclick="notInterested(event,'${esc(v.id)}')">${icon('x')}</button>` : '';
  const meta = `${formatViews(v.views)} views &middot; ${timeAgo(v.created_at)}`;
  if (side) {
    return `<a class="side-card" href="${href}" data-id="${esc(v.id)}">
      <div class="thumb">${thumb}${duration}${resume}</div>
      <div>
        <div class="title">${esc(v.title)}</div>
        <div class="meta">${esc(v.channel_name)}<br>${meta}</div>
      </div>
    </a>`;
  }
  return `<a class="card" href="${href}" data-id="${esc(v.id)}">
    <div class="thumb">${thumb}${duration}${resume}${wl}${nib}${rm}</div>
    <div class="info">
      <div class="title">${esc(v.title)}</div>
      <div class="meta">${esc(v.channel_name)} &middot; ${meta}</div>
    </div>
  </a>`;
}

// Vertical 9:16 card used by the Shorts shelf on the home page.
function shortCard(v) {
  const thumb = v.thumbnail
    ? `<img src="/thumbs/${esc(v.thumbnail)}" alt="" loading="lazy">`
    : icon('bolt', 'ph');
  return `<a class="card short-card" href="/shorts/${esc(v.id)}">
    <div class="thumb">${thumb}</div>
    <div class="info">
      <div class="title">${esc(v.title)}</div>
      <div class="meta">${formatViews(v.views)} views</div>
    </div>
  </a>`;
}

// Card for a live stream (live grid + home shelf).
function liveCard(s) {
  return `<a class="card live-card" href="/live/${esc(s.id)}">
    <div class="thumb"><span class="ph-initial">${esc(s.channel_name[0].toUpperCase())}</span>
      <span class="duration live-badge">LIVE</span></div>
    <div class="info">
      <div class="title">${esc(s.title || s.channel_name + ' is live')}</div>
      <div class="meta">${esc(s.channel_name)} &middot; ${formatViews(s.viewers)} watching</div>
    </div>
  </a>`;
}

// Toggle Watch Later from a card overlay button.
async function toggleWatchLater(e, id) {
  e.preventDefault(); e.stopPropagation();
  if (!ME) return openAuthModal('login');
  try {
    const r = await api('/api/watch-later', { method: 'POST', json: { video_id: id } });
    toast(r.in_watch_later ? 'Saved to Watch Later' : 'Removed from Watch Later');
  } catch (err) { toast(err.message, 'error'); }
}

// Tell the recommender to show fewer videos like this one (card overlay button).
async function notInterested(e, id) {
  e.preventDefault(); e.stopPropagation();
  if (!ME) return openAuthModal('login');
  try {
    await api(`/api/videos/${encodeURIComponent(id)}/not-interested`, { method: 'POST' });
    const card = e.target.closest('.card');
    if (card) card.remove();
    toast('Got it — fewer videos like this.');
  } catch (err) { toast(err.message, 'error'); }
}

// Remove a card from a History or Watch Later feed.
async function removeFromFeed(e, kind, id) {
  e.preventDefault(); e.stopPropagation();
  const url = kind === 'later'
    ? `/api/watch-later/${encodeURIComponent(id)}`
    : `/api/history/${encodeURIComponent(id)}`;
  try {
    await api(url, { method: 'DELETE' });
    const card = e.target.closest('.card');
    if (card) card.remove();
  } catch (err) { toast(err.message, 'error'); }
}

// Standard single-feed page: sets heading, gates on auth if needed, mounts grid.
function simpleFeedPage({ heading, endpoint, emptyMsg, auth = false, card = videoCard }) {
  document.title = `${heading} - Anchor`;
  document.addEventListener('auth-ready', () => {
    const h = document.getElementById('page-heading');
    if (h) h.textContent = heading;
    if (auth && !ME) {
      document.getElementById('grid').innerHTML =
        `<div class="empty">Sign in to see this.<br><br>
         <button class="primary" onclick="openAuthModal('login')">Sign in</button></div>`;
      return;
    }
    mountFeed(cursor => api(endpoint + (cursor
      ? (endpoint.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor) : '')),
      { emptyMsg, card });
  }, { once: true });
}

// ---------- header ----------

function renderHeader() {
  // The splash and reset pages get a minimal header: logo + sign in.
  if (document.body.classList.contains('splash-page')) {
    document.body.insertAdjacentHTML('afterbegin', `
      <header class="splash-header">
        <a class="logo" href="/"><span class="mark" data-icon="anchor"></span> Anchor</a>
        <div class="header-actions">
          <button class="primary" onclick="openAuthModal('login')">Sign in</button>
        </div>
      </header>`);
    return;
  }
  const q = new URLSearchParams(location.search).get('q') || '';
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <button class="icon-btn menu-btn" id="menu-btn" aria-label="Toggle menu" aria-expanded="false">${icon('menu')}</button>
      <a class="logo" href="/"><span class="mark">${icon('anchor')}</span> Anchor</a>
      <form class="search" action="/" method="get" role="search" autocomplete="off">
        <div class="search-box">
          <input name="q" id="search-input" type="search" placeholder="Search" value="${esc(q)}"
            aria-label="Search" aria-autocomplete="list" aria-controls="suggest-list" aria-expanded="false">
          <ul class="suggest" id="suggest-list" role="listbox" hidden></ul>
        </div>
        <button type="submit" aria-label="Search">${icon('search')}</button>
      </form>
      <button class="icon-btn" id="theme-toggle" aria-label="Toggle light or dark theme" title="Toggle theme"></button>
      <div class="header-actions" id="header-actions"></div>
    </header>
  `);
  renderSidebar();
  initTheme();
  initAutocomplete();
  refreshHeaderActions();
}

// ---------- sidebar ----------

const SIDEBAR_SECTIONS = [
  [['/', 'home', 'Home'], ['/live', 'live', 'Live'], ['/shorts', 'bolt', 'Shorts'],
   ['/trending', 'flame', 'Trending'], ['/browse', 'grid', 'Browse']],
  [['/subscriptions', 'tv', 'Subscriptions'], ['/history', 'clock', 'History'],
   ['/liked', 'thumb', 'Liked'], ['/later', 'bookmark', 'Watch Later']],
];

function renderSidebar() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.app-shell')) return;
  const here = location.pathname;
  const link = ([href, ic, label]) =>
    `<a href="${href}" class="nav-link${here === href ? ' active' : ''}"
        ${here === href ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${icon(ic)}</span> ${label}</a>`;
  const nav = document.createElement('nav');
  nav.className = 'sidebar';
  nav.id = 'sidebar';
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = SIDEBAR_SECTIONS.map((sec, i) =>
    `<div class="nav-section">${sec.map(link).join('')}</div>`).join('');

  const shell = document.createElement('div');
  shell.className = 'app-shell';
  main.parentNode.insertBefore(shell, main);
  shell.appendChild(nav);
  shell.appendChild(main);

  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  backdrop.id = 'sidebar-backdrop';
  document.body.appendChild(backdrop);
  const close = () => { nav.classList.remove('open'); backdrop.classList.remove('show');
    document.getElementById('menu-btn').setAttribute('aria-expanded', 'false'); };
  backdrop.onclick = close;
  document.getElementById('menu-btn').onclick = () => {
    const open = nav.classList.toggle('open');
    backdrop.classList.toggle('show', open);
    document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
  };
}

// ---------- theme ----------

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  const paint = () => { btn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'); };
  paint();
  btn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    paint();
  };
}

// Search-as-you-type dropdown wired to /api/search/suggest.
function initAutocomplete() {
  const input = document.getElementById('search-input');
  const list = document.getElementById('suggest-list');
  if (!input) return;
  let items = [], active = -1, timer = null;

  const go = value => { location.href = '/?q=' + encodeURIComponent(value); };
  function close() {
    list.hidden = true; list.innerHTML = ''; items = []; active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function render() {
    list.innerHTML = items.map((s, i) =>
      `<li role="option" id="sug-${i}" class="${i === active ? 'active' : ''}">${esc(s)}</li>`).join('');
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', items.length ? 'true' : 'false');
    [...list.children].forEach((li, i) => {
      li.onmousedown = e => { e.preventDefault(); go(items[i]); };
    });
  }
  function highlight() {
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    if (active >= 0) input.setAttribute('aria-activedescendant', `sug-${active}`);
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      try {
        const { suggestions } = await api('/api/search/suggest?q=' + encodeURIComponent(q));
        items = suggestions; active = -1; render();
      } catch (e) { close(); }
    }, 150);
  });
  input.addEventListener('keydown', e => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; highlight(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); go(items[active]); }
    else if (e.key === 'Escape') { close(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.search')) close(); });
}

async function refreshHeaderActions() {
  try {
    ME = (await api('/api/me')).user;
  } catch (e) {
    ME = null;
  }
  const el = document.getElementById('header-actions');
  if (ME) {
    el.innerHTML = `
      <a class="icon-btn" href="/studio" title="Go live" aria-label="Go live">${icon('live')}</a>
      <button class="primary" onclick="location.href='/upload'">${icon('upload')} Upload</button>
      <a class="me" href="/channel/${ME.id}">${icon('user')} <b>${esc(ME.username)}</b></a>
      ${ME.role === 'admin' ? `<a class="icon-btn admin-link" href="/admin" title="Moderation queue"
        aria-label="Moderation queue">${icon('shield')}${ME.open_reports
          ? `<span class="badge">${ME.open_reports > 99 ? '99+' : ME.open_reports}</span>` : ''}</a>` : ''}
      <a class="icon-btn" href="/settings" title="Account settings" aria-label="Account settings">${icon('gear')}</a>
      <button id="logout-btn">Sign out</button>
    `;
    el.querySelector('#logout-btn').onclick = async () => {
      await api('/api/logout', { method: 'POST' });
      location.reload();
    };
  } else {
    el.innerHTML = `<button class="primary" id="signin-btn">Sign in</button>`;
    el.querySelector('#signin-btn').onclick = () => openAuthModal('login');
  }
  window.AUTH_DONE = true;
  document.dispatchEvent(new CustomEvent('auth-ready'));
}

// Race-proof 'auth-ready': large blocking scripts (e.g. the vendored hls.js)
// between common.js and a page's inline script can delay listener
// registration past the event dispatch. Pages should use this instead of
// addEventListener directly.
function onAuthReady(fn) {
  if (window.AUTH_DONE) fn();
  else document.addEventListener('auth-ready', fn, { once: true });
}

// ---------- report modal ----------
// Reporting works anywhere content renders (watch page, shorts rail,
// comments); signed-out viewers are routed to sign-in first.

const REPORT_REASONS = [
  ['spam', 'Spam or misleading'],
  ['harassment', 'Harassment or hate'],
  ['sexual', 'Sexual content'],
  ['violence', 'Violent or dangerous content'],
  ['copyright', 'Copyright infringement'],
  ['other', 'Something else'],
];

function openReportModal(targetType, targetId) {
  if (!ME) return openAuthModal('login');
  closeReportModal();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="report-modal">
      <div class="modal">
        <h2>Report ${targetType === 'comment' ? 'comment' : 'video'}</h2>
        <form id="report-form">
          <div class="report-reasons">
            ${REPORT_REASONS.map(([value, label]) => `
              <label class="check-row"><input type="radio" name="reason" value="${value}" required>
                <span>${label}</span></label>`).join('')}
          </div>
          <div class="field" style="margin-top:14px"><label>Details (optional)</label>
            <textarea name="details" rows="3" maxlength="500"></textarea></div>
          <button class="primary" style="width:100%">Submit report</button>
          <div class="error-msg" id="report-error"></div>
        </form>
        <div class="switch"><a id="report-cancel">Cancel</a></div>
      </div>
    </div>`);
  const backdrop = document.getElementById('report-modal');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeReportModal(); });
  document.getElementById('report-cancel').onclick = closeReportModal;
  document.getElementById('report-form').onsubmit = async e => {
    e.preventDefault();
    const data = new FormData(e.target);
    try {
      await api('/api/report', {
        method: 'POST',
        json: {
          target_type: targetType, target_id: String(targetId),
          reason: data.get('reason'), details: data.get('details'),
        },
      });
      closeReportModal();
      toast('Report submitted — thank you');
    } catch (err) {
      document.getElementById('report-error').textContent = err.message;
    }
  };
}

function closeReportModal() {
  const el = document.getElementById('report-modal');
  if (el) el.remove();
}

// ---------- passkeys (WebAuthn client side) ----------

function b64uToBuf(s) {
  return Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
function bufToB64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function passkeysSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

// Register a new passkey for the signed-in user.
async function createPasskey(name) {
  if (!passkeysSupported()) throw new Error('This browser does not support passkeys.');
  const { ticket, options } = await api('/api/passkeys/register/options', { method: 'POST', json: {} });
  options.challenge = b64uToBuf(options.challenge);
  options.user.id = b64uToBuf(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || [])
    .map(c => ({ ...c, id: b64uToBuf(c.id) }));
  const cred = await navigator.credentials.create({ publicKey: options });
  await api('/api/passkeys/register/verify', {
    method: 'POST',
    json: {
      ticket, name,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        attestationObject: bufToB64u(cred.response.attestationObject),
      },
    },
  });
}

// Sign in with any passkey the browser holds for this site.
async function passkeySignIn() {
  if (!passkeysSupported()) throw new Error('This browser does not support passkeys.');
  const { ticket, options } = await api('/api/passkeys/login/options', { method: 'POST', json: {} });
  options.challenge = b64uToBuf(options.challenge);
  const cred = await navigator.credentials.get({ publicKey: options });
  await api('/api/passkeys/login/verify', {
    method: 'POST',
    json: {
      ticket, id: cred.id,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
      },
    },
  });
  location.reload();
}

// ---------- auth modal ----------
// One modal, several views: sign in -> (2FA code) / forgot password,
// register -> secure-your-account (passkey + 2FA setup).

function openAuthModal(mode) {
  closeAuthModal();
  document.body.insertAdjacentHTML('beforeend',
    '<div class="modal-backdrop" id="auth-modal"><div class="modal" id="auth-box"></div></div>');
  const backdrop = document.getElementById('auth-modal');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAuthModal(); });
  (mode === 'register' ? registerView : loginView)(document.getElementById('auth-box'));
}

function closeAuthModal() {
  const el = document.getElementById('auth-modal');
  if (el) el.remove();
}

function authError(box, msg) {
  const el = box.querySelector('#auth-error');
  if (el) el.textContent = msg;
}

function loginView(box) {
  box.innerHTML = `
    <h2>Sign in to Anchor</h2>
    <form id="auth-form">
      <div class="field"><label>Username</label>
        <input name="username" required autocomplete="username" autofocus></div>
      <div class="field"><label>Password</label>
        <input name="password" type="password" required autocomplete="current-password"></div>
      <button class="primary" style="width:100%">Sign in</button>
      <div class="error-msg" id="auth-error"></div>
    </form>
    <div class="auth-alt">
      <a id="forgot-link" class="linkish">Forgot password?</a>
      ${passkeysSupported()
        ? `<button type="button" id="passkey-signin">${icon('key')} Sign in with a passkey</button>` : ''}
    </div>
    <div class="switch">New here? <a id="to-register">Create an account</a></div>`;
  box.querySelector('#to-register').onclick = () => registerView(box);
  box.querySelector('#forgot-link').onclick = () => forgotView(box);
  const pk = box.querySelector('#passkey-signin');
  if (pk) pk.onclick = async () => {
    try { await passkeySignIn(); }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') authError(box, e.message); }
  };
  box.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const r = await api('/api/login', {
        method: 'POST',
        json: { username: form.get('username'), password: form.get('password') },
      });
      if (r.totp_required) return totpLoginView(box, r.ticket);
      location.reload();
    } catch (err) { authError(box, err.message); }
  };
}

function totpLoginView(box, ticket) {
  box.innerHTML = `
    <h2>Two-factor authentication</h2>
    <p class="modal-note">Enter the 6-digit code from your authenticator app.</p>
    <form id="auth-form">
      <div class="field"><label>Authentication code</label>
        <input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
          autocomplete="one-time-code" autofocus></div>
      <button class="primary" style="width:100%">Verify</button>
      <div class="error-msg" id="auth-error"></div>
    </form>
    <div class="switch"><a id="back-login">Back to sign in</a></div>`;
  box.querySelector('#back-login').onclick = () => loginView(box);
  box.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/login/totp', {
        method: 'POST',
        json: { ticket, code: new FormData(e.target).get('code') },
      });
      location.reload();
    } catch (err) { authError(box, err.message); }
  };
}

function forgotView(box) {
  box.innerHTML = `
    <h2>Reset your password</h2>
    <p class="modal-note">Enter your account's email address and we'll send a reset link.</p>
    <form id="auth-form">
      <div class="field"><label>Email</label>
        <input name="email" type="email" required autocomplete="email" autofocus></div>
      <button class="primary" style="width:100%">Send reset link</button>
      <div class="error-msg" id="auth-error"></div>
    </form>
    <div class="switch"><a id="back-login">Back to sign in</a></div>`;
  box.querySelector('#back-login').onclick = () => loginView(box);
  box.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/recover', {
        method: 'POST', json: { email: new FormData(e.target).get('email') },
      });
      box.innerHTML = `
        <h2>Check your email</h2>
        <p class="modal-note">If an account exists for that address, a password reset link is on
          its way. The link works for one hour.</p>
        <div class="switch"><a id="back-login">Back to sign in</a></div>`;
      box.querySelector('#back-login').onclick = () => loginView(box);
    } catch (err) { authError(box, err.message); }
  };
}

function registerView(box) {
  box.innerHTML = `
    <h2>Create your account</h2>
    <form id="auth-form">
      <div class="field"><label>Username</label>
        <input name="username" required autocomplete="username" autofocus></div>
      <div class="field"><label>Email (used for account recovery)</label>
        <input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password (at least 8 characters)</label>
        <input name="password" type="password" required minlength="8" autocomplete="new-password"></div>
      <div class="field"><label>Confirm password</label>
        <input name="password2" type="password" required minlength="8" autocomplete="new-password"></div>
      <label class="check-row terms-row"><input type="checkbox" name="terms" required>
        <span>I agree to the <a href="/guidelines" target="_blank" class="linkish">Community
        Guidelines</a></span></label>
      <button class="primary" style="width:100%">Create account</button>
      <div class="error-msg" id="auth-error"></div>
    </form>
    <div class="switch">Already have an account? <a id="to-login">Sign in</a></div>`;
  box.querySelector('#to-login').onclick = () => loginView(box);
  box.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    if (form.get('password') !== form.get('password2')) {
      return authError(box, 'The two passwords do not match.');
    }
    try {
      await api('/api/register', {
        method: 'POST',
        json: {
          username: form.get('username'), email: form.get('email'),
          password: form.get('password'), password2: form.get('password2'),
          terms: form.get('terms') === 'on',
        },
      });
      securityView(box);
    } catch (err) { authError(box, err.message); }
  };
}

// Post-signup step: offer a passkey and 2FA before entering the site.
function securityView(box) {
  box.innerHTML = `
    <h2>Secure your account</h2>
    <p class="modal-note">Recommended — both take under a minute, and you can also do this
      later in Settings.</p>
    <div class="security-options">
      ${passkeysSupported()
        ? `<button type="button" id="sec-passkey">${icon('key')} Add a passkey
             <span class="sub">Sign in with your fingerprint, face or device PIN</span></button>`
        : ''}
      <button type="button" id="sec-2fa">${icon('phone')} Enable two-factor authentication
        <span class="sub">Require a code from an authenticator app to sign in</span></button>
    </div>
    <div class="error-msg" id="auth-error"></div>
    <button class="primary" id="sec-done" style="width:100%;margin-top:14px">Continue to Anchor</button>`;
  box.querySelector('#sec-done').onclick = () => location.reload();
  const pk = box.querySelector('#sec-passkey');
  if (pk) pk.onclick = async () => {
    try {
      await createPasskey('Passkey');
      pk.disabled = true;
      pk.innerHTML = icon('check') + ' Passkey added';
      authError(box, '');
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') authError(box, e.message);
    }
  };
  box.querySelector('#sec-2fa').onclick = () => totpSetupView(box, () => securityView(box));
}

// Shared by the signup flow and the Settings page (via done callback).
async function totpSetupView(box, done) {
  let setup;
  try { setup = await api('/api/2fa/setup', { method: 'POST', json: {} }); }
  catch (e) { return toast(e.message, 'error'); }
  box.innerHTML = `
    <h2>Set up two-factor authentication</h2>
    <p class="modal-note">Add this secret to an authenticator app (Google Authenticator, 1Password,
      Aegis, ...), then enter the 6-digit code it shows.</p>
    <div class="totp-secret"><code>${esc(setup.secret)}</code></div>
    <p class="modal-note"><a href="${esc(setup.otpauth)}">Open in authenticator app</a></p>
    <form id="auth-form">
      <div class="field"><label>6-digit code</label>
        <input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
          autocomplete="one-time-code" autofocus></div>
      <button class="primary" style="width:100%">Turn on 2FA</button>
      <div class="error-msg" id="auth-error"></div>
    </form>
    <div class="switch"><a id="totp-back">Back</a></div>`;
  box.querySelector('#totp-back').onclick = done;
  box.querySelector('#auth-form').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/2fa/enable', {
        method: 'POST', json: { code: new FormData(e.target).get('code') },
      });
      toast('Two-factor authentication is on');
      done();
    } catch (err) { authError(box, err.message); }
  };
}

renderHeader();
fillIcons();
