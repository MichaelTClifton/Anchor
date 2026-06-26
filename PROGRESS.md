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
- [ ] **Phase 3 — History + feeds.** Watch history/resume, Watch Later,
  personalized home + continue-watching, Trending/History/Liked/Subscriptions
  feed pages.
- [ ] **Phase 4 — Player polish.** Keyboard shortcuts, speed menu, PiP, theater
  mode, autoplay-next.

## Resume notes for the next session
- App: Node/Express + better-sqlite3, vanilla frontend in `public/`, no build.
- Run: `npm start` (ffmpeg present). Test users alice/bob password `secret123`.
- Screenshot harness: import playwright from
  `/opt/node22/lib/node_modules/playwright/index.js` (default export), launch
  chromium headless. Do NOT use `pkill -f "node server.js"` inside a Bash tool
  call — it terminates the call; start the server in its own call.
- Each phase: implement, test with curl + a playwright screenshot, commit+push,
  tick the box above.
