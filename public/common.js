// Shared helpers: header, auth modal, formatting.

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

function videoCard(v, { side = false } = {}) {
  const thumb = v.thumbnail
    ? `<img src="/thumbs/${esc(v.thumbnail)}" alt="" loading="lazy">`
    : '&#9875;';
  const duration = v.duration ? `<span class="duration">${formatDuration(v.duration)}</span>` : '';
  const meta = `${formatViews(v.views)} views &middot; ${timeAgo(v.created_at)}`;
  if (side) {
    return `<a class="side-card" href="/watch/${esc(v.id)}">
      <div class="thumb">${thumb}${duration}</div>
      <div>
        <div class="title">${esc(v.title)}</div>
        <div class="meta">${esc(v.channel_name)}<br>${meta}</div>
      </div>
    </a>`;
  }
  return `<a class="card" href="/watch/${esc(v.id)}">
    <div class="thumb">${thumb}${duration}</div>
    <div class="info">
      <div class="title">${esc(v.title)}</div>
      <div class="meta">${esc(v.channel_name)} &middot; ${meta}</div>
    </div>
  </a>`;
}

// ---------- header ----------

function renderHeader() {
  const q = new URLSearchParams(location.search).get('q') || '';
  document.body.insertAdjacentHTML('afterbegin', `
    <header>
      <a class="logo" href="/"><span class="mark">&#9875;</span> Anchor</a>
      <form class="search" action="/" method="get" role="search" autocomplete="off">
        <div class="search-box">
          <input name="q" id="search-input" type="search" placeholder="Search" value="${esc(q)}"
            aria-label="Search" aria-autocomplete="list" aria-controls="suggest-list" aria-expanded="false">
          <ul class="suggest" id="suggest-list" role="listbox" hidden></ul>
        </div>
        <button type="submit" aria-label="Search">&#128269;</button>
      </form>
      <div class="header-actions" id="header-actions"></div>
    </header>
  `);
  initAutocomplete();
  refreshHeaderActions();
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
