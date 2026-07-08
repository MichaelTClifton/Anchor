const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbnails');
const LIVE_DIR = path.join(DATA_DIR, 'live');

for (const dir of [DATA_DIR, UPLOADS_DIR, THUMBS_DIR, LIVE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'anchor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    thumbnail TEXT,
    duration REAL,
    views INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value IN (1, -1)),
    PRIMARY KEY (user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    subscriber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (subscriber_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS renditions (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    height INTEGER NOT NULL,
    filename TEXT NOT NULL,
    PRIMARY KEY (video_id, height)
  );

  -- Resume position + watch history; one upserted row per (user, video).
  CREATE TABLE IF NOT EXISTS watch_history (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    duration REAL,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, video_id)
  );

  CREATE TABLE IF NOT EXISTS watch_later (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, video_id)
  );

  -- WebAuthn credentials; public_key is a JWK (JSON), id is the base64url
  -- credential id reported by the authenticator.
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  -- User reports against videos or comments; the moderation queue reads
  -- status='open'. target_id is TEXT because video ids are TEXT (comment ids
  -- are INTEGERs stored as text — cast when joining).
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('video', 'comment')),
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN
      ('spam', 'harassment', 'sexual', 'violence', 'copyright', 'other')),
    details TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_by INTEGER REFERENCES users(id),
    resolved_at INTEGER
  );

  -- Partial unique index: one OPEN report per user per target, but the same
  -- user may report again if the target re-offends after a resolution.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_open_dup
    ON reports(reporter_id, target_type, target_id) WHERE status = 'open';
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at DESC);

  -- Live streams: one row per broadcast session. VODs reference the videos
  -- table once a stream ends and its recording is archived.
  CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    live INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at INTEGER,
    vod_video_id TEXT REFERENCES videos(id) ON DELETE SET NULL,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_streams_live ON streams(live, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_streams_user ON streams(user_id);

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS video_tags (
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (video_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
  CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
  CREATE INDEX IF NOT EXISTS idx_history_user_time ON watch_history(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_watchlater_user ON watch_later(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id);

  -- Full-text search. Standalone (own-content) FTS5 table because the indexed
  -- columns span videos + users + tags; kept in sync via reindexVideo() below
  -- plus a delete trigger as a safety net.
  CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    title, description, channel_name, tags,
    video_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS videos_fts_ad AFTER DELETE ON videos BEGIN
    DELETE FROM videos_fts WHERE video_id = old.id;
  END;
`);

// Migration for databases created before the transcoding pipeline existed.
const videoColumns = db.prepare('PRAGMA table_info(videos)').all();
if (!videoColumns.some(c => c.name === 'status')) {
  db.exec("ALTER TABLE videos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'");
}
if (!videoColumns.some(c => c.name === 'category')) {
  db.exec('ALTER TABLE videos ADD COLUMN category TEXT');
}
if (!videoColumns.some(c => c.name === 'is_short')) {
  db.exec('ALTER TABLE videos ADD COLUMN is_short INTEGER NOT NULL DEFAULT 0');
}
// Moderation takedown flag. Deliberately separate from the transcode `status`
// column, which transcode.js resets to 'ready' at startup and would clobber
// a status-based takedown.
if (!videoColumns.some(c => c.name === 'hidden')) {
  db.exec('ALTER TABLE videos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

// Account-security columns. email is nullable because pre-existing accounts
// have none (they can add one in Settings); new signups require it.
const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some(c => c.name === 'email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');
}
if (!userColumns.some(c => c.name === 'totp_secret')) {
  db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  db.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
}
// Moderation: admin role (bootstrapped via scripts/make-admin.js) and account
// suspension (enforced in getUser, so existing sessions die immediately).
if (!userColumns.some(c => c.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  db.exec('ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
}
// Live streaming: the RTMP stream key (24 hex, lazily generated by /api/studio)
// and the title applied to the user's next/current broadcast.
if (!userColumns.some(c => c.name === 'stream_key')) {
  db.exec('ALTER TABLE users ADD COLUMN stream_key TEXT');
  db.exec("ALTER TABLE users ADD COLUMN stream_title TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stream_key ON users(stream_key) WHERE stream_key IS NOT NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id)');

// Rebuild a single video's FTS row from the source tables. The only writer of
// videos_fts inserts; every mutation (upload, edit, tag change) routes here.
const reindexStmt = db.prepare(`
  INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
  SELECT v.id, v.title, v.description, u.username,
         COALESCE((SELECT group_concat(t.name, ' ') FROM video_tags vt
                   JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id), '')
  FROM videos v JOIN users u ON u.id = v.user_id
  WHERE v.id = ? AND v.hidden = 0
`);
// The hidden filter above makes this the single hide/restore mechanism for
// search: reindexing a hidden video deletes its FTS row and inserts nothing,
// so even an owner edit (PATCH/setTags both land here) can't resurrect a
// taken-down video in search or suggestions.
function reindexVideo(id) {
  db.prepare('DELETE FROM videos_fts WHERE video_id = ?').run(id);
  reindexStmt.run(id);
}

// One-time backfill for databases that predate the search index.
if (db.prepare('SELECT count(*) AS n FROM videos_fts').get().n === 0
    && db.prepare('SELECT count(*) AS n FROM videos').get().n > 0) {
  const ids = db.prepare('SELECT id FROM videos').all();
  const backfill = db.transaction(rows => { for (const r of rows) reindexVideo(r.id); });
  backfill(ids);
  console.log(`Search index: backfilled ${ids.length} videos.`);
}

module.exports = { db, DATA_DIR, UPLOADS_DIR, THUMBS_DIR, LIVE_DIR, reindexVideo };
