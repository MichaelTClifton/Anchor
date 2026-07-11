// Offline evaluation harness for the recommendation engine.
//
// HONESTY CAVEAT: this runs against the synthetic data planted by
// scripts/seed-recs.js, so all it can prove is that the pipeline follows the
// planted preference structure (cluster viewers get cluster videos) and beats
// the old naive ranker on that structure without violating hard exclusions.
// It is a regression harness, not science — numbers here say nothing about
// real-user quality.
//
// Method: leave-last-out replay. For every user with >= 3 strong engagements
// we hold out their most recent one (video H at time tH), rewind the world to
// asOf = tH - 1 (leakage-free: history, likes, candidate videos and the
// similarity map are all rebuilt from rows at or before asOf), ask both the
// NEW recommender and a frozen copy of the OLD personalizedHome for a top-24,
// and check whether H comes back plus coverage/diversity/exclusion metrics.
//
// Usage: node scripts/eval-recs.js   (exit 0 = all pass criteria hold)

const { db } = require('../db');
const recommend = require('../recommend');

const LIMIT = 24;

// ---------- strong engagements ----------
// Strong engagement := watch_history row with completed=1 OR position >= 50%
// of duration (at updated_at), or a like with value=1 (at created_at). Likes
// with NULL created_at (pre-migration) carry no timestamp and are skipped as
// replay events — they cannot be ordered.

const engagementRows = db.prepare(`
  SELECT user_id, video_id, updated_at AS ts FROM watch_history
  WHERE completed = 1 OR (duration IS NOT NULL AND duration > 0 AND position >= 0.5 * duration)
  UNION ALL
  SELECT user_id, video_id, created_at AS ts FROM likes
  WHERE value = 1 AND created_at IS NOT NULL
`).all();

// Per user, dedupe by video keeping the latest timestamp (a like shortly after
// a watch of the same video is one taste signal, not two holdout candidates).
const byUser = new Map(); // user_id -> Map(video_id -> ts)
for (const r of engagementRows) {
  let m = byUser.get(r.user_id);
  if (!m) byUser.set(r.user_id, (m = new Map()));
  if (!m.has(r.video_id) || m.get(r.video_id) < r.ts) m.set(r.video_id, r.ts);
}

// ---------- leakage-free similarity ----------

const tagMap = new Map(); // video_id -> Set(tag_id)
for (const r of db.prepare('SELECT video_id, tag_id FROM video_tags').all()) {
  if (!tagMap.has(r.video_id)) tagMap.set(r.video_id, new Set());
  tagMap.get(r.video_id).add(r.tag_id);
}
const catMap = new Map(db.prepare('SELECT id, category FROM videos').all()
  .map(r => [r.id, r.category]));

// Rebuild item-item similarity from only the engagement rows visible at asOf,
// grouped the way recommend.personalizedHome's opts.similarity expects.
function similarityAt(asOf) {
  const visible = engagementRows.filter(r => r.ts <= asOf);
  const sim = new Map();
  for (const p of recommend.computeSimilarity(visible, tagMap, catMap)) {
    if (!sim.has(p.video_id)) sim.set(p.video_id, []);
    sim.get(p.video_id).push({ other_id: p.other_id, score: p.score });
  }
  for (const list of sim.values()) list.sort((a, b) => b.score - a.score);
  return sim;
}

// ---------- baseline: the OLD naive personalizedHome ----------
// Verbatim-as-possible copy of the pre-recommender server.js implementation
// this feature replaces, adapted only for replay: `updated_at <= asOf` on the
// watch_history reads, `v.created_at <= asOf` on the LIMIT-300 candidate
// window, and asOf standing in for "now" in the recency decay. Lives only in
// this file; do not "fix" it — it is the frozen comparison point.

const BASE_COLS = `v.id, v.duration, v.created_at, v.category,
  u.id AS channel_id, u.username AS channel_name`; // minimal cut of server.js VIDEO_COLS
const BASE_SELECT = `SELECT ${BASE_COLS} FROM videos v JOIN users u ON u.id = v.user_id`;

const baseSubs = db.prepare('SELECT channel_id FROM subscriptions WHERE subscriber_id = ?');
const baseTagWeight = db.prepare(`SELECT vt.tag_id, COUNT(*) AS c FROM watch_history h
  JOIN video_tags vt ON vt.video_id = h.video_id
  WHERE h.user_id = ? AND h.updated_at <= ? GROUP BY vt.tag_id`);
const baseFinished = db.prepare(`SELECT video_id FROM watch_history
  WHERE user_id = ? AND completed = 1 AND updated_at <= ?`);
const baseTagsOf = db.prepare('SELECT tag_id FROM video_tags WHERE video_id = ?');
const baseWindow = db.prepare(`${BASE_SELECT}
  WHERE v.is_short = 0 AND v.hidden = 0 AND v.created_at <= ?
  ORDER BY v.created_at DESC LIMIT 300`);

function baselineHome(userId, asOf, limit) {
  const subs = new Set(baseSubs.all(userId).map(r => r.channel_id));
  const tagWeight = new Map(baseTagWeight.all(userId, asOf).map(r => [r.tag_id, r.c]));
  const finished = new Set(baseFinished.all(userId, asOf).map(r => r.video_id));
  const rows = baseWindow.all(asOf);
  const now = asOf;
  for (const r of rows) {
    let score = 1 / ((now - r.created_at) / 86400 + 2);
    if (subs.has(r.channel_id)) score += 3;
    if (tagWeight.size) {
      for (const { tag_id } of baseTagsOf.all(r.id)) {
        if (tagWeight.has(tag_id)) score += Math.min(2, tagWeight.get(tag_id));
      }
    }
    if (finished.has(r.id)) score -= 1;
    r._score = score;
  }
  rows.sort((a, b) => b._score - a._score || b.created_at - a.created_at);
  return rows.slice(0, limit);
}

// ---------- hard-exclusion sets (as of asOf) ----------

const exCompleted = db.prepare(
  'SELECT video_id FROM watch_history WHERE user_id = ? AND completed = 1 AND updated_at <= ?');
const exDisliked = db.prepare(`SELECT video_id FROM likes
  WHERE user_id = ? AND value = -1 AND (created_at IS NULL OR created_at <= ?)`);
const exNotInterested = db.prepare(
  'SELECT video_id FROM not_interested WHERE user_id = ? AND created_at <= ?');
const exOwn = db.prepare('SELECT id AS video_id FROM videos WHERE user_id = ?');

function excludedSet(userId, asOf) {
  const set = new Set();
  for (const stmt of [exCompleted, exDisliked, exNotInterested]) {
    for (const r of stmt.all(userId, asOf)) set.add(r.video_id);
  }
  for (const r of exOwn.all(userId)) set.add(r.video_id);
  return set;
}

// ---------- replay ----------

const usernames = new Map(db.prepare('SELECT id, username FROM users').all()
  .map(r => [r.id, r.username]));

function newStats() {
  return { hit10: 0, hit24: 0, seen: new Set(), diversitySum: 0, violations: 0 };
}
function accumulate(stats, ids, channelOf, holdoutId, excluded) {
  if (ids.slice(0, 10).includes(holdoutId)) stats.hit10++;
  if (ids.includes(holdoutId)) stats.hit24++;
  for (const id of ids) {
    stats.seen.add(id);
    if (excluded.has(id)) stats.violations++;
  }
  stats.diversitySum += new Set(ids.map(channelOf)).size;
}

const base = newStats();
const next = newStats();
let evaluated = 0;

for (const [userId, videoTs] of byUser) {
  if (videoTs.size < 3) continue;
  // Holdout = the most recent strong engagement (ties broken by video id so
  // the replay is deterministic).
  let holdoutId = null, tH = -Infinity;
  for (const [vid, ts] of videoTs) {
    if (ts > tH || (ts === tH && vid > holdoutId)) { holdoutId = vid; tH = ts; }
  }
  const asOf = tH - 1;
  const excluded = excludedSet(userId, asOf);

  const newResult = recommend.personalizedHome(
    { id: userId, username: usernames.get(userId) },
    { o: 0, s: 42 }, // fixed cursor seed keeps exploration slots deterministic
    LIMIT,
    { asOf, similarity: similarityAt(asOf) });
  accumulate(next, newResult.videos.map(v => v.id),
    id => newResult.videos.find(v => v.id === id).channel_id, holdoutId, excluded);

  const baseRows = baselineHome(userId, asOf, LIMIT);
  accumulate(base, baseRows.map(v => v.id),
    id => baseRows.find(v => v.id === id).channel_id, holdoutId, excluded);

  evaluated++;
}

if (evaluated === 0) {
  console.error('No users with >= 3 strong engagements — run scripts/seed-recs.js first.');
  process.exit(1);
}

// ---------- metrics + verdict ----------

const eligible = db.prepare(
  'SELECT count(*) AS n FROM videos WHERE hidden = 0 AND is_short = 0').get().n;

function metrics(s) {
  return {
    r10: s.hit10 / evaluated,
    r24: s.hit24 / evaluated,
    coverage: eligible ? s.seen.size / eligible : 0,
    diversity: s.diversitySum / evaluated,
    violations: s.violations,
  };
}
const B = metrics(base);
const N = metrics(next);

const fmt = x => x.toFixed(3);
const rows = [
  ['metric', 'baseline', 'new'],
  ['Recall@10', fmt(B.r10), fmt(N.r10)],
  ['Recall@24', fmt(B.r24), fmt(N.r24)],
  ['Coverage', fmt(B.coverage), fmt(N.coverage)],
  ['Channel diversity', fmt(B.diversity), fmt(N.diversity)],
  ['Exclusion violations', String(B.violations), String(N.violations)],
];
const widths = [0, 1, 2].map(i => Math.max(...rows.map(r => r[i].length)));
console.log(`Evaluated ${evaluated} users (leave-last-out), ${eligible} eligible videos.\n`);
for (const r of rows) {
  console.log(`  ${r[0].padEnd(widths[0])}  ${r[1].padStart(widths[1])}  ${r[2].padStart(widths[2])}`);
}
console.log('');

// The diversity re-rank may trade a little top-10 recall for variety, so the
// Recall@10 gate is soft (>= 90% of baseline); Recall@24 must not regress.
const checks = [
  ['NEW Recall@24 >= baseline', N.r24 >= B.r24],
  ['NEW exclusion violations == 0', N.violations === 0],
  ['NEW channel diversity > baseline', N.diversity > B.diversity],
  ['NEW coverage >= baseline', N.coverage >= B.coverage],
  ['NEW Recall@10 >= 0.9 * baseline', N.r10 >= 0.9 * B.r10],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
db.close();
