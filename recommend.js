// Recommendation engine. Two-stage personalized home feed (candidate
// generation -> profile scoring -> greedy diversity re-rank), item-item
// co-engagement similarity ("viewers of X also watched Y"), impression
// tracking and not-interested handling. Requiring this module only prepares
// statements; no timers run until startSimilarityJob() is called.

const { db } = require('./db');

// ---------- tuning constants ----------

const HALF_LIFE_DAYS = 14;      // profile signals halve every two weeks
const W_SUB = 2.5;              // subscribed to the channel
const W_TAG = 2.0;              // tag affinity
const W_CF = 2.5;               // co-engagement neighbor affinity
const W_CHAN = 1.0;             // channel affinity (watched, not subscribed)
const W_CAT = 0.75;             // category affinity
const W_FRESH = 1.5;            // recency
const W_POP = 0.5;              // pool-normalized popularity
const IMPRESSION_DECAY = 0.85;  // per sighting beyond the free ones
const IMPRESSION_FREE = 2;
const IN_PROGRESS_MULT = 0.3;   // already started -> Continue Watching's job
const DISLIKE_PENALTY = -1.25;  // flat, undecayed: a durable "not this"

// Similarity job.
const MIN_CO = 1;               // minimum co-engagements to keep a pair
const TOP_NEIGHBORS = 20;       // neighbors kept per video
const USER_ENGAGEMENT_CAP = 200; // per-user cap bounds the O(sum k^2) pair loop
const SIM_TAG_BOOST = 0.15;     // content boost: shared tags (capped)
const SIM_CAT_BOOST = 0.10;     // content boost: same non-null category
const SIM_TAG_CAP = 5;
const IMPRESSION_TTL_DAYS = 30; // impressions older than this are pruned
const JOB_FIRST_DELAY_MS = 30 * 1000;
const JOB_INTERVAL_MS = 60 * 60 * 1000;

// Profile.
const PROFILE_HISTORY_CAP = 200;
const PROFILE_LIKES_CAP = 500;
const PROFILE_WATCH_LATER_CAP = 200;
const PROFILE_TOP_TAGS = 20;
const PROFILE_TOP_CATS = 8;
const RECENT_STRONG = 15;       // CF seeds: most recent strong engagements
const LIKE_W = 1.0;
const WATCH_LATER_W = 0.4;
const MIN_WATCH_W = 0.15;       // even an abandoned watch is a weak signal
const UNKNOWN_DURATION_FRAC = 0.3;
const IN_PROGRESS_MIN_POS = 5;  // seconds; matches /api/history?incomplete=1

// Candidate generation (pool is bounded by these limits by construction).
const SUB_CANDS = 40;
const TAG_CAND_TAGS = 8;
const TAG_RECENT = 12;
const TAG_POPULAR = 8;
const CAT_CAND_CATS = 2;
const CAT_RECENT = 15;
const CF_NEIGHBORS_PER_SEED = 10;
const TRENDING_CANDS = 30;
const NEWEST_CANDS = 20;
const TRENDING_WINDOW_DAYS = 30;

// Diversity re-rank.
const PAGE_BLOCK = 24;          // constraints reset per block of 24 slots
const CHANNEL_BLOCK_CAP = 2;    // max videos per channel per block
const EXPLORE_OFFSETS = new Set([6, 13, 20]); // in-block exploration slots
const EXPLORE_MAX_AFF = 0.01;   // "near-zero affinity" threshold
const CAT_DAMP_RATIO = 0.8;     // alternative must be within 20% of the best

// Related videos.
const RELATED_LIMIT = 12;
const REL_CF_W = 1.0;
const REL_TAG_W = 0.4;
const REL_CHAN_W = 0.1;

const IMPRESSION_BATCH_CAP = 50;

// Upper bound for created_at filters when opts.asOf is not set.
const FAR_FUTURE = 4102444800; // 2100-01-01

// Kept in sync BY HAND with VIDEO_COLS / VIDEO_SELECT in server.js — not
// imported because requiring server.js from here would be circular.
const VIDEO_COLS = `v.id, v.title, v.description, v.filename, v.thumbnail, v.duration,
         v.views, v.created_at, v.status, v.category, v.is_short, v.hidden,
         u.id AS channel_id, u.username AS channel_name`;
const VIDEO_SELECT = `SELECT ${VIDEO_COLS} FROM videos v JOIN users u ON u.id = v.user_id`;

// ---------- small helpers ----------

function squash(x) { return x / (1 + Math.abs(x)); }

// Deterministic PRNG for exploration slots; the seed rides in the cursor so a
// scroll session re-ranks identically on every page.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same encoding server.js uses for its cursors.
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Exactly the VIDEO_COLS shape; drops scoring fields and trending sub-counts.
function publicVideo(r) {
  return {
    id: r.id, title: r.title, description: r.description, filename: r.filename,
    thumbnail: r.thumbnail, duration: r.duration, views: r.views,
    created_at: r.created_at, status: r.status, category: r.category,
    is_short: r.is_short, hidden: r.hidden,
    channel_id: r.channel_id, channel_name: r.channel_name,
  };
}

// Batched IN (...) lookups; chunked to stay well under SQLite's bound-variable
// limit. `/*ids*/` in the SQL marks where the placeholder list goes.
function batchRows(sql, ids, extra = []) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...db.prepare(sql.replace('/*ids*/', chunk.map(() => '?').join(', ')))
      .all(...extra, ...chunk));
  }
  return out;
}

// ---------- prepared statements ----------

// A "strong engagement" is a completed/half-watched history row or an
// explicit like (dislikes never count); hidden and short videos are excluded.
// This exact definition is shared by the similarity job and recentStrong.
const stmts = {
  // profile signals (each windowed by an upper timestamp bound for opts.asOf)
  history: db.prepare(`SELECT video_id, position, duration, completed, updated_at
    FROM watch_history WHERE user_id = ? AND updated_at <= ?
    ORDER BY updated_at DESC LIMIT ${PROFILE_HISTORY_CAP}`),
  likes: db.prepare(`SELECT video_id, value, created_at FROM likes
    WHERE user_id = ? AND (created_at IS NULL OR created_at <= ?)
    ORDER BY COALESCE(created_at, 0) DESC LIMIT ${PROFILE_LIKES_CAP}`),
  watchLater: db.prepare(`SELECT video_id, created_at FROM watch_later
    WHERE user_id = ? AND created_at <= ?
    ORDER BY created_at DESC LIMIT ${PROFILE_WATCH_LATER_CAP}`),
  completed: db.prepare(
    'SELECT video_id FROM watch_history WHERE user_id = ? AND completed = 1 AND updated_at <= ?'),
  disliked: db.prepare(`SELECT video_id FROM likes
    WHERE user_id = ? AND value = -1 AND (created_at IS NULL OR created_at <= ?)`),
  notInterested: db.prepare(
    'SELECT video_id FROM not_interested WHERE user_id = ? AND created_at <= ?'),
  ownUploads: db.prepare('SELECT id FROM videos WHERE user_id = ?'),
  inProgress: db.prepare(`SELECT video_id FROM watch_history
    WHERE user_id = ? AND completed = 0 AND position > ${IN_PROGRESS_MIN_POS}
      AND updated_at <= ?`),
  homeImpressions: db.prepare(
    "SELECT video_id, count FROM impressions WHERE user_id = ? AND surface = 'home'"),
  subs: db.prepare('SELECT channel_id FROM subscriptions WHERE subscriber_id = ?'),
  recentStrong: db.prepare(`
    SELECT video_id, MAX(ts) AS ts FROM (
      SELECT h.video_id, h.updated_at AS ts
      FROM watch_history h JOIN videos v ON v.id = h.video_id
      WHERE h.user_id = ? AND h.updated_at <= ? AND v.hidden = 0 AND v.is_short = 0
        AND (h.completed = 1 OR (h.duration IS NOT NULL AND h.position >= 0.5 * h.duration))
      UNION ALL
      SELECT l.video_id, COALESCE(l.created_at, 0)
      FROM likes l JOIN videos v ON v.id = l.video_id
      WHERE l.user_id = ? AND l.value = 1 AND (l.created_at IS NULL OR l.created_at <= ?)
        AND v.hidden = 0 AND v.is_short = 0
    ) GROUP BY video_id ORDER BY ts DESC LIMIT ${RECENT_STRONG}`),

  // candidate generation
  candSubs: db.prepare(`${VIDEO_SELECT}
    WHERE v.hidden = 0 AND v.is_short = 0 AND v.created_at <= ?
      AND v.user_id IN (SELECT channel_id FROM subscriptions WHERE subscriber_id = ?)
    ORDER BY v.created_at DESC, v.id DESC LIMIT ${SUB_CANDS}`),
  candTagRecent: db.prepare(`${VIDEO_SELECT}
    JOIN video_tags vt ON vt.video_id = v.id
    WHERE v.hidden = 0 AND v.is_short = 0 AND v.created_at <= ? AND vt.tag_id = ?
    ORDER BY v.created_at DESC, v.id DESC LIMIT ${TAG_RECENT}`),
  candTagPopular: db.prepare(`${VIDEO_SELECT}
    JOIN video_tags vt ON vt.video_id = v.id
    WHERE v.hidden = 0 AND v.is_short = 0 AND v.created_at <= ? AND vt.tag_id = ?
    ORDER BY v.views DESC, v.created_at DESC, v.id DESC LIMIT ${TAG_POPULAR}`),
  candCategory: db.prepare(`${VIDEO_SELECT}
    WHERE v.hidden = 0 AND v.is_short = 0 AND v.created_at <= ? AND v.category = ?
    ORDER BY v.created_at DESC, v.id DESC LIMIT ${CAT_RECENT}`),
  candNewest: db.prepare(`${VIDEO_SELECT}
    WHERE v.hidden = 0 AND v.is_short = 0 AND v.created_at <= ?
    ORDER BY v.created_at DESC, v.id DESC LIMIT ${NEWEST_CANDS}`),
  // Same engagement counts and JS-side scoring as GET /api/trending.
  candTrending: db.prepare(`SELECT ${VIDEO_COLS},
      (SELECT COUNT(*) FROM likes l WHERE l.video_id = v.id AND l.value = 1) AS like_count,
      (SELECT COUNT(*) FROM comments c WHERE c.video_id = v.id) AS comment_count
    FROM videos v JOIN users u ON u.id = v.user_id
    WHERE v.created_at > ? AND v.created_at <= ? AND v.is_short = 0 AND v.hidden = 0`),
  neighbors: db.prepare(`SELECT other_id, score FROM video_similarity
    WHERE video_id = ? ORDER BY score DESC, other_id LIMIT ?`),

  // similarity job
  engagement: db.prepare(`
    SELECT user_id, video_id, MAX(ts) AS ts FROM (
      SELECT h.user_id, h.video_id, h.updated_at AS ts
      FROM watch_history h JOIN videos v ON v.id = h.video_id
      WHERE v.hidden = 0 AND v.is_short = 0
        AND (h.completed = 1 OR (h.duration IS NOT NULL AND h.position >= 0.5 * h.duration))
      UNION ALL
      SELECT l.user_id, l.video_id, COALESCE(l.created_at, 0)
      FROM likes l JOIN videos v ON v.id = l.video_id
      WHERE l.value = 1 AND v.hidden = 0 AND v.is_short = 0
    ) GROUP BY user_id, video_id`),
  allVideoTags: db.prepare('SELECT video_id, tag_id FROM video_tags'),
  allCategories: db.prepare('SELECT id, category FROM videos WHERE hidden = 0 AND is_short = 0'),
  maxEngagementTs: db.prepare(`
    SELECT MAX(ts) AS ts FROM (
      SELECT MAX(updated_at) AS ts FROM watch_history
      UNION ALL
      SELECT MAX(created_at) FROM likes
    )`),
  clearSimilarity: db.prepare('DELETE FROM video_similarity'),
  insertSimilarity: db.prepare(
    'INSERT INTO video_similarity (video_id, other_id, score) VALUES (?, ?, ?)'),
  pruneImpressions: db.prepare(
    `DELETE FROM impressions WHERE last_at < unixepoch() - ${IMPRESSION_TTL_DAYS * 86400}`),

  // related videos (tag-overlap query shape from server.js's old relatedVideos)
  relatedByTags: db.prepare(`SELECT ${VIDEO_COLS}, COUNT(vt2.tag_id) AS shared
    FROM video_tags vt1
    JOIN video_tags vt2 ON vt2.tag_id = vt1.tag_id AND vt2.video_id <> vt1.video_id
    JOIN videos v ON v.id = vt2.video_id
    JOIN users u ON u.id = v.user_id
    WHERE vt1.video_id = ? AND v.is_short = 0 AND v.hidden = 0
    GROUP BY v.id
    ORDER BY shared DESC, v.views DESC, v.created_at DESC
    LIMIT 40`),
  relatedNeighbors: db.prepare('SELECT other_id, score FROM video_similarity WHERE video_id = ?'),
  relatedFiller: db.prepare(`${VIDEO_SELECT} WHERE v.id <> ? AND v.is_short = 0 AND v.hidden = 0
    ORDER BY v.views DESC, v.created_at DESC LIMIT 40`),
  videoChannel: db.prepare('SELECT user_id FROM videos WHERE id = ?'),

  // impressions / not interested
  upsertImpression: db.prepare(`
    INSERT INTO impressions (user_id, video_id, surface)
    SELECT ?, id, ? FROM videos WHERE id = ?
    ON CONFLICT (user_id, video_id, surface) DO UPDATE SET
      count = count + 1, last_at = unixepoch()`),
  videoVisible: db.prepare('SELECT 1 FROM videos WHERE id = ? AND hidden = 0'),
  addNotInterested: db.prepare(
    'INSERT OR IGNORE INTO not_interested (user_id, video_id) VALUES (?, ?)'),
  removeNotInterested: db.prepare('DELETE FROM not_interested WHERE user_id = ? AND video_id = ?'),
};

const writeSimilarity = db.transaction(rows => {
  stmts.clearSimilarity.run();
  for (const r of rows) stmts.insertSimilarity.run(r.video_id, r.other_id, r.score);
  // Same run prunes stale impressions so no separate janitor is needed.
  stmts.pruneImpressions.run();
});

const recordImpressionsTxn = db.transaction((userId, surface, ids) => {
  let recorded = 0;
  // INSERT ... SELECT against videos: unknown ids match nothing and are
  // silently dropped (changes = 0 for them).
  for (const id of ids) recorded += stmts.upsertImpression.run(userId, surface, id).changes;
  return recorded;
});

// ---------- similarity (item-item co-engagement CF) ----------

// Pure — no DB access (the eval harness reuses it on filtered data).
// engRows: [{user_id, video_id, ts}] deduped per (user, video);
// tagMap: Map(video_id -> Set of tag ids); catMap: Map(video_id -> category|null).
function computeSimilarity(engRows, tagMap, catMap) {
  const byUser = new Map();
  for (const r of engRows) {
    let list = byUser.get(r.user_id);
    if (!list) byUser.set(r.user_id, list = []);
    list.push(r);
  }

  const co = new Map();  // 'a|b' (a < b; video ids never contain '|') -> count
  const nOf = new Map(); // video -> engagement count after the per-user cap
  for (const list of byUser.values()) {
    // Cap each user at their most recent engagements: bounds the pair loop
    // and keeps hyperactive users from dominating every pair count.
    list.sort((a, b) => b.ts - a.ts || (a.video_id < b.video_id ? -1 : 1));
    const vids = list.slice(0, USER_ENGAGEMENT_CAP).map(r => r.video_id);
    for (const v of vids) nOf.set(v, (nOf.get(v) || 0) + 1);
    for (let i = 0; i < vids.length; i++) {
      for (let j = i + 1; j < vids.length; j++) {
        if (vids[i] === vids[j]) continue;
        const key = vids[i] < vids[j] ? `${vids[i]}|${vids[j]}` : `${vids[j]}|${vids[i]}`;
        co.set(key, (co.get(key) || 0) + 1);
      }
    }
  }

  const neighborsMap = new Map(); // video -> [{other_id, score}]
  const push = (a, b, score) => {
    let list = neighborsMap.get(a);
    if (!list) neighborsMap.set(a, list = []);
    list.push({ other_id: b, score });
  };
  for (const [key, count] of co) {
    if (count < MIN_CO) continue;
    const [a, b] = key.split('|');
    // Cosine normalizes away popularity bias: co-occurring with a blockbuster
    // means little unless the blockbuster's own count is factored in.
    const cosine = count / Math.sqrt(nOf.get(a) * nOf.get(b));
    const tagsA = tagMap.get(a), tagsB = tagMap.get(b);
    let shared = 0;
    if (tagsA && tagsB) {
      const [small, big] = tagsA.size <= tagsB.size ? [tagsA, tagsB] : [tagsB, tagsA];
      for (const t of small) {
        if (big.has(t) && ++shared >= SIM_TAG_CAP) break;
      }
    }
    const catA = catMap.get(a);
    const sameCat = catA != null && catA === catMap.get(b) ? 1 : 0;
    const score = cosine + SIM_TAG_BOOST * (Math.min(shared, SIM_TAG_CAP) / SIM_TAG_CAP)
      + SIM_CAT_BOOST * sameCat;
    push(a, b, score);
    push(b, a, score);
  }

  const rows = [];
  for (const [videoId, list] of neighborsMap) {
    list.sort((x, y) => y.score - x.score || (x.other_id < y.other_id ? -1 : 1));
    for (const n of list.slice(0, TOP_NEIGHBORS)) {
      rows.push({ video_id: videoId, other_id: n.other_id, score: n.score });
    }
  }
  return rows;
}

// Watermark of the newest engagement timestamp covered by the last build; the
// hourly tick skips the rebuild when nothing newer exists.
let similarityWatermark = -1;

function rebuildSimilarity() {
  const engRows = stmts.engagement.all();
  const tagMap = new Map();
  for (const r of stmts.allVideoTags.all()) {
    let set = tagMap.get(r.video_id);
    if (!set) tagMap.set(r.video_id, set = new Set());
    set.add(r.tag_id);
  }
  const catMap = new Map(stmts.allCategories.all().map(r => [r.id, r.category]));
  const rows = computeSimilarity(engRows, tagMap, catMap);
  writeSimilarity(rows);
  // Taken from the same cheap MAX the hourly tick uses (a superset of the
  // strong-engagement definition), so tick-vs-watermark comparisons agree.
  const ts = stmts.maxEngagementTs.get().ts;
  similarityWatermark = ts == null ? -1 : ts;
  return { videos: new Set(rows.map(r => r.video_id)).size, pairs: rows.length };
}

let jobStarted = false;

function startSimilarityJob() {
  if (jobStarted) return;
  jobStarted = true;
  const build = () => {
    try {
      const stats = rebuildSimilarity();
      console.log(`Similarity: ${stats.pairs} neighbor pairs across ${stats.videos} videos.`);
    } catch (e) {
      console.error(`Similarity rebuild failed: ${e.message}`);
    }
  };
  // unref() so the timers never keep a shutting-down process alive.
  setTimeout(build, JOB_FIRST_DELAY_MS).unref();
  setInterval(() => {
    const ts = stmts.maxEngagementTs.get().ts;
    if (ts != null && ts > similarityWatermark) build();
  }, JOB_INTERVAL_MS).unref();
}

// ---------- user profile ----------

function buildProfile(userId, { asOf } = {}) {
  const now = asOf || Math.floor(Date.now() / 1000);
  const decay = ts => (ts == null
    ? 0.5 // pre-migration likes have no timestamp; treat as half-decayed
    : Math.pow(0.5, Math.max(0, now - ts) / (HALF_LIFE_DAYS * 86400)));

  // Aggregate every event's weight onto its video first.
  const videoW = new Map();
  const bump = (id, w) => videoW.set(id, (videoW.get(id) || 0) + w);
  for (const h of stmts.history.all(userId, now)) {
    const watchFrac = h.completed ? 1
      : (h.duration ? Math.min(1, Math.max(0, h.position / h.duration)) : UNKNOWN_DURATION_FRAC);
    bump(h.video_id, Math.max(MIN_WATCH_W, watchFrac) * decay(h.updated_at));
  }
  for (const l of stmts.likes.all(userId, now)) {
    bump(l.video_id, l.value === 1 ? LIKE_W * decay(l.created_at) : DISLIKE_PENALTY);
  }
  for (const w of stmts.watchLater.all(userId, now)) {
    bump(w.video_id, WATCH_LATER_W * decay(w.created_at));
  }

  // Spread video weights onto tags / category / channel (one batched lookup).
  const tagW = new Map(), catW = new Map(), chanW = new Map();
  const ids = [...videoW.keys()];
  if (ids.length) {
    for (const r of batchRows(
        'SELECT video_id, tag_id FROM video_tags WHERE video_id IN (/*ids*/)', ids)) {
      tagW.set(r.tag_id, (tagW.get(r.tag_id) || 0) + videoW.get(r.video_id));
    }
    for (const r of batchRows(
        'SELECT id, category, user_id FROM videos WHERE id IN (/*ids*/)', ids)) {
      const w = videoW.get(r.id);
      if (r.category != null) catW.set(r.category, (catW.get(r.category) || 0) + w);
      chanW.set(r.user_id, (chanW.get(r.user_id) || 0) + w);
    }
  }
  const top = (map, n) => new Map([...map.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, n));

  // Hard exclusions are complete (no LIMIT caps — they must hold even when
  // the signal that produced them fell outside the profile windows above),
  // but still time-bounded so opts.asOf replays can't see future events.
  const excluded = new Set();
  for (const r of stmts.completed.all(userId, now)) excluded.add(r.video_id);
  for (const r of stmts.disliked.all(userId, now)) excluded.add(r.video_id);
  for (const r of stmts.notInterested.all(userId, now)) excluded.add(r.video_id);
  for (const r of stmts.ownUploads.all(userId)) excluded.add(r.id);

  return {
    now,
    tagW: top(tagW, PROFILE_TOP_TAGS),
    catW: top(catW, PROFILE_TOP_CATS),
    chanW,
    subs: new Set(stmts.subs.all(userId).map(r => r.channel_id)),
    excluded,
    inProgress: new Set(stmts.inProgress.all(userId, now).map(r => r.video_id)),
    impressions: new Map(stmts.homeImpressions.all(userId).map(r => [r.video_id, r.count])),
    recentStrong: stmts.recentStrong.all(userId, now, userId, now).map(r => r.video_id),
  };
}

// Neighbor lookup, swappable for the eval harness's in-memory map.
function neighborsOf(videoId, limit, similarity) {
  if (similarity) {
    return [...(similarity.get(videoId) || [])]
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return stmts.neighbors.all(videoId, limit);
}

// ---------- personalized home feed ----------

function personalizedHome(me, cursor, limit, opts = {}) {
  const o = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
  // The seed is minted on page 1 and carried in the cursor so the whole
  // scroll session sees one deterministic ranking.
  const s = cursor && Number.isInteger(cursor.s)
    ? cursor.s : Math.floor(Math.random() * 2 ** 31);
  const profile = buildProfile(me.id, { asOf: opts.asOf });
  const now = profile.now;
  const maxCreated = opts.asOf || FAR_FUTURE;

  // Candidate generation: union-deduped by id, bounded by per-source limits.
  const pool = new Map();       // id -> row
  const explorable = new Set(); // trending/newest ids, for exploration slots
  const addAll = rows => { for (const r of rows) if (!pool.has(r.id)) pool.set(r.id, r); };

  addAll(stmts.candSubs.all(maxCreated, me.id));

  const topTags = [...profile.tagW.entries()].filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, TAG_CAND_TAGS);
  for (const [tagId] of topTags) {
    addAll(stmts.candTagRecent.all(maxCreated, tagId));
    addAll(stmts.candTagPopular.all(maxCreated, tagId));
  }

  const topCats = [...profile.catW.entries()].filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, CAT_CAND_CATS);
  for (const [cat] of topCats) addAll(stmts.candCategory.all(maxCreated, cat));

  // CF: neighbors of the viewer's recent strong engagements, scores summed
  // across seeds so multiply-reachable videos rank higher.
  const cfScore = new Map();
  for (const seed of profile.recentStrong) {
    for (const n of neighborsOf(seed, CF_NEIGHBORS_PER_SEED, opts.similarity)) {
      cfScore.set(n.other_id, (cfScore.get(n.other_id) || 0) + n.score);
    }
  }
  const missingCf = [...cfScore.keys()].filter(id => !pool.has(id));
  if (missingCf.length) {
    addAll(batchRows(`${VIDEO_SELECT} WHERE v.hidden = 0 AND v.is_short = 0
      AND v.created_at <= ? AND v.id IN (/*ids*/)`, missingCf, [maxCreated]));
  }

  // Trending + newest are ALWAYS included: exploration for warm users, the
  // whole feed for cold-start ones. Scoring mirrors GET /api/trending.
  const trendRows = stmts.candTrending.all(now - TRENDING_WINDOW_DAYS * 86400, maxCreated);
  for (const r of trendRows) {
    const ageHours = (now - r.created_at) / 3600;
    r._trend = (r.views + 3 * r.like_count + 2 * r.comment_count) / Math.pow(ageHours + 2, 1.5);
  }
  trendRows.sort((a, b) => b._trend - a._trend || b.created_at - a.created_at);
  const trendTop = trendRows.slice(0, TRENDING_CANDS);
  for (const r of trendTop) explorable.add(r.id);
  addAll(trendTop);
  const newest = stmts.candNewest.all(maxCreated);
  for (const r of newest) explorable.add(r.id);
  addAll(newest);

  // Own uploads, completed, disliked and not-interested never reach home.
  for (const id of profile.excluded) pool.delete(id);

  const cands = [...pool.values()];
  if (!cands.length) return { videos: [], nextCursor: null };

  // Scoring (candidate tag ids batch-fetched in one query).
  const tagsByVideo = new Map();
  for (const r of batchRows('SELECT video_id, tag_id FROM video_tags WHERE video_id IN (/*ids*/)',
      cands.map(c => c.id))) {
    let list = tagsByVideo.get(r.video_id);
    if (!list) tagsByVideo.set(r.video_id, list = []);
    list.push(r.tag_id);
  }
  const maxViews = Math.max(1, ...cands.map(c => c.views));
  const scored = cands.map(r => {
    let tagAff = 0;
    for (const t of tagsByVideo.get(r.id) || []) tagAff += profile.tagW.get(t) || 0;
    const catAff = profile.catW.get(r.category) || 0;
    const chanAff = profile.chanW.get(r.channel_id) || 0;
    const cfAff = cfScore.get(r.id) || 0;
    const fresh = 1 / ((now - r.created_at) / 86400 / 7 + 1);
    const popNorm = r.views / maxViews;
    let score = W_SUB * (profile.subs.has(r.channel_id) ? 1 : 0)
      + W_TAG * squash(tagAff) + W_CF * squash(cfAff) + W_CHAN * squash(chanAff)
      + W_CAT * squash(catAff) + W_FRESH * fresh + W_POP * popNorm;
    score *= Math.pow(IMPRESSION_DECAY,
      Math.max(0, (profile.impressions.get(r.id) || 0) - IMPRESSION_FREE));
    if (profile.inProgress.has(r.id)) score *= IN_PROGRESS_MULT;
    const explore = explorable.has(r.id)
      && Math.abs(squash(tagAff) + squash(cfAff)) < EXPLORE_MAX_AFF;
    return { row: r, score, explore };
  });
  scored.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at
    || (a.row.id < b.row.id ? 1 : -1));

  // Greedy diversity re-rank of the ENTIRE pool (deterministic given the
  // seed), then slice — pagination stays stable within a scroll session.
  const rand = mulberry32(s);
  const picked = new Array(scored.length).fill(false);
  const final = [];
  let chanCount = new Map();
  const last = () => final[final.length - 1];
  const chanOk = c => (chanCount.get(c.row.channel_id) || 0) < CHANNEL_BLOCK_CAP
    && (!final.length || last().row.channel_id !== c.row.channel_id);
  const adjOk = c => !final.length || last().row.channel_id !== c.row.channel_id;
  const take = i => {
    picked[i] = true;
    chanCount.set(scored[i].row.channel_id, (chanCount.get(scored[i].row.channel_id) || 0) + 1);
    final.push(scored[i]);
  };

  while (final.length < scored.length) {
    const blockPos = final.length % PAGE_BLOCK;
    if (blockPos === 0) chanCount = new Map(); // channel cap is per block

    // Exploration slots: a seeded-random near-zero-affinity trending/newest
    // pick; falls through to normal selection when none qualify.
    if (EXPLORE_OFFSETS.has(blockPos)) {
      const eligible = [];
      for (let i = 0; i < scored.length; i++) {
        if (!picked[i] && scored[i].explore && chanOk(scored[i])) eligible.push(i);
      }
      if (eligible.length) {
        take(eligible[Math.floor(rand() * eligible.length)]);
        continue;
      }
    }

    // Best remaining that fits the channel constraints, progressively relaxed
    // so every pool video eventually gets placed (the list is a permutation).
    let best = -1;
    for (let i = 0; i < scored.length && best < 0; i++) {
      if (!picked[i] && chanOk(scored[i])) best = i;
    }
    for (let i = 0; i < scored.length && best < 0; i++) {
      if (!picked[i] && adjOk(scored[i])) best = i;
    }
    for (let i = 0; i < scored.length && best < 0; i++) {
      if (!picked[i]) best = i;
    }

    // Category adjacency damping: avoid a third same-category pick in a row
    // when a near-equal (within 20%) different-category candidate exists.
    const cand = scored[best];
    const cat = cand.row.category;
    if (cat != null && cand.score > 0 && final.length >= 2
        && last().row.category === cat && final[final.length - 2].row.category === cat) {
      for (let i = 0; i < scored.length; i++) {
        if (picked[i] || i === best) continue;
        if (scored[i].score < cand.score * CAT_DAMP_RATIO) break; // sorted desc
        if (scored[i].row.category !== cat && chanOk(scored[i])) { best = i; break; }
      }
    }
    take(best);
  }

  const page = final.slice(o, o + limit).map(c => publicVideo(c.row));
  return {
    videos: page,
    nextCursor: o + limit < final.length ? encodeCursor({ o: o + limit, s }) : null,
  };
}

// ---------- related videos ----------

// me may be null (e.g. internal callers); exclusions then skip viewer state.
function relatedVideos(videoId, me) {
  const source = stmts.videoChannel.get(videoId);
  const excluded = new Set([videoId]);
  if (me) {
    // No replay concept here — the related rail always uses the full history.
    for (const r of stmts.disliked.all(me.id, FAR_FUTURE)) excluded.add(r.video_id);
    for (const r of stmts.notInterested.all(me.id, FAR_FUTURE)) excluded.add(r.video_id);
  }

  const merged = new Map(); // id -> { row, score }
  const add = (id, row, points) => {
    let e = merged.get(id);
    if (!e) merged.set(id, e = { row: null, score: 0 });
    if (row && !e.row) e.row = row;
    e.score += points;
  };
  for (const r of stmts.relatedByTags.all(videoId)) {
    if (!excluded.has(r.id)) add(r.id, r, REL_TAG_W * (Math.min(r.shared, SIM_TAG_CAP) / SIM_TAG_CAP));
  }
  for (const n of stmts.relatedNeighbors.all(videoId)) {
    if (!excluded.has(n.other_id)) add(n.other_id, null, REL_CF_W * n.score);
  }
  // Rows for CF-only ids; the fetch re-applies the hidden/shorts filter.
  const missing = [...merged.entries()].filter(([, e]) => !e.row).map(([id]) => id);
  if (missing.length) {
    for (const r of batchRows(
        `${VIDEO_SELECT} WHERE v.hidden = 0 AND v.is_short = 0 AND v.id IN (/*ids*/)`, missing)) {
      merged.get(r.id).row = r;
    }
  }
  if (source) {
    for (const e of merged.values()) {
      if (e.row && e.row.channel_id === source.user_id) e.score += REL_CHAN_W;
    }
  }

  const out = [...merged.values()].filter(e => e.row)
    .sort((a, b) => b.score - a.score || b.row.views - a.row.views
      || b.row.created_at - a.row.created_at || (a.row.id < b.row.id ? 1 : -1))
    .slice(0, RELATED_LIMIT).map(e => e.row);

  // Top up with the popularity filler, same as the old server.js behavior.
  if (out.length < RELATED_LIMIT) {
    const have = new Set(out.map(v => v.id));
    for (const f of stmts.relatedFiller.all(videoId)) {
      if (out.length >= RELATED_LIMIT) break;
      if (!have.has(f.id) && !excluded.has(f.id)) { have.add(f.id); out.push(f); }
    }
  }
  return out.map(publicVideo);
}

// ---------- impressions / not interested ----------

function recordImpressions(userId, surface, videoIds) {
  if (surface !== 'home' && surface !== 'related') {
    throw new Error(`Unknown impression surface: ${surface}`);
  }
  const ids = [...new Set((videoIds || []).map(String))].slice(0, IMPRESSION_BATCH_CAP);
  if (!ids.length) return 0;
  return recordImpressionsTxn(userId, surface, ids);
}

function setNotInterested(userId, videoId) {
  if (!stmts.videoVisible.get(videoId)) return false;
  stmts.addNotInterested.run(userId, videoId);
  return true;
}

function clearNotInterested(userId, videoId) {
  stmts.removeNotInterested.run(userId, videoId);
}

module.exports = {
  personalizedHome,
  relatedVideos,
  recordImpressions,
  setNotInterested,
  clearNotInterested,
  rebuildSimilarity,
  startSimilarityJob,
  computeSimilarity,
  buildProfile,
};
