const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR, THUMBS_DIR } = require('./db');
const transcode = require('./transcode');

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
    db.prepare(`
      INSERT INTO videos (id, user_id, title, description, filename, thumbnail, duration, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.user.id, title,
      String(req.body.description || '').trim().slice(0, 5000),
      videoFile.filename,
      thumbFile ? thumbFile.filename : null,
      Number.isFinite(duration) ? duration : null,
      transcode.available ? 'processing' : 'ready',
    );
    transcode.enqueue(id);
    res.json({ id });
  });

// ---------- video listing / detail ----------

const VIDEO_SELECT = `
  SELECT v.id, v.title, v.description, v.filename, v.thumbnail, v.duration,
         v.views, v.created_at, v.status, u.id AS channel_id, u.username AS channel_name
  FROM videos v JOIN users u ON u.id = v.user_id
`;

function getRenditions(videoId) {
  return db.prepare('SELECT height, filename FROM renditions WHERE video_id = ? ORDER BY height DESC')
    .all(videoId);
}

app.get('/api/videos', (req, res) => {
  const q = String(req.query.q || '').trim();
  const channel = parseInt(req.query.channel, 10);
  let rows;
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    rows = db.prepare(`${VIDEO_SELECT}
      WHERE v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
      ORDER BY v.created_at DESC LIMIT 100`).all(like, like, like);
  } else if (Number.isInteger(channel)) {
    rows = db.prepare(`${VIDEO_SELECT} WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT 100`).all(channel);
  } else {
    rows = db.prepare(`${VIDEO_SELECT} ORDER BY v.created_at DESC LIMIT 100`).all();
  }
  res.json({ videos: rows });
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

  video.renditions = getRenditions(video.id);
  video.related = db.prepare(`${VIDEO_SELECT} WHERE v.id != ? ORDER BY v.views DESC, v.created_at DESC LIMIT 12`)
    .all(video.id);
  res.json(video);
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
