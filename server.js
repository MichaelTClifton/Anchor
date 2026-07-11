const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { db, UPLOADS_DIR, THUMBS_DIR, LIVE_DIR, reindexVideo } = require('./db');
const transcode = require('./transcode');
const live = require('./live');
const recommend = require('./recommend');
const authlib = require('./auth');

const CATEGORIES = ['Music', 'Gaming', 'Education', 'Tech', 'Vlog', 'News', 'Sports', 'Other'];

const PORT = process.env.PORT || 3000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GB
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

const app = express();
// A reverse proxy (nginx/Caddy/Cloudflare) is expected in front in
// production; trusting the first hop makes req.ip/req.protocol/req.secure
// reflect the real client and scheme from X-Forwarded-For/-Proto instead of
// the proxy's own loopback connection. This also fixes WebAuthn's rpInfo()
// below, which derives rpId/origin from req.hostname/req.protocol. Harmless
// with no proxy present — it just falls back to the direct socket.
app.set('trust proxy', 1);

app.use(helmet({
  // This app has no build step: every page has inline <script> blocks and
  // onclick="" attribute handlers (e.g. public/splash.html, common.js's
  // generated buttons), and some inline style="" attributes. CSP treats
  // <script> tags (script-src), inline event-handler attributes
  // (script-src-attr) and style attributes (style-src-attr) as separate
  // directives that do NOT fall back to script-src/style-src once any
  // directive is set — helmet's own default is script-src-attr 'none',
  // which would silently no-op every onclick="" in the app. All three need
  // 'unsafe-inline' here. This still blocks the more common injection
  // vector — loading an externally hosted script/style/object — and
  // framing/base-uri are locked down.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],   // hls.js attaches MediaSource via a blob: URL
      workerSrc: ["'self'", 'blob:'],  // hls.js demuxes in a blob worker
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(compression()); // no-ops on already-compressed types (video/mp4) automatically
app.use(express.json());

// ---------- rate limiting ----------
// Keyed by client IP (trust proxy above makes that the real client, not the
// reverse proxy, when one is present).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // Only failures burn the budget: a NAT'd household of legitimate users
  // (or one person signing in, then redeeming a 2FA code) shouldn't get
  // locked out by successful requests.
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
// Separate instances per concern so heavy commenting can't block an upload.
const slowDown = { error: 'Slow down — too many requests. Please try again shortly.' };
const commentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: true, legacyHeaders: false, message: slowDown,
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: true, legacyHeaders: false, message: slowDown,
});
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20,
  standardHeaders: true, legacyHeaders: false, message: slowDown,
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 20,
  standardHeaders: true, legacyHeaders: false, message: slowDown,
});
// Generous: the home grid beacons batches of card sightings as you scroll.
const impressionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 120,
  standardHeaders: true, legacyHeaders: false, message: slowDown,
});

// Resolve the viewer once per request. Signed-out visitors only ever reach
// the splash and reset pages; every content page, API and media file needs a
// session.
app.use((req, res, next) => { req.user = getUser(req); next(); });
const pageAuth = (req, res, next) => (req.user ? next() : res.redirect('/'));
const staticAuth = (req, res, next) => (req.user ? next() : res.status(401).end());
app.use((req, res, next) => {
  if (!req.user && /\.html$/.test(req.path)
      && !['/splash.html', '/reset.html', '/guidelines.html'].includes(req.path)) {
    return res.redirect('/');
  }
  next();
});
// index:false so "/" below can pick splash vs home by session.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// express.static handles HTTP Range requests, so seeking in the player works.
app.use('/media', staticAuth, express.static(UPLOADS_DIR));
app.use('/thumbs', staticAuth, express.static(THUMBS_DIR));
// Rolling HLS output for live streams. The playlist must never be cached
// (it changes every couple of seconds); segments are immutable but shortlived.
app.use('/live-hls', staticAuth, express.static(LIVE_DIR, {
  setHeaders: (res, p) => res.setHeader('Cache-Control',
    p.endsWith('.m3u8') ? 'no-store' : 'private, max-age=60'),
}));

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
  // The suspended filter here is the enforcement point for account
  // suspension: existing sessions die on their very next request.
  return db.prepare(`
    SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.suspended = 0
  `).get(match[1]) || null;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You must be signed in to do that.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You must be signed in to do that.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// ---------- auth routes ----------

app.post('/api/register', authLimiter, (req, res) => {
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
  if (req.body.terms !== true) {
    return res.status(400).json({ error: 'You must agree to the Community Guidelines to create an account.' });
  }
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), email);
    startSession(req, res, info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid, username });
  } catch (e) {
    const dup = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    res.status(409).json({ error: dup ? 'That username is taken.' : 'That email is already registered.' });
  }
});

app.post('/api/login', authLimiter, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  // Checked only after the password verifies, so this can't probe accounts.
  if (user.suspended) return res.status(403).json({ error: 'This account is suspended.' });
  if (user.totp_enabled) {
    // Two-step sign-in: the password alone earns a short-lived ticket, not a
    // session; the authenticator code redeems it below.
    const ticket = authlib.putChallenge('totp-login', { userId: user.id, attempts: 0 });
    return res.json({ totp_required: true, ticket });
  }
  startSession(req, res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/login/totp', authLimiter, (req, res) => {
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
  if (user.suspended) return res.status(403).json({ error: 'This account is suspended.' });
  authlib.dropChallenge(ticket);
  startSession(req, res, user.id);
  res.json({ id: user.id, username: user.username });
});

function startSession(req, res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  // req.secure reflects the real scheme via trust proxy above, so this cookie
  // is Secure once actually served over HTTPS (through a proxy or directly),
  // and plain (working on http://localhost) in local development.
  res.setHeader('Set-Cookie',
    `session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${req.secure ? '; Secure' : ''}`);
}

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)session=([a-f0-9]{48})/);
  if (match) db.prepare('DELETE FROM sessions WHERE token = ?').run(match[1]);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUser(req);
  if (user && user.role === 'admin') {
    user.open_reports = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  }
  res.json({ user });
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

app.post('/api/passkeys/login/verify', authLimiter, (req, res) => {
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
    const user = db.prepare('SELECT id, username, suspended FROM users WHERE id = ?').get(passkey.user_id);
    if (user.suspended) return res.status(403).json({ error: 'This account is suspended.' });
    startSession(req, res, user.id);
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

app.post('/api/recover', authLimiter, (req, res) => {
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

app.post('/api/reset', authLimiter, (req, res) => {
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

app.post('/api/videos', uploadLimiter, requireAuth,
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
         v.views, v.created_at, v.status, v.category, v.is_short, v.hidden,
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
  const clauses = ['v.hidden = 0'];
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
      WHERE videos_fts MATCH ? AND v.hidden = 0
      ORDER BY ${BM25}, v.created_at DESC
      LIMIT ? OFFSET ?`).all(match, limit + 1, offset);
    return res.json(pageResult(rows, limit, () => ({ o: offset + limit })));
  }
  // Discovery grids stay long-form; shorts live in their own feed (but still
  // show up in search, channel pages and the user's own lists).
  if (category) return res.json(chronoFeed('v.category = ? AND v.is_short = 0', [category], cursor, limit));
  if (Number.isInteger(channel)) return res.json(chronoFeed('v.user_id = ?', [channel], cursor, limit));
  // The signed-in home feed is the preference-based recommender (recommend.js).
  res.json(recommend.personalizedHome(req.user, cursor, limit));
});

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
     WHERE category IS NOT NULL AND category <> '' AND hidden = 0 GROUP BY category`).all()
    .map(c => [c.category, c.n]));
  res.json({ categories: CATEGORIES.map(name => ({ name, count: counts[name] || 0 })) });
});

app.get('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare(`${VIDEO_SELECT} WHERE v.id = ?`).get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const me = getUser(req);
  // A taken-down video 404s for everyone except its owner and admins, who
  // instead see it flagged so the page can show a removal notice.
  const canSeeHidden = me && (me.id === video.user_id || me.role === 'admin');
  if (video.hidden && !canSeeHidden) return res.status(404).json({ error: 'Video not found.' });
  if (!video.hidden) {
    db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(video.id);
    video.views += 1;
  }

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
  video.related = recommend.relatedVideos(video.id, me);
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
  const video = db.prepare('SELECT id, user_id, status, duration, hidden FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (video.hidden && !(req.user.id === video.user_id || req.user.role === 'admin')) {
    return res.status(404).json({ error: 'Video not found.' });
  }
  res.json({ status: video.status, duration: video.duration, renditions: getRenditions(video.id) });
});

app.delete('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (video.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own videos.' });
  const renditions = getRenditions(video.id);
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
  resolveReportsFor('video', video.id, 'actioned', req.user.id);
  fs.unlink(path.join(UPLOADS_DIR, video.filename), () => {});
  for (const r of renditions) fs.unlink(path.join(UPLOADS_DIR, r.filename), () => {});
  if (video.thumbnail) fs.unlink(path.join(THUMBS_DIR, video.thumbnail), () => {});
  res.json({ ok: true });
});

// ---------- likes ----------

app.post('/api/videos/:id/like', requireAuth, (req, res) => {
  const video = db.prepare('SELECT id FROM videos WHERE id = ? AND hidden = 0').get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  const value = parseInt(req.body.value, 10);
  if (![1, -1, 0].includes(value)) return res.status(400).json({ error: 'value must be 1, -1 or 0.' });
  if (value === 0) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND video_id = ?').run(req.user.id, video.id);
  } else {
    // created_at feeds the recommender's time decay; re-stamped on conflict
    // because flipping like<->dislike is a fresh signal.
    db.prepare(`
      INSERT INTO likes (user_id, video_id, value, created_at) VALUES (?, ?, ?, unixepoch())
      ON CONFLICT (user_id, video_id) DO UPDATE SET
        value = excluded.value, created_at = excluded.created_at
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

app.post('/api/videos/:id/comments', commentLimiter, requireAuth, (req, res) => {
  const video = db.prepare('SELECT id FROM videos WHERE id = ? AND hidden = 0').get(req.params.id);
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
  const comment = db.prepare(`
    SELECT c.*, v.user_id AS video_owner_id FROM comments c
    JOIN videos v ON v.id = c.video_id WHERE c.id = ?
  `).get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== req.user.id && comment.video_owner_id !== req.user.id
      && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own comments, or comments on your own videos.' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  resolveReportsFor('comment', comment.id, 'actioned', req.user.id);
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
  channel.video_count = db.prepare('SELECT COUNT(*) AS n FROM videos WHERE user_id = ? AND hidden = 0').get(channel.id).n;
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
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ? AND hidden = 0').get(videoId)) {
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
  const clauses = ['h.user_id = ?', 'v.hidden = 0'];
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
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ? AND hidden = 0').get(videoId)) {
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
  const clauses = ['w.user_id = ?', 'v.hidden = 0'];
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

// ---------- feed feedback (impressions & not-interested) ----------

// Batched card-sighting counters from the home grid (fetch keepalive or
// sendBeacon — express.json parses both). The recommender demotes videos a
// viewer keeps scrolling past. Unknown ids are silently dropped.
app.post('/api/impressions', impressionLimiter, requireAuth, (req, res) => {
  const surface = String(req.body.surface || '');
  if (!['home', 'related'].includes(surface)) {
    return res.status(400).json({ error: 'Unknown surface.' });
  }
  const ids = Array.isArray(req.body.video_ids) ? req.body.video_ids : [];
  const recorded = recommend.recordImpressions(req.user.id, surface,
    ids.slice(0, 50).map(String));
  res.json({ ok: true, recorded });
});

// An explicit "don't recommend this" — permanently hides the video from the
// viewer's home feed and related rail (DELETE undoes it).
app.post('/api/videos/:id/not-interested', requireAuth, (req, res) => {
  if (!recommend.setNotInterested(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'Video not found.' });
  }
  res.json({ ok: true });
});

app.delete('/api/videos/:id/not-interested', requireAuth, (req, res) => {
  recommend.clearNotInterested(req.user.id, req.params.id);
  res.json({ ok: true });
});

// ---------- liked & subscription feeds ----------

app.get('/api/liked', requireAuth, (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = decodeCursor(req.query.cursor);
  const clauses = ['l.user_id = ?', 'l.value = 1', 'v.hidden = 0'];
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
    WHERE v.created_at > ? AND v.is_short = 0 AND v.hidden = 0`).all(now - 60 * 60 * 24 * 30);
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
    WHERE v.is_short = 1 AND v.hidden = 0`).all();
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
  const info = db.prepare('UPDATE videos SET views = views + 1 WHERE id = ? AND hidden = 0').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Video not found.' });
  res.json({ ok: true });
});

// ---------- reports & moderation ----------

const REPORT_REASONS = new Set(['spam', 'harassment', 'sexual', 'violence', 'copyright', 'other']);

// Resolve every open report for a target in one go — used by dismiss,
// takedown, and both hard-delete paths (else reports would orphan forever
// once their target is gone).
function resolveReportsFor(targetType, targetId, status, byUserId) {
  db.prepare(`UPDATE reports SET status = ?, resolved_by = ?, resolved_at = unixepoch()
    WHERE target_type = ? AND target_id = ? AND status = 'open'`)
    .run(status, byUserId, targetType, String(targetId));
}

app.post('/api/report', reportLimiter, requireAuth, (req, res) => {
  const targetType = String(req.body.target_type || '');
  const targetId = String(req.body.target_id || '');
  const reason = String(req.body.reason || '');
  const details = String(req.body.details || '').trim().slice(0, 500);
  if (!REPORT_REASONS.has(reason)) return res.status(400).json({ error: 'Pick a reason for the report.' });
  const exists = targetType === 'video'
    ? db.prepare('SELECT 1 FROM videos WHERE id = ?').get(targetId)
    : targetType === 'comment'
      ? db.prepare('SELECT 1 FROM comments WHERE id = ?').get(parseInt(targetId, 10))
      : null;
  if (!exists) return res.status(404).json({ error: 'That content no longer exists.' });
  try {
    db.prepare(`INSERT INTO reports (reporter_id, target_type, target_id, reason, details)
      VALUES (?, ?, ?, ?, ?)`).run(req.user.id, targetType, targetId, reason, details);
    res.json({ ok: true });
  } catch (e) {
    // Partial unique index: one open report per user per target.
    res.status(409).json({ error: 'You have already reported this.' });
  }
});

// The moderation queue: open reports with enough target context to act on.
// LEFT JOINs because targets may have been deleted since the report was
// filed (those render as "content no longer exists" but stay dismissible).
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.target_type, r.target_id, r.reason, r.details, r.created_at,
           ru.username AS reporter_name,
           v.title AS video_title, v.thumbnail AS video_thumbnail, v.hidden AS video_hidden,
           vu.id AS video_owner_id, vu.username AS video_owner_name, vu.suspended AS video_owner_suspended,
           c.text AS comment_text, c.video_id AS comment_video_id,
           cu.id AS comment_author_id, cu.username AS comment_author_name, cu.suspended AS comment_author_suspended
    FROM reports r
    JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN videos v ON r.target_type = 'video' AND v.id = r.target_id
    LEFT JOIN users vu ON vu.id = v.user_id
    LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = CAST(r.target_id AS INTEGER)
    LEFT JOIN users cu ON cu.id = c.user_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 200
  `).all();
  res.json({ reports: rows });
});

app.post('/api/admin/reports/:id/dismiss', requireAdmin, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  resolveReportsFor(report.target_type, report.target_id, 'dismissed', req.user.id);
  res.json({ ok: true });
});

app.post('/api/admin/videos/:id/hide', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE videos SET hidden = 1 WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Video not found.' });
  reindexVideo(req.params.id); // deindexes from search (reindexStmt skips hidden rows)
  resolveReportsFor('video', req.params.id, 'actioned', req.user.id);
  res.json({ ok: true });
});

app.post('/api/admin/videos/:id/restore', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE videos SET hidden = 0 WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Video not found.' });
  reindexVideo(req.params.id); // rebuilds the FTS row
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/suspend', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't suspend yourself." });
  if (target.role === 'admin') return res.status(400).json({ error: "Admins can't be suspended." });
  db.prepare('UPDATE users SET suspended = 1 WHERE id = ?').run(target.id);
  // Sessions die via the suspended filter in getUser; an in-flight broadcast
  // is cut off here (its VOD still archives via the normal teardown).
  live.stopStreamsForUser(target.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unsuspend', requireAdmin, (req, res) => {
  const info = db.prepare('UPDATE users SET suspended = 0 WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = db.prepare(`
    SELECT u.id, u.username, u.role, u.suspended, u.created_at,
           (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id) AS video_count
    FROM users u ${q ? 'WHERE u.username LIKE ?' : ''}
    ORDER BY u.created_at DESC LIMIT 100
  `).all(...(q ? [`%${q}%`] : []));
  res.json({ users: rows });
});

// ---------- live streaming ----------

const STREAM_COLS = `s.id, s.title, s.live, s.started_at, s.ended_at, s.vod_video_id,
         u.id AS channel_id, u.username AS channel_name`;

app.get('/api/live', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT ${STREAM_COLS} FROM streams s JOIN users u ON u.id = s.user_id
    WHERE s.live = 1 ORDER BY s.started_at DESC LIMIT 50`).all();
  for (const r of rows) r.viewers = live.viewerCount(r.id);
  res.json({ streams: rows });
});

app.get('/api/live/:id', requireAuth, (req, res) => {
  const stream = db.prepare(`SELECT ${STREAM_COLS} FROM streams s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?`).get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found.' });
  stream.viewers = live.viewerCount(stream.id);
  stream.subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?')
    .get(stream.channel_id).n;
  stream.subscribed = !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?')
    .get(req.user.id, stream.channel_id);
  stream.is_owner = req.user.id === stream.channel_id;
  res.json(stream);
});

app.get('/api/live/:id/chat/events', requireAuth, (req, res) => {
  const stream = db.prepare('SELECT id, live FROM streams WHERE id = ?').get(req.params.id);
  if (!stream || !stream.live) return res.status(404).json({ error: 'Stream is not live.' });
  live.chatSubscribe(stream.id, req, res);
});

app.post('/api/live/:id/chat', chatLimiter, requireAuth, (req, res) => {
  const stream = db.prepare('SELECT id, live FROM streams WHERE id = ?').get(req.params.id);
  if (!stream || !stream.live) return res.status(404).json({ error: 'Stream is not live.' });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Say something first.' });
  live.chatSend(stream.id, req.user, text);
  res.json({ ok: true });
});

// ---------- streamer studio ----------

function myLiveStream(userId) {
  return db.prepare('SELECT id FROM streams WHERE user_id = ? AND live = 1 ORDER BY started_at DESC')
    .get(userId) || null;
}

app.get('/api/studio', requireAuth, (req, res) => {
  let user = db.prepare('SELECT stream_key, stream_title FROM users WHERE id = ?').get(req.user.id);
  if (!user.stream_key) {
    // Lazily mint the key on first visit to the studio.
    const key = crypto.randomBytes(12).toString('hex');
    db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, req.user.id);
    user = { ...user, stream_key: key };
  }
  const current = myLiveStream(req.user.id);
  res.json({
    enabled: live.enabled,
    stream_key: user.stream_key,
    rtmp_url: `rtmp://${req.hostname}:${live.RTMP_PORT}/live`,
    stream_title: user.stream_title,
    live: current ? { id: current.id, viewers: live.viewerCount(current.id) } : null,
  });
});

app.post('/api/studio/key', requireAuth, (req, res) => {
  // Regenerating usually means "my key leaked" — cut any active broadcast.
  const current = myLiveStream(req.user.id);
  if (current) live.stopStream(current.id);
  const key = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(key, req.user.id);
  res.json({ stream_key: key });
});

app.post('/api/studio/title', requireAuth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  db.prepare('UPDATE users SET stream_title = ? WHERE id = ?').run(title, req.user.id);
  const current = myLiveStream(req.user.id);
  if (current) db.prepare('UPDATE streams SET title = ? WHERE id = ?').run(title, current.id);
  res.json({ ok: true });
});

app.post('/api/admin/streams/:id/stop', requireAdmin, (req, res) => {
  if (!live.stopStream(req.params.id)) return res.status(404).json({ error: 'Stream is not live.' });
  res.json({ ok: true });
});

// ---------- pretty page routes ----------

// Signed-out visitors land on the splash page; the reset page is the only
// other place they can go.
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', req.user ? 'index.html' : 'splash.html')));
app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.get('/guidelines', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guidelines.html')));
app.get('/admin', pageAuth, (req, res) => (req.user.role === 'admin'
  ? res.sendFile(path.join(__dirname, 'public', 'admin.html'))
  : res.redirect('/')));

app.get('/watch/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/shorts', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'shorts.html')));
app.get('/shorts/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'shorts.html')));
app.get('/channel/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'channel.html')));
app.get('/upload', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/live', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/live/:id', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'livewatch.html')));
app.get('/studio', pageAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'studio.html')));
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

live.init();
recommend.startSimilarityJob();

app.listen(PORT, () => {
  console.log(`⚓ Anchor is running at http://localhost:${PORT}`);
  console.log(transcode.available
    ? 'Transcoding: ffmpeg found — uploads will get multi-quality renditions.'
    : 'Transcoding: ffmpeg not found — videos will play in their original format only.');
  console.log(live.enabled
    ? `Live streaming: RTMP ingest on port ${live.RTMP_PORT} (rtmp://<host>:${live.RTMP_PORT}/live).`
    : 'Live streaming: disabled (requires ffmpeg).');
});
