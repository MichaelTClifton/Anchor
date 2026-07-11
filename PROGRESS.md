# Anchor build progress

Feature expansion plan (full detail in the approved plan). Phases committed
incrementally to `claude/video-hosting-site-32royz`.

- [x] **Phase 0 — Schema + plumbing.** New tables (watch_history, watch_later,
  tags, video_tags), FTS5 index + delete trigger + `reindexVideo()` backfill,
  `category` column. (commit: schema + FTS)
- [x] **Phase 1 — Tags + FTS search.** BM25 search, autocomplete, categories,
  tags/category on upload, PATCH edit, tag-based related videos, /browse page.
- [x] **Phase 2 — UI foundation.** Infinite scroll via `mountFeed()` on
  home/search/browse/channel; left sidebar nav + mobile drawer; light/dark theme
  toggle (persisted); toast + skeleton helpers; focus-visible + ARIA.
- [x] **Phase 3 — History + feeds.** Watch history + resume + progress
  reporting (sendBeacon), Watch Later toggle/list, personalized home +
  continue-watching shelf, time-decayed Trending, and the History/Liked/
  Watch Later/Subscriptions feed pages with resume bars + remove buttons.
- [x] **Phase 4 — Player polish.** Keyboard shortcuts (space/k, j/l, arrows,
  m, f, 0-9, </> speed), speed menu, picture-in-picture (feature-detected),
  persisted theater mode, and autoplay-next from the related queue.

- [x] **Phase 5 — Shorts.** `is_short` column (auto-detected at upload from
  duration ≤ 60s + portrait/square, server-validated, ffprobe-corrected);
  `/api/shorts` time-decayed engagement feed + `POST /api/videos/:id/view`;
  shorts excluded from long-form discovery grids but kept in search/channel/
  library lists with a badge; `/shorts[/:id]` vertical snap-scroll player
  (autoplay-in-view, loop, like/mute/share rail, keyboard nav, infinite feed,
  URL sync); Shorts shelf on home + sidebar link.

- [x] **Phase 6 — Auth hardening + splash gate.** Splash landing page for
  signed-out visitors (all pages/API/media gated behind a session); signup
  requires email + confirmed 8-char password with a post-signup
  "secure your account" step; passkeys (hand-rolled WebAuthn: CBOR/COSE parse,
  node:crypto verify); TOTP 2FA with two-step login; password recovery via
  dev-outbox email + /reset page (single-use 1h tokens, sessions revoked);
  /settings page (email, password, 2FA, passkeys); dropzone display:block fix.

- [x] **Phase 7 — Neon restyle.** Flat SVG icon system (ICONS/icon()/data-icon
  in common.js) replacing every emoji; style.css rewritten as a hard-edged
  cyberpunk theme: Helvetica Neue, zero border-radius, uppercase display text,
  cyan (#00e5ff) + magenta (#ff2975) neon glow, square avatars, neon favicon;
  light theme kept with subtler ink-on-paper values.

- [x] **Phase 8 — Tier 0 hardening** (see the CDN/roadmap plan for the full
  reprioritized list; Tiers 1+ are future work). Rate limiting
  (`express-rate-limit`) on login/register/recover/reset/2FA-login/passkey
  login/comments/uploads; security headers + a CSP tuned for this app's
  inline scripts/onclick handlers, plus gzip compression (`helmet`,
  `compression`); `trust proxy` so the app is reverse-proxy-ready (fixes
  WebAuthn's rpId/origin derivation and lets the session cookie set `Secure`
  once actually served over HTTPS); video owners can now delete comments on
  their own videos, not just their own comments; `npm run backup` (hot
  `db.backup()` + media copy into `backups/<timestamp>/`); bumped multer to
  patch a DoS advisory (GHSA-72gw-mp4g-v24j).

- [x] **Phase 9 — Trust & safety (Tier 1).** reports table (partial unique
  index for open-report dedup) + videos.hidden + users.role/suspended;
  FTS deindex-on-hide via `AND v.hidden = 0` in reindexStmt (hide/restore =
  reindexVideo); report buttons on watch/shorts/comments with a reason modal;
  /admin review queue (dismiss / remove / suspend, group-resolves per target);
  suspension enforced in getUser (sessions die instantly) + 403 on all three
  login paths; hidden filter across every feed/search/interaction endpoint;
  /guidelines page + required terms checkbox at signup;
  `npm run make-admin -- <user>`; limiter tuning (skipSuccessfulRequests on
  auth, split comment/upload/report limiters).

- [x] **Phase 10 — Live streaming + VOD + chat.** node-media-server@2.7.4
  (exact pin; process-global handler strip after run()); per-user stream keys
  (/studio: mask/copy/regenerate/title); relay ffmpeg `-c copy` → rolling HLS
  (session-gated /live-hls) + MPEG-TS recording (crash-tolerant); finalize →
  remux → videos row → reindexVideo + transcode.enqueue → normal VOD; boot
  salvage of interrupted streams (verified via SIGKILL); SSE chat with ring
  buffer + presence counts (no-transform bypasses gzip); /live grid +
  /live/:id (vendored hls.light.min.js, CSP mediaSrc/workerSrc blob:) +
  home shelf + sidebar; prePlay loopback guard; admin stop-stream; suspend
  cuts broadcasts; chatLimiter 20/min.

- [x] **Phase 11 — Preference-based recommendations.** recommend.js: two-stage
  recommender (candidates from subscriptions / tag + category affinity /
  item-item co-engagement CF / trending+fresh → weighted scoring against a
  14-day-half-life profile of watches/likes/dislikes/saves → greedy diversity
  re-rank with channel caps + seeded exploration slots at 6/13/20); hourly
  in-process similarity rebuild (cosine over strong co-engagements + tag/
  category boost, top-20 neighbors, watermark-skipped) that also prunes 30-day
  impressions; related rail = CF + shared tags + same-channel; impressions
  (IntersectionObserver batches → /api/impressions, sendBeacon on exit) demote
  repeatedly-seen videos; "Not interested" card control + endpoints; schema:
  impressions/not_interested/video_similarity tables + likes.created_at;
  `npm run rebuild-similarity` / `seed-recs` (4 planted taste clusters) /
  `eval-recs` (leave-last-out harness gating recall/coverage/diversity/
  exclusions vs the old naive ranker).

**All phases complete.** ✅

## Resume notes for the next session
- App: Node/Express + better-sqlite3, vanilla frontend in `public/`, no build.
- Run: `npm start` (ffmpeg present). Test users alice/bob password `secret123`.
- Screenshot harness: import playwright from
  `/opt/node22/lib/node_modules/playwright/index.js` (default export), launch
  chromium headless. Do NOT use `pkill -f "node server.js"` inside a Bash tool
  call — it terminates the call; start the server in its own call.
- Each phase: implement, test with curl + a playwright screenshot, commit+push,
  tick the box above.
