// Shared helpers: header, sidebar, theme, toasts, auth modal, formatting.

// Apply the saved theme as early as possible to limit any flash.
document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';

let ME = null;

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
async function mountFeed(fetchPage, { emptyMsg = 'Nothing here yet.', card = videoCard } = {}) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  grid.innerHTML = skeletonGrid(8);
  let cursor = null, started = false, busy = false, done = false;

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

function videoCard(v, { side = false, remove = null } = {}) {
  const thumb = v.thumbnail
    ? `<img src="/thumbs/${esc(v.thumbnail)}" alt="" loading="lazy">`
    : '&#9875;';
  const duration = v.is_short
    ? '<span class="duration short-badge">&#9889; SHORT</span>'
    : (v.duration ? `<span class="duration">${formatDuration(v.duration)}</span>` : '');
  const href = v.is_short ? `/shorts/${esc(v.id)}` : `/watch/${esc(v.id)}`;
  const resume = (v.position && v.duration)
    ? `<div class="resume-bar"><div style="width:${Math.min(100, 100 * v.position / v.duration)}%"></div></div>`
    : '';
  const wl = (ME && !remove)
    ? `<button class="thumb-btn wl-btn" title="Save to Watch Later" aria-label="Save to Watch Later"
        onclick="toggleWatchLater(event,'${esc(v.id)}')">&#128278;</button>` : '';
  const rm = remove
    ? `<button class="thumb-btn card-x" title="Remove" aria-label="Remove"
        onclick="removeFromFeed(event,'${remove}','${esc(v.id)}')">&times;</button>` : '';
  const meta = `${formatViews(v.views)} views &middot; ${timeAgo(v.created_at)}`;
  if (side) {
    return `<a class="side-card" href="${href}">
      <div class="thumb">${thumb}${duration}${resume}</div>
      <div>
        <div class="title">${esc(v.title)}</div>
        <div class="meta">${esc(v.channel_name)}<br>${meta}</div>
      </div>
    </a>`;
  }
  return `<a class="card" href="${href}">
    <div class="thumb">${thumb}${duration}${resume}${wl}${rm}</div>
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
    : '&#9889;';
  return `<a class="card short-card" href="/shorts/${esc(v.id)}">
    <div class="thumb">${thumb}</div>
    <div class="info">
      <div class="title">${esc(v.title)}</div>
      <div class="meta">${formatViews(v.views)} views</div>
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
  const q = new URLSearchParams(location.search).get('q') || '';
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <button class="icon-btn menu-btn" id="menu-btn" aria-label="Toggle menu" aria-expanded="false">&#9776;</button>
      <a class="logo" href="/"><span class="mark">&#9875;</span> Anchor</a>
      <form class="search" action="/" method="get" role="search" autocomplete="off">
        <div class="search-box">
          <input name="q" id="search-input" type="search" placeholder="Search" value="${esc(q)}"
            aria-label="Search" aria-autocomplete="list" aria-controls="suggest-list" aria-expanded="false">
          <ul class="suggest" id="suggest-list" role="listbox" hidden></ul>
        </div>
        <button type="submit" aria-label="Search">&#128269;</button>
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
  [['/', '\u{1F3E0}', 'Home'], ['/shorts', '⚡', 'Shorts'],
   ['/trending', '\u{1F525}', 'Trending'], ['/browse', '\u{1F5C2}', 'Browse']],
  [['/subscriptions', '\u{1F4FA}', 'Subscriptions'], ['/history', '\u{1F553}', 'History'],
   ['/liked', '\u{1F44D}', 'Liked'], ['/later', '\u{1F516}', 'Watch Later']],
];

function renderSidebar() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.app-shell')) return;
  const here = location.pathname;
  const link = ([href, icon, label]) =>
    `<a href="${href}" class="nav-link${here === href ? ' active' : ''}"
        ${here === href ? 'aria-current="page"' : ''}><span class="ic" aria-hidden="true">${icon}</span> ${label}</a>`;
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
  const paint = () => { btn.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☽'; };
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
      <button class="primary" onclick="location.href='/upload'">+ Upload</button>
      <a class="me" href="/channel/${ME.id}">&#9875; <b>${esc(ME.username)}</b></a>
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
  document.dispatchEvent(new CustomEvent('auth-ready'));
}

// ---------- auth modal ----------

function openAuthModal(mode) {
  closeAuthModal();
  const isLogin = mode === 'login';
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="auth-modal">
      <div class="modal">
        <h2>${isLogin ? 'Sign in to Anchor' : 'Create your account'}</h2>
        <form id="auth-form">
          <div class="field"><label>Username</label>
            <input name="username" required autocomplete="username" autofocus></div>
          <div class="field"><label>Password</label>
            <input name="password" type="password" required
              autocomplete="${isLogin ? 'current-password' : 'new-password'}"></div>
          <button class="primary" style="width:100%">${isLogin ? 'Sign in' : 'Register'}</button>
          <div class="error-msg" id="auth-error"></div>
        </form>
        <div class="switch">${isLogin
          ? `New here? <a onclick="openAuthModal('register')">Create an account</a>`
          : `Already have an account? <a onclick="openAuthModal('login')">Sign in</a>`}
        </div>
      </div>
    </div>
  `);
  const backdrop = document.getElementById('auth-modal');
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeAuthModal(); });
  document.getElementById('auth-form').onsubmit = async e => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      await api(isLogin ? '/api/login' : '/api/register', {
        method: 'POST',
        json: { username: form.get('username'), password: form.get('password') },
      });
      location.reload();
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  };
}

function closeAuthModal() {
  const el = document.getElementById('auth-modal');
  if (el) el.remove();
}

renderHeader();
