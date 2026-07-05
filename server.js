const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR, THUMBS_DIR, reindexVideo } = require('./db');
const transcode = require('./transcode');
const authlib = require('./auth');

const CATEGORIES = ['Music', 'Gaming', 'Education', 'Tech', 'Vlog', 'News', 'Sports', 'Other'];

const PORT = process.env.PORT || 3000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GB
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

const app = express();
app.use(express.json());

// Resolve the viewer once per request. Signed-out visitors only ever reach
// the splash and reset pages; every content page, API and media file needs a
// session.
app.use((req, res, next) => { req.user = getUser(req); next(); });
const pageAuth = (req, res, next) => (req.user ? next() : res.redirect('/'));
const staticAuth = (req, res, next) => (req.user ? next() : res.status(401).end());
app.use((req, res, next) => {
  if (!req.user && /\.html$/.test(req.path)
      && !['/splash.html', '/reset.html'].includes(req.path)) {
    return res.redirect('/');
  }
  next();
});
// index:false so "/" below can pick splash vs home by session.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// express.static handles HTTP Range requests, so seeking in the player works.
app.use('/media', staticAuth, express.static(UPLOADS_DIR));
app.use('/thumbs', staticAuth, express.static(THUMBS_DIR));

// ---------- auth helpers ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function getUser(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]{48})/);
  if (!match) return null;
  return db.prepare(`
    SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(match[1]) || null;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You must be signed in to do that.' });
  next();
}

// ---------- auth routes ----------

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscores.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'A valid email address is required (used for account recovery).' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (password !== password2) {
    return res.status(400).json({ error: 'The two passwords do not match.' });
  }
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), email);
    startSession(res, info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid, username });
  } catch (e) {
    const dup = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    res.status(409).json({ error: dup ? 'That username is taken.' : 'That email is already registered.' });
  }
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (user.totp_enabled) {
    // Two-step sign-in: the password alone earns a short-lived ticket, not a
    // session; the authenticator code redeems it below.
    const ticket = authlib.putChallenge('totp-login', { userId: user.id, attempts: 0 });
    return res.json({ totp_required: true, ticket });
  }
  startSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/login/totp', (req, res) => {
  const ticket = req.body.ticket;
  const data = authlib.peekChallenge('totp-login', ticket);
  if (!data) return res.status(400).json({ error: 'Sign-in expired — start again.' });
  if (++data.attempts > 5) {
    authlib.dropChallenge(ticket);
    return res.status(400).json({ error: 'Too many wrong codes — start again.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(data.userId);
  if (!user || !authlib.verifyTotp(user.totp_secret, req.body.code)) {
    return res.status(401).json({ error: 'That code is not right. Try again.' });
  }
  authlib.dropChallenge(ticket);
  startSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

function startSession(res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`);
}

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]{48})/);
  if (match) db.prepare('DELETE FROM sessions WHERE token = ?').run(match[1]);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: getUser(req) });
});

// ---------- passkeys (WebAuthn) ----------

// rpId/origin are derived per request so dev (localhost) and production both
// work without configuration.
function rpInfo(req) {
  return { rpId: req.hostname, origin: `${req.protocol}://${req.get('host')}` };
}

app.post('/api/passkeys/register/options', requireAuth, (req, res) => {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const ticket = authlib.putChallenge('pk-reg', { userId: req.user.id, challenge });
  const existing = db.prepare('SELECT id FROM passkeys WHERE user_id = ?').all(req.user.id);
  res.json({
    ticket,
    options: {
      challenge,
      rp: { name: 'Anchor', id: rpInfo(req).rpId },
      user: {
        id: Buffer.from(String(req.user.id)).toString('base64url'),
        name: req.user.username,
        displayName: req.user.username,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      excludeCredentials: existing.map(p => ({ type: 'public-key', id: p.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      timeout: 60000,
    },
  });
});

app.post('/api/passkeys/register/verify', requireAuth, (req, res) => {
  const data = authlib.takeChallenge('pk-reg', req.body.ticket);
  if (!data || data.userId !== req.user.id) {
    return res.status(400).json({ error: 'Passkey setup expired — try again.' });
  }
  try {
    const { rpId, origin } = rpInfo(req);
    const cred = authlib.verifyRegistration({
      response: req.body.response || {}, challenge: data.challenge, origin, rpId,
    });
    db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, name) VALUES (?, ?, ?, ?, ?)')
      .run(cred.credentialId, req.user.id, cred.publicKey, cred.counter,
        String(req.body.name || 'Passkey').trim().slice(0, 60) || 'Passkey');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: `Could not register that passkey: ${e.message}` });
  }
});

app.post('/api/passkeys/login/options', (req, res) => {
  const challenge = crypto.randomBytes(32).toString('base64url');
  const ticket = authlib.putChallenge('pk-login', { challenge });
  // No allowCredentials: discoverable credentials let the browser offer
  // whatever passkeys it holds for this site.
  res.json({
    ticket,
    options: { challenge, rpId: rpInfo(req).rpId, userVerification: 'preferred', timeout: 60000 },
  });
});

app.post('/api/passkeys/login/verify', (req, res) => {
  const data = authlib.takeChallenge('pk-login', req.body.ticket);
  if (!data) return res.status(400).json({ error: 'Sign-in expired — try again.' });
  const passkey = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(String(req.body.id || ''));
  if (!passkey) return res.status(401).json({ error: 'That passkey is not registered here.' });
  try {
    const { rpId, origin } = rpInfo(req);
    const { counter } = authlib.verifyAssertion({
      response: req.body.response || {}, challenge: data.challenge, origin, rpId,
      storedKey: passkey.public_key, storedCounter: passkey.counter,
    });
    db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(counter, passkey.id);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(passkey.user_id);
    startSession(res, user.id);
    res.json({ id: user.id, username: user.username });
  } catch (e) {
    res.status(401).json({ error: `Passkey sign-in failed: ${e.message}` });
  }
});

app.delete('/api/passkeys/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- two-factor authentication (TOTP) ----------

app.post('/api/2fa/setup', requireAuth, (req, res) => {
  const secret = authlib.newTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  res.json({ secret, otpauth: authlib.otpauthUrl(secret, req.user.username) });
});

app.post('/api/2fa/enable', requireAuth, (req, res) => {
  const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_secret) return res.status(400).json({ error: 'Set up an authenticator first.' });
  if (!authlib.verifyTotp(user.totp_secret, req.body.code)) {
    return res.status(400).json({ error: 'That code is not right — check your authenticator app.' });
  }
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.post('/api/2fa/disable', requireAuth, (req, res) => {
  const user = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) return res.status(400).json({ error: 'Two-factor authentication is not on.' });
  if (!authlib.verifyTotp(user.totp_secret, req.body.code)) {
    return res.status(400).json({ error: 'Enter a current code from your authenticator to turn 2FA off.' });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---------- password recovery ----------

app.post('/api/recover', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = email
    ? db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(email) : null;
  if (user) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, unixepoch() + 3600)')
      .run(token, user.id);
    const link = `${req.protocol}://${req.get('host')}/reset?token=${token}`;
    authlib.sendMail(user.email, 'Reset your Anchor password',
      `Hi ${user.username},\n\nSomeone (hopefully you) asked to reset your Anchor password.\n` +
      `Use this link within the next hour:\n\n${link}\n\n` +
      `If you didn't ask for this, ignore this message — your password is unchanged.`);
  }
  // Identical response either way so the endpoint can't be used to probe
  // which emails have accounts.
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(req.body.token || ''));
  if (!row || row.used || row.expires_at < Math.floor(Date.now() / 1000)) {
    return res.status(400).json({ error: 'That reset link is invalid or has expired.' });
  }
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password !== String(req.body.password2 || '')) {
    return res.status(400).json({ error: 'The two passwords do not match.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(row.token);
  // Sign the account out everywhere; the new password is the only way back in.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true });
});

// ---------- account management ----------

app.get('/api/account', requireAuth, (req, res) => {
  const account = db.prepare('SELECT id, username, email, totp_enabled FROM users WHERE id = ?')
    .get(req.user.id);
  account.passkeys = db.prepare(
    'SELECT id, name, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(req.user.id);
  res.json(account);
});

app.post('/api/account/email', requireAuth, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'That does not look like a valid email address.' });
  }
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(403).json({ error: 'Wrong password.' });
  }
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'That email is already registered to another account.' });
  }
});

app.post('/api/account/password', requireAuth, (req, res) => {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current || ''), user.password_hash)) {
    return res.status(403).json({ error: 'Your current password is wrong.' });
  }
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password !== String(req.body.password2 || '')) {
    return res.status(400).json({ error: 'The two passwords do not match.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
  // Keep this session, sign out every other device.
  const token = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]{48})/);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, token ? token[1] : '');
  res.json({ ok: true });
});

// ---------- uploads ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, file.fieldname === 'thumbnail' ? THUMBS_DIR : UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
      const ext = file.fieldname === 'thumbnail'
        ? '.jpg'
        : (path.extname(file.originalname).toLowerCase() || '.mp4');
      cb(null, crypto.randomBytes(8).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') return cb(null, VIDEO_TYPES.has(file.mimetype));
    if (file.fieldname === 'thumbnail') return cb(null, file.mimetype === 'image/jpeg');
    cb(null, false);
  },
});

app.post('/api/videos', requireAuth,
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]),
  (req, res) => {
    const videoFile = req.files && req.files.video && req.files.video[0];
    const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
    const title = String(req.body.title || '').trim().slice(0, 120);
    if (!videoFile) return res.status(400).json({ error: 'A video file (mp4, webm, ogg or mov) is required.' });
    if (!title) {
      fs.unlink(videoFile.path, () => {});
      if (thumbFile) fs.unlink(thumbFile.path, () => {});
      return res.status(400).json({ error: 'A title is required.' });
    }
    const id = crypto.randomBytes(6).toString('base64url');
    const duration = parseFloat(req.body.duration);
    const category = CATEGORIES.includes(req.body.category) ? req.body.category : null;
    // Shorts must actually be short; the transcoder re-checks against ffprobe.
    const isShort = req.body.is_short === '1' && Number.isFinite(duration) && duration <= 61 ? 1 : 0;
    db.prepare(`
      INSERT INTO videos (id, user_id, title, description, filename, thumbnail, duration, status, category, is_short)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.user.id, title,
      String(req.body.description || '').trim().slice(0, 5000),
      videoFile.filename,
      thumbFile ? thumbFile.filename : null,
      Number.isFinite(duration) ? duration : null,
      transcode.available ? 'processing' : 'ready',
      category,
      isShort,
    );
    setTags(id, req.body.tags); // also writes the search-index row
    transcode.enqueue(id);
    res.json({ id });
  });

// ---------- video listing / detail ----------

const VIDEO_COLS = `v.id, v.title, v.description, v.filename, v.thumbnail, v.duration,
         v.views, v.created_at, v.status, v.category, v.is_short,
         u.id AS channel_id, u.username AS channel_name`;
const VIDEO_SELECT = `SELECT ${VIDEO_COLS} FROM videos v JOIN users u ON u.id = v.user_id`;

function getRenditions(videoId) {
  return db.prepare('SELECT height, filename FROM renditions WHERE video_id = ? ORDER BY height DESC')
    .all(videoId);
}

// ---------- search / tags / pagination helpers ----------

function clampLimit(raw, def = 24, max = 50) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : def;
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function decodeCursor(s) {
  if (!s) return null;
  try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); }
  catch (e) { return null; }
}

// Over-fetch limit+1 rows, then split off the page and derive the next cursor.
function pageResult(rows, limit, keyFn) {
  let nextCursor = null;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    nextCursor = encodeCursor(keyFn(rows[rows.length - 1]));
  }
  return { videos: rows, nextCursor };
}

// Keyset-paginated reverse-chronological feed with an optional extra filter.
function chronoFeed(extraWhere, params, cursor, limit) {
  const clauses = [];
  const args = [...params];
  if (extraWhere) clauses.push(extraWhere);
  if (cursor && Number.isFinite(cursor.t) && cursor.id != null) {
    clauses.push('(v.created_at < ? OR (v.created_at = ? AND v.id < ?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  args.push(limit + 1);
  const rows = db.prepare(`${VIDEO_SELECT} ${where}
    ORDER BY v.created_at DESC, v.id DESC LIMIT ?`).all(...args);
  return pageResult(rows, limit, last => ({ t: last.created_at, id: last.id }));
}

// Turn a raw query into a safe FTS5 MATCH string: quote each token, prefix the last.
function ftsQuery(q) {
  const tokens = String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || !tokens.length) return null;
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? '*' : ''}`).join(' ');
}
// bm25 weights: title > tags > channel > description (lower score = more relevant).
const BM25 = 'bm25(videos_fts, 8.0, 2.0, 4.0, 3.0)';

function normalizeTags(raw) {
  return [...new Set(String(raw || '').split(',')
    .map(t => t.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))].slice(0, 5);
}

const upsertTag = db.prepare(
  'INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id');
const replaceTags = db.transaction((videoId, names) => {
  db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(videoId);
  for (const name of names) {
    const { id } = upsertTag.get(name);
    db.prepare('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)').run(videoId, id);
  }
});
// Replace a video's tags and refresh its search-index row.
function setTags(videoId, raw) {
  replaceTags(videoId, normalizeTags(raw));
  reindexVideo(videoId);
}
function tagsForVideo(videoId) {
  return db.prepare(`SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
    WHERE vt.video_id = ? ORDER BY t.name`).all(videoId).map(r => r.name);
}

// Tag-based related videos, topped up to 12 with popular videos as a fallback.
// Shorts are excluded so the watch sidebar / autoplay queue stays long-form.
function relatedVideos(videoId) {
  const out = db.prepare(`SELECT ${VIDEO_COLS}, COUNT(vt2.tag_id) AS shared
    FROM video_tags vt1
    JOIN video_tags vt2 ON vt2.tag_id = vt1.tag_id AND vt2.video_id <> vt1.video_id
    JOIN videos v ON v.id = vt2.video_id
    JOIN users u ON u.id = v.user_id
    WHERE vt1.video_id = ? AND v.is_short = 0
    GROUP BY v.id
    ORDER BY shared DESC, v.views DESC, v.created_at DESC
    LIMIT 12`).all(videoId);
  if (out.length < 12) {
    const have = new Set([videoId, ...out.map(v => v.id)]);
    const fillers = db.prepare(`${VIDEO_SELECT} WHERE v.id <> ? AND v.is_short = 0
      ORDER BY v.views DESC, v.created_at DESC LIMIT 40`).all(videoId);
    for (const f of fillers) {
      if (out.length >= 12) break;
      if (!have.has(f.id)) { have.add(f.id); out.push(f); }
    }
  }
  return out;
}

app.get('/api/videos', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const channel = parseInt(req.query.channel, 10);
  const category = String(req.query.category || '').trim();
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);

  if (q) {
    const match = ftsQuery(q);
    if (!match) return res.json({ videos: [], nextCursor: null });
    const offset = cursor && Number.isInteger(cursor.o) ? cursor.o : 0;
    const rows = db.prepare(`SELECT ${VIDEO_COLS}
      FROM videos_fts
      JOIN videos v ON v.id = videos_fts.video_id
      JOIN users u ON u.id = v.user_id
      WHERE videos_fts MATCH ?
      ORDER BY ${BM25}, v.created_at DESC
      LIMIT ? OFFSET ?`).all(match, limit + 1, offset);
    return res.json(pageResult(rows, limit, () => ({ o: offset + limit })));
  }
  // Discovery grids stay long-form; shorts live in their own feed (but still
  // show up in search, channel pages and the user's own lists).
  if (category) return res.json(chronoFeed('v.category = ? AND v.is_short = 0', [category], cursor, limit));
  if (Number.isInteger(channel)) return res.json(chronoFeed('v.user_id = ?', [channel], cursor, limit));
  const me = getUser(req);
  if (me) return res.json(personalizedHome(me, cursor, limit));
  res.json(chronoFeed('v.is_short = 0', [], cursor, limit));
});

// Blend recency with subscription and tag-affinity boosts over a recent window;
// offset-paginated so the ranking stays stable across pages.
function personalizedHome(me, cursor, limit) {
  const offset = cursor && Number.isInteger(cursor.o) ? cursor.o : 0;
  const subs = new Set(db.prepare('SELECT channel_id FROM subscriptions WHERE subscriber_id = ?')
    .all(me.id).map(r => r.channel_id));
  const tagWeight = new Map(db.prepare(`SELECT vt.tag_id, COUNT(*) AS c FROM watch_history h
    JOIN video_tags vt ON vt.video_id = h.video_id WHERE h.user_id = ? GROUP BY vt.tag_id`)
    .all(me.id).map(r => [r.tag_id, r.c]));
  const finished = new Set(db.prepare('SELECT video_id FROM watch_history WHERE user_id = ? AND completed = 1')
    .all(me.id).map(r => r.video_id));
  const tagsOf = db.prepare('SELECT tag_id FROM video_tags WHERE video_id = ?');
  const rows = db.prepare(`${VIDEO_SELECT} WHERE v.is_short = 0 ORDER BY v.created_at DESC LIMIT 300`).all();
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    let score = 1 / ((now - r.created_at) / 86400 + 2);
    if (subs.has(r.channel_id)) score += 3;
    if (tagWeight.size) {
      for (const { tag_id } of tagsOf.all(r.id)) {
        if (tagWeight.has(tag_id)) score += Math.min(2, tagWeight.get(tag_id));
      }
    }
    if (finished.has(r.id)) score -= 1;
    r._score = score;
  }
  rows.sort((a, b) => b._score - a._score || b.created_at - a.created_at);
  const page = rows.slice(offset, offset + limit).map(({ _score, ...v }) => v);
  return { videos: page, nextCursor: offset + limit < rows.length ? encodeCursor({ o: offset + limit }) : null };
}

// Search-as-you-type suggestions (de-duplicated titles, most relevant first).
app.get('/api/search/suggest', requireAuth, (req, res) => {
  const match = ftsQuery(req.query.q || '');
  if (!match) return res.json({ suggestions: [] });
  const rows = db.prepare(`SELECT title FROM videos_fts WHERE videos_fts MATCH ?
    ORDER BY ${BM25} LIMIT 12`).all(match);
  const seen = new Set(), out = [];
  for (const { title } of rows) {
    const key = title.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(title); }
    if (out.length >= 8) break;
  }
  res.json({ suggestions: out });
});

// Fixed category list plus how many videos sit in each (for browse chips).
app.get('/api/categories', requireAuth, (req, res) => {
  const counts = Object.fromEntries(db.prepare(
    `SELECT category, COUNT(*) AS n FROM videos
     WHERE category IS NOT NULL AND category <> '' GROUP BY category`).all()
    .map(c => [c.category, c.n]));
  res.json({ categories: CATEGORIES.map(name => ({ name, count: counts[name] || 0 })) });
});

app.get('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(video.id);
  video.views += 1;

  const me = getUser(req);
  const counts = db.prepare(`
    SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes
    FROM likes WHERE video_id = ?
  `).get(video.id);
  video.likes = counts.likes;
  video.dislikes = counts.dislikes;
  video.my_like = me
    ? (db.prepare('SELECT value FROM likes WHERE user_id = ? AND video_id = ?').get(me.id, video.id) || {}).value || 0
    : 0;
  video.subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?')
    .get(video.channel_id).n;
  video.subscribed = me
    ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?')
        .get(me.id, video.channel_id)
    : false;
  video.is_owner = !!me && me.id === video.channel_id;

  if (me) {
    const h = db.prepare('SELECT position, completed FROM watch_history WHERE user_id = ? AND video_id = ?')
      .get(me.id, video.id);
    video.resume = h && !h.completed ? h.position : 0;
    video.in_watch_later = !!db.prepare('SELECT 1 FROM watch_later WHERE user_id = ? AND video_id = ?')
      .get(me.id, video.id);
  } else {
    video.resume = 0;
    video.in_watch_later = false;
  }

  video.tags = tagsForVideo(video.id);
  video.renditions = getRenditions(video.id);
  video.related = relatedVideos(video.id);
  res.json(video);
});

// Edit a video's title/description/tags/category (owner only); keeps FTS synced.
app.patch('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (video.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own videos.' });
  const title = req.body.title !== undefined
    ? String(req.body.title).trim().slice(0, 120) : video.title;
  if (!title) return res.status(400).json({ error: 'A title is required.' });
  const description = req.body.description !== undefined
    ? String(req.body.description).trim().slice(0, 5000) : video.description;
  const category = req.body.category !== undefined
    ? (CATEGORIES.includes(req.body.category) ? req.body.category : null) : video.category;
  db.prepare('UPDATE videos SET title = ?, description = ?, category = ? WHERE id = ?')
    .run(title, description, category, video.id);
  if (req.body.tags !== undefined) setTags(video.id, req.body.tags);
  else reindexVideo(video.id);
  res.json({ ok: true, tags: tagsForVideo(video.id) });
});

// Polled by the watch page while a video is processing; unlike the detail
// endpoint this does not count a view.
app.get('/api/videos/:id/status', requireAuth, (req, res) => {
  const video = db.prepare('SELECT id, status, duration FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  res.json({ status: video.status, duration: video.duration, renditions: getRenditions(video.id) });
});

app.delete('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (video.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own videos.' });
  const renditions = getRenditions(video.id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  fs.unlink(path.join(UPLOADS_DIR, video.filename), () => {});
  for (const r of renditions) fs.unlink(path.join(UPLOADS_DIR, r.filename), () => {});
  if (video.thumbnail) fs.unlink(path.join(THUMBS_DIR, video.thumbnail), () => {});
  res.json({ ok: true });
});

// ---------- likes ----------

app.post('/api/videos/:id/like', requireAuth, (req, res) => {
  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const value = parseInt(req.body.value, 10);
  if (![1, -1, 0].includes(value)) return res.status(400).json({ error: 'value must be 1, -1 or 0.' });
  if (value === 0) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(req.user.id, video.id);
  } else {
    db.prepare(`
      INSERT INTO likes (user_id, video_id, value) VALUES (?, ?, ?)
      ON CONFLICT (user_id, video_id) DO UPDATE SET value = excluded.value
    `).run(req.user.id, video.id, value);
  }
  const counts = db.prepare(`
    SELECT COALESCE(SUM(value = 1), 0) AS likes, COALESCE(SUM(value = -1), 0) AS dislikes
    FROM likes WHERE video_id = ?
  `).get(video.id);
  res.json({ ...counts, my_like: value });
});

// ---------- comments ----------

app.get('/api/videos/:id/comments', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.text, c.created_at, u.id AS user_id, u.username
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.video_id = ? ORDER BY c.created_at DESC LIMIT 200
  `).all(req.params.id);
  res.json({ comments: rows });
});

app.post('/api/videos/:id/comments', requireAuth, (req, res) => {
  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const info = db.prepare('INSERT INTO comments (video_id, user_id, text) VALUES (?, ?, ?)')
    .run(video.id, req.user.id, text);
  res.json({
    id: info.lastInsertRowid, text,
    created_at: Math.floor(Date.now() / 1000),
    user_id: req.user.id, username: req.user.username,
  });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments.' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});

// ---------- channels & subscriptions ----------

app.get('/api/channels/:id', requireAuth, (req, res) => {
  const channel = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  const me = getUser(req);
  channel.subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(channel.id).n;
  channel.total_views = db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM videos WHERE user_id = ?').get(channel.id).n;
  channel.subscribed = me
    ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(me.id, channel.id)
    : false;
  channel.video_count = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE user_id = ?').get(channel.id).n;
  res.json(channel);
});

// Paginated videos for a channel page (infinite scroll).
app.get('/api/channels/:id/videos', requireAuth, (req, res) => {
  const channelId = parseInt(req.params.id, 10);
  if (!Number.isInteger(channelId)) return res.status(400).json({ error: 'Bad channel id.' });
  res.json(chronoFeed('v.user_id = ?', [channelId], decodeCursor(req.query.cursor), clampLimit(req.query.limit)));
});

app.post('/api/channels/:id/subscribe', requireAuth, (req, res) => {
  const channelId = parseInt(req.params.id, 10);
  const channel = db.prepare('SELECT id FROM users WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  if (channel.id === req.user.id) return res.status(400).json({ error: "You can't subscribe to yourself." });
  const existing = db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?')
    .get(req.user.id, channel.id);
  if (existing) {
    db.prepare('DELETE FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').run(req.user.id, channel.id);
  } else {
    db.prepare('INSERT INTO subscriptions (subscriber_id, channel_id) VALUES (?, ?)').run(req.user.id, channel.id);
  }
  const subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(channel.id).n;
  res.json({ subscribed: !existing, subscribers });
});

// ---------- watch history & resume ----------

app.post('/api/history', requireAuth, (req, res) => {
  const videoId = String(req.body.video_id || '');
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
    return res.status(404).json({ error: 'Video not found.' });
  }
  const position = Math.max(0, parseFloat(req.body.position) || 0);
  const duration = parseFloat(req.body.duration) || null;
  const completed = duration && position >= 0.9 * duration ? 1 : 0;
  db.prepare(`INSERT INTO watch_history (user_id, video_id, position, duration, completed, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT (user_id, video_id) DO UPDATE SET
      position = excluded.position, duration = excluded.duration,
      completed = excluded.completed, updated_at = excluded.updated_at`)
    .run(req.user.id, videoId, position, duration, completed);
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const clauses = ['h.user_id = ?'];
  const args = [req.user.id];
  if (req.query.incomplete === '1') clauses.push('h.completed = 0 AND h.position > 5');
  if (cursor && Number.isFinite(cursor.t) && cursor.id != null) {
    clauses.push('(h.updated_at < ? OR (h.updated_at = ? AND v.id < ?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  args.push(limit + 1);
  const rows = db.prepare(`SELECT ${VIDEO_COLS}, h.position, h.updated_at AS watched_at
    FROM watch_history h JOIN videos v ON v.id = h.video_id JOIN users u ON u.id = v.user_id
    WHERE ${clauses.join(' AND ')} ORDER BY h.updated_at DESC, v.id DESC LIMIT ?`).all(...args);
  res.json(pageResult(rows, limit, last => ({ t: last.watched_at, id: last.id })));
});

app.delete('/api/history/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM watch_history WHERE user_id = ? AND video_id = ?').run(req.user.id, req.params.id);
  res.json({ ok: true });
});

// ---------- watch later ----------

app.post('/api/watch-later', requireAuth, (req, res) => {
  const videoId = String(req.body.video_id || '');
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
    return res.status(404).json({ error: 'Video not found.' });
  }
  const existing = db.prepare('SELECT 1 FROM watch_later WHERE user_id = ? AND video_id = ?')
    .get(req.user.id, videoId);
  if (existing) {
    db.prepare('DELETE FROM watch_later WHERE user_id = ? AND video_id = ?').run(req.user.id, videoId);
  } else {
    db.prepare('INSERT INTO watch_later (user_id, video_id) VALUES (?, ?)').run(req.user.id, videoId);
  }
  res.json({ in_watch_later: !existing });
});

app.delete('/api/watch-later/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM watch_later WHERE user_id = ? AND video_id = ?').run(req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get('/api/watch-later', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const clauses = ['w.user_id = ?'];
  const args = [req.user.id];
  if (cursor && Number.isFinite(cursor.t) && cursor.id != null) {
    clauses.push('(w.created_at < ? OR (w.created_at = ? AND v.id < ?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  args.push(limit + 1);
  const rows = db.prepare(`SELECT ${VIDEO_COLS}, w.created_at AS saved_at
    FROM watch_later w JOIN videos v ON v.id = w.video_id JOIN users u ON u.id = v.user_id
    WHERE ${clauses.join(' AND ')} ORDER BY w.created_at DESC, v.id DESC LIMIT ?`).all(...args);
  res.json(pageResult(rows, limit, last => ({ t: last.saved_at, id: last.id })));
});

// ---------- liked & subscription feeds ----------

app.get('/api/liked', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const clauses = ['l.user_id = ?', 'l.value = 1'];
  const args = [req.user.id];
  if (cursor && Number.isFinite(cursor.t) && cursor.id != null) {
    clauses.push('(v.created_at < ? OR (v.created_at = ? AND v.id < ?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  args.push(limit + 1);
  const rows = db.prepare(`SELECT ${VIDEO_COLS} FROM likes l
    JOIN videos v ON v.id = l.video_id JOIN users u ON u.id = v.user_id
    WHERE ${clauses.join(' AND ')} ORDER BY v.created_at DESC, v.id DESC LIMIT ?`).all(...args);
  res.json(pageResult(rows, limit, last => ({ t: last.created_at, id: last.id })));
});

app.get('/api/feed/subscriptions', requireAuth, (req, res) => {
  res.json(chronoFeed(
    'v.is_short = 0 AND v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?)',
    [req.user.id], decodeCursor(req.query.cursor), clampLimit(req.query.limit)));
});

// ---------- trending (time-decayed popularity) ----------

app.get('/api/trending', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const offset = cursor && Number.isInteger(cursor.o) ? cursor.o : 0;
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`SELECT ${VIDEO_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count
    FROM videos v JOIN users u ON u.id = v.user_id
    WHERE v.created_at > ? AND v.is_short = 0`).all(now - 60 * 60 * 24 * 30);
  for (const r of rows) {
    const ageHours = (now - r.created_at) / 3600;
    r._score = (r.views + 3 * r.like_count + 2 * r.comment_count) / Math.pow(ageHours + 2, 1.5);
  }
  rows.sort((a, b) => b._score - a._score || b.created_at - a.created_at);
  const page = rows.slice(offset, offset + limit).map(({ _score, ...v }) => v);
  res.json({ videos: page, nextCursor: offset + limit < rows.length ? encodeCursor({ o: offset + limit }) : null });
});

// ---------- shorts ----------

// The swipe feed: every short, ranked by time-decayed engagement (no window,
// so the catalogue is always reachable — decay sinks old ones naturally).
// ?start=<id> pins that short to the front of the first page.
app.get('/api/shorts', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const offset = cursor && Number.isInteger(cursor.o) ? cursor.o : 0;
  const start = String(req.query.start || '');
  const me = getUser(req);
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`SELECT ${VIDEO_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count
    FROM videos v JOIN users u ON u.id = v.user_id
    WHERE v.is_short = 1`).all();
  for (const r of rows) {
    const ageHours = (now - r.created_at) / 3600;
    r._score = (r.views + 3 * r.like_count + 2 * r.comment_count) / Math.pow(ageHours + 2, 1.5);
  }
  rows.sort((a, b) => b._score - a._score || b.created_at - a.created_at);
  if (start) {
    const i = rows.findIndex(r => r.id === start);
    if (i > 0) rows.unshift(rows.splice(i, 1)[0]);
  }
  const myLike = me ? db.prepare('SELECT value FROM likes WHERE user_id = ? AND video_id = ?') : null;
  const page = rows.slice(offset, offset + limit).map(({ _score, ...v }) => ({
    ...v, my_like: myLike ? ((myLike.get(me.id, v.id) || {}).value || 0) : 0,
  }));
  res.json({ videos: page, nextCursor: offset + limit < rows.length ? encodeCursor({ o: offset + limit }) : null });
});

// The shorts player never hits GET /api/videos/:id (which is what counts a
// view elsewhere), so it reports views here once a short actually plays.
app.post('/api/videos/:id/view', requireAuth, (req, res) => {
  const info = db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Video not found.' });
  res.json({ ok: true });
});

// ---------- pretty page routes ----------

// Signed-out visitors land on the splash page; the reset page is the only
// other place they can go.
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', req.user ? 'index.html' : 'splash.html')));
app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));

app.get('/watch/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/shorts', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'shorts.html')));
app.get('/shorts/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'shorts.html')));
app.get('/channel/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'channel.html')));
app.get('/upload', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/browse', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'browse.html')));
for (const page of ['trending', 'history', 'liked', 'later', 'subscriptions', 'settings']) {
  app.get('/' + page, pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', `${page}.html`)));
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`⚓ Anchor is running at http://localhost:${PORT}`);
  console.log(transcode.available
    ? 'Transcoding: ffmpeg found — uploads will get multi-quality renditions.'
    : 'Transcoding: ffmpeg not found — videos will play in their original format only.');
});
