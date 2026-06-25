const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR, THUMBS_DIR, reindexVideo } = require('./db');
const transcode = require('./transcode');

const CATEGORIES = ['Music', 'Gaming', 'Education', 'Tech', 'Vlog', 'News', 'Sports', 'Other'];

const PORT = process.env.PORT || 3000;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1 GB
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// express.static handles HTTP Range requests, so seeking in the player works.
app.use('/media', express.static(UPLOADS_DIR));
app.use('/thumbs', express.static(THUMBS_DIR));

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
  req.user = getUser(req);
  if (!req.user) return res.status(401).json({ error: 'You must be signed in to do that.' });
  next();
}

// ---------- auth routes ----------

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscores.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hashPassword(password));
    startSession(res, info.lastInsertRowid);
    res.json({ id: info.lastInsertRowid, username });
  } catch (e) {
    res.status(409).json({ error: 'That username is taken.' });
  }
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
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
    db.prepare(`
      INSERT INTO videos (id, user_id, title, description, filename, thumbnail, duration, status, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.user.id, title,
      String(req.body.description || '').trim().slice(0, 5000),
      videoFile.filename,
      thumbFile ? thumbFile.filename : null,
      Number.isFinite(duration) ? duration : null,
      transcode.available ? 'processing' : 'ready',
      category,
    );
    setTags(id, req.body.tags); // also writes the search-index row
    transcode.enqueue(id);
    res.json({ id });
  });

// ---------- video listing / detail ----------

const VIDEO_COLS = `v.id, v.title, v.description, v.filename, v.thumbnail, v.duration,
         v.views, v.created_at, v.status, v.category,
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
function relatedVideos(videoId) {
  const out = db.prepare(`SELECT ${VIDEO_COLS}, COUNT(vt2.tag_id) AS shared
    FROM video_tags vt1
    JOIN video_tags vt2 ON vt2.tag_id = vt1.tag_id AND vt2.video_id <> vt1.video_id
    JOIN videos v ON v.id = vt2.video_id
    JOIN users u ON u.id = v.user_id
    WHERE vt1.video_id = ?
    GROUP BY v.id
    ORDER BY shared DESC, v.views DESC, v.created_at DESC
    LIMIT 12`).all(videoId);
  if (out.length < 12) {
    const have = new Set([videoId, ...out.map(v => v.id)]);
    const fillers = db.prepare(`${VIDEO_SELECT} WHERE v.id <> ?
      ORDER BY v.views DESC, v.created_at DESC LIMIT 40`).all(videoId);
    for (const f of fillers) {
      if (out.length >= 12) break;
      if (!have.has(f.id)) { have.add(f.id); out.push(f); }
    }
  }
  return out;
}

app.get('/api/videos', (req, res) => {
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
  if (category) return res.json(chronoFeed('v.category = ?', [category], cursor, limit));
  if (Number.isInteger(channel)) return res.json(chronoFeed('v.user_id = ?', [channel], cursor, limit));
  res.json(chronoFeed('', [], cursor, limit));
});

// Search-as-you-type suggestions (de-duplicated titles, most relevant first).
app.get('/api/search/suggest', (req, res) => {
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
app.get('/api/categories', (req, res) => {
  const counts = Object.fromEntries(db.prepare(
    `SELECT category, COUNT(*) AS n FROM videos
     WHERE category IS NOT NULL AND category <> '' GROUP BY category`).all()
    .map(c => [c.category, c.n]));
  res.json({ categories: CATEGORIES.map(name => ({ name, count: counts[name] || 0 })) });
});

app.get('/api/videos/:id', (req, res) => {
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
app.get('/api/videos/:id/status', (req, res) => {
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

app.get('/api/videos/:id/comments', (req, res) => {
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

app.get('/api/channels/:id', (req, res) => {
  const channel = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  const me = getUser(req);
  channel.subscribers = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE channel_id = ?').get(channel.id).n;
  channel.total_views = db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM videos WHERE user_id = ?').get(channel.id).n;
  channel.subscribed = me
    ? !!db.prepare('SELECT 1 FROM subscriptions WHERE subscriber_id = ? AND channel_id = ?').get(me.id, channel.id)
    : false;
  channel.videos = db.prepare(`${VIDEO_SELECT} WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 100`).all(channel.id);
  res.json(channel);
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

// ---------- pretty page routes ----------

app.get('/watch/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/channel/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'channel.html')));
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/browse', (req, res) => res.sendFile(path.join(__dirname, 'public', 'browse.html')));

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
