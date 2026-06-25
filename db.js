const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbnails');

for (const dir of [DATA_DIR, UPLOADS_DIR, THUMBS_DIR]) {
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

// Rebuild a single video's FTS row from the source tables. The only writer of
// videos_fts inserts; every mutation (upload, edit, tag change) routes here.
const reindexStmt = db.prepare(`
  INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
  SELECT v.id, v.title, v.description, u.username,
         COALESCE((SELECT group_concat(t.name, ' ') FROM video_tags vt
                   JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id), '')
  FROM videos v JOIN users u ON u.id = v.user_id
  WHERE v.id = ?
`);
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

module.exports = { db, DATA_DIR, UPLOADS_DIR, THUMBS_DIR, reindexVideo };
