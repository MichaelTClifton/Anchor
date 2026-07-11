// Deterministic synthetic-data seeder for the recommendation engine.
// Plants 4 taste clusters (category + tag bundle) with creators, videos and
// viewers whose watch/like/subscribe behaviour follows their cluster, so
// scripts/eval-recs.js has ground truth to replay against.
//
// Usage: node scripts/seed-recs.js [--clean] [--force] [--seed N]
//   --clean  remove every seed_ user (FK cascades take videos/likes/etc.) and exit
//   --force  bypass the real-database safety rail (see below)
//   --seed N PRNG seed (default 42) — same seed => identical data shape and ids
//
// All randomness comes from a seeded mulberry32 PRNG (never Math.random), so
// runs are reproducible. Every seeded username starts with `seed_`; the script
// refuses to touch a database containing any other user unless --force.

const crypto = require('crypto');
const { db, reindexVideo } = require('../db');

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
const FORCE = args.includes('--force');
const seedIdx = args.indexOf('--seed');
const SEED = seedIdx !== -1 ? parseInt(args[seedIdx + 1], 10) : 42;
if (!Number.isInteger(SEED)) {
  console.error('--seed expects an integer, e.g. --seed 42');
  process.exit(1);
}

// ---------- seeded PRNG ----------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1)); // inclusive
function shuffled(arr) { // Fisher-Yates on a copy, PRNG-driven
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function prngBytes(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

// ---------- safety rails ----------

// `_` is a LIKE wildcard, so escape it to match the literal seed_ prefix.
const SEED_LIKE = "username LIKE 'seed@_%' ESCAPE '@'";
const seedUserCount = () =>
  db.prepare(`SELECT count(*) AS n FROM users WHERE ${SEED_LIKE}`).get().n;
const realUserCount = () =>
  db.prepare(`SELECT count(*) AS n FROM users WHERE NOT ${SEED_LIKE}`).get().n;

if (CLEAN) {
  // Only rows belonging to seed_ users are touched, so --clean is safe even on
  // a database that also holds real accounts (it is the recovery path).
  const users = seedUserCount();
  const videos = db.prepare(
    `SELECT count(*) AS n FROM videos v JOIN users u ON u.id = v.user_id WHERE ${SEED_LIKE}`).get().n;
  db.prepare(`DELETE FROM users WHERE ${SEED_LIKE}`).run();
  // The videos delete trigger clears videos_fts on cascade; this is a safety net.
  const orphans = db.prepare(
    'DELETE FROM videos_fts WHERE video_id NOT IN (SELECT id FROM videos)').run().changes;
  console.log(`Removed ${users} seed users and ${videos} of their videos`
    + ` (likes/history/subs cascaded${orphans ? `; ${orphans} orphaned FTS rows swept` : ''}).`);
  db.close();
  process.exit(0);
}

if (realUserCount() > 0 && !FORCE) {
  console.error('Refusing to seed: the users table contains accounts that do not start with');
  console.error('`seed_` — this looks like a real database. Pass --force to seed anyway.');
  process.exit(1);
}
if (seedUserCount() > 0) {
  console.error('Seed users already exist. Run `node scripts/seed-recs.js --clean` first.');
  process.exit(1);
}

// ---------- data shape ----------

// 4 taste clusters: a category plus a bundle of distinctive tags. The single
// shared tag ("retro", synth <-> gaming) is deliberate, realistic noise.
const CLUSTERS = [
  { key: 'synth', category: 'Music', tags: ['synthwave', 'retrowave', 'electronic', 'analog', 'retro'],
    stems: ['Late Night Synthwave Mix', 'Analog Synth Jam', 'Retrowave Essentials', 'Neon Drive Soundtrack', 'Modular Patch Session'] },
  { key: 'gaming', category: 'Gaming', tags: ['speedrun', 'rpg', 'indie', 'esports', 'retro'],
    stems: ['Any% Speedrun Attempt', 'Indie RPG Deep Dive', 'Boss Rush Strategies', 'Retro Console Marathon', 'Ranked Ladder Climb'] },
  { key: 'cooking', category: 'Vlog', tags: ['cooking', 'recipe', 'baking', 'sourdough', 'kitchen'],
    stems: ['Weeknight Recipe', 'Sourdough Baking Diary', 'Kitchen Essentials Tour', 'One-Pot Cooking', 'Pastry Basics'] },
  { key: 'engineering', category: 'Tech', tags: ['programming', 'hardware', 'diy', 'electronics', 'opensource'],
    stems: ['DIY Hardware Build', 'Programming Deep Dive', 'Electronics Bench Repair', 'Open Source Tooling', 'Homelab Upgrade'] },
];
const CREATORS_PER_CLUSTER = 2;
const VIDEOS_PER_CLUSTER = 15;
const VIEWERS_PER_CLUSTER = 10;
const PASSWORD = 'seedpass123';

// Hash exactly like server.js hashPassword(). The salt is real randomness by
// design (matches production hashes); determinism only covers ids/counts/rows.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

// ---------- inserts ----------

const insertUser = db.prepare(
  'INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)');
const insertVideo = db.prepare(`INSERT INTO videos
  (id, user_id, title, description, filename, thumbnail, duration, views,
   created_at, status, category, is_short, hidden)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ready', ?, 0, 0)`);
const upsertTag = db.prepare(
  'INSERT INTO tags (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = name RETURNING id');
const insertVideoTag = db.prepare(
  'INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)');
const insertWatch = db.prepare(`INSERT INTO watch_history
  (user_id, video_id, position, duration, completed, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
const insertLike = db.prepare(
  'INSERT INTO likes (user_id, video_id, value, created_at) VALUES (?, ?, ?, ?)');
const insertSub = db.prepare(
  'INSERT INTO subscriptions (subscriber_id, channel_id, created_at) VALUES (?, ?, ?)');
const insertLater = db.prepare(
  'INSERT INTO watch_later (user_id, video_id, created_at) VALUES (?, ?, ?)');

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const counts = { users: 0, videos: 0, watches: 0, likes: 0, dislikes: 0, subs: 0, later: 0 };

function makeUser(name) {
  const info = insertUser.run(name, hashPassword(PASSWORD), `${name}@seed.invalid`);
  counts.users++;
  return info.lastInsertRowid;
}

const seed = db.transaction(() => {
  // Creators: 2 per cluster; cluster c owns seed_creator_{2c+1} and _{2c+2}.
  const creators = []; // [clusterIdx][0..1] -> user id
  for (let c = 0; c < CLUSTERS.length; c++) {
    creators.push([]);
    for (let k = 0; k < CREATORS_PER_CLUSTER; k++) {
      creators[c].push(makeUser(`seed_creator_${c * CREATORS_PER_CLUSTER + k + 1}`));
    }
  }

  // Videos: 15 per cluster, alternating between the cluster's two creators.
  // created_at is spread across the last ~58 days so time decay matters.
  const videos = []; // [clusterIdx] -> [{id, duration, created_at}]
  const usedIds = new Set();
  for (let c = 0; c < CLUSTERS.length; c++) {
    const cluster = CLUSTERS[c];
    videos.push([]);
    for (let i = 0; i < VIDEOS_PER_CLUSTER; i++) {
      let id;
      do { id = prngBytes(6).toString('base64url'); } while (usedIds.has(id));
      usedIds.add(id);
      const duration = randInt(300, 900);
      const createdAt = now - randInt(1, 58) * DAY - randInt(0, DAY - 1);
      const title = `${cluster.stems[i % cluster.stems.length]} #${i + 1}`;
      insertVideo.run(id, creators[c][i % CREATORS_PER_CLUSTER], title,
        `A ${cluster.key} video about ${cluster.tags.slice(0, 3).join(', ')}.`,
        `${prngBytes(6).toString('hex')}.mp4`, duration, randInt(50, 5000),
        createdAt, cluster.category);
      for (const tag of shuffled(cluster.tags).slice(0, randInt(3, 5))) {
        insertVideoTag.run(id, upsertTag.get(tag).id);
      }
      reindexVideo(id); // keep search consistent, same as server.js setTags()
      videos[c].push({ id, duration, created_at: createdAt });
      counts.videos++;
    }
  }

  // Watch timestamps live in the last 45 days and after the video existed.
  function watchTime(video) {
    const lo = Math.max(video.created_at + 1800, now - 45 * DAY);
    return randInt(Math.min(lo, now - 3600), now - 60);
  }

  // Viewers: 10 per cluster. ~80% of watches are in-cluster with high watch
  // fraction; ~20% out-of-cluster with low fraction. Only 15 in-cluster videos
  // exist, so the in-cluster count is capped at 15 and the out-of-cluster
  // count derived from it to preserve the ~80/20 ratio (total stays in 12-25).
  for (let c = 0; c < CLUSTERS.length; c++) {
    const inVideos = videos[c];
    const outVideos = videos.flatMap((v, i) => (i === c ? [] : v));
    for (let k = 0; k < VIEWERS_PER_CLUSTER; k++) {
      const userId = makeUser(`seed_viewer_${c * VIEWERS_PER_CLUSTER + k + 1}`);
      const target = randInt(12, 25);
      const nIn = Math.min(Math.round(target * 0.8), inVideos.length);
      const nOut = Math.max(2, Math.round(nIn / 4));

      const watchedIn = shuffled(inVideos).slice(0, nIn);
      const watchedOut = shuffled(outVideos).slice(0, nOut);
      const watchTs = new Map(); // video id -> updated_at, reused for like times
      for (const v of watchedIn) {
        const frac = 0.6 + rand() * 0.4;
        const ts = watchTime(v);
        insertWatch.run(userId, v.id, frac * v.duration, v.duration, frac >= 0.9 ? 1 : 0, ts);
        watchTs.set(v.id, ts);
        counts.watches++;
      }
      for (const v of watchedOut) {
        const frac = 0.05 + rand() * 0.25;
        const ts = watchTime(v);
        insertWatch.run(userId, v.id, frac * v.duration, v.duration, 0, ts);
        watchTs.set(v.id, ts);
        counts.watches++;
      }

      // Likes on in-cluster videos they watched; dislikes on out-of-cluster ones.
      for (const v of shuffled(watchedIn).slice(0, randInt(3, Math.min(6, nIn)))) {
        insertLike.run(userId, v.id, 1, Math.min(now, watchTs.get(v.id) + randInt(0, 3600)));
        counts.likes++;
      }
      for (const v of shuffled(watchedOut).slice(0, randInt(1, Math.min(3, nOut)))) {
        insertLike.run(userId, v.id, -1, Math.min(now, watchTs.get(v.id) + randInt(0, 3600)));
        counts.dislikes++;
      }

      // Subscriptions: both in-cluster creators, plus 0-2 others as noise
      // (a cluster only has 2 creators, so "2-4 subs" = 2 in-cluster + noise).
      const channels = [...creators[c],
        ...shuffled(creators.flatMap((cr, i) => (i === c ? [] : cr))).slice(0, randInt(0, 2))];
      for (const ch of channels) {
        insertSub.run(userId, ch, now - randInt(0, 40 * DAY));
        counts.subs++;
      }

      // Watch-later saves on in-cluster videos they have NOT watched yet.
      const unwatched = inVideos.filter(v => !watchTs.has(v.id));
      for (const v of shuffled(unwatched).slice(0, randInt(0, Math.min(3, unwatched.length)))) {
        insertLater.run(userId, v.id, now - randInt(0, 40 * DAY));
        counts.later++;
      }
    }
  }
});

seed();

console.log(`Seeded (PRNG seed ${SEED}):`);
console.log(`  users:         ${counts.users} (${CLUSTERS.length * CREATORS_PER_CLUSTER} creators, ${CLUSTERS.length * VIEWERS_PER_CLUSTER} viewers)`);
console.log(`  videos:        ${counts.videos}`);
console.log(`  watch history: ${counts.watches}`);
console.log(`  likes:         ${counts.likes} (+ ${counts.dislikes} dislikes)`);
console.log(`  subscriptions: ${counts.subs}`);
console.log(`  watch later:   ${counts.later}`);
console.log('Test logins (password for every seed user is the same):');
CLUSTERS.forEach((cluster, c) => {
  console.log(`  seed_viewer_${c * VIEWERS_PER_CLUSTER + 1} / ${PASSWORD} (cluster: ${cluster.key})`);
});
db.close();
