# ⚓ Anchor

A self-hosted video sharing site in the spirit of YouTube. Upload videos, watch
them with a seekable player, and build channels with subscriptions, likes and
comments — all backed by a single Node.js server and a SQLite database.

## Features

- **Members-only** — signed-out visitors see a landing page about the platform;
  all videos, feeds and media require an account
- **Accounts** — register with username + email + confirmed password
  (scrypt-hashed, cookie sessions), passkey (WebAuthn) sign-in, optional TOTP
  two-factor authentication, email-based password recovery, and a settings page
  for managing email, password, passkeys and 2FA
- **Uploads** — drag-and-drop MP4/WebM/OGG/MOV up to 1 GB, with a live progress
  bar, tags, and categories
- **Thumbnails** — auto-captured in the browser from the video itself (no ffmpeg required)
- **Transcoding** — when ffmpeg is installed, uploads are encoded in the background
  into 1080p/720p/480p/360p H.264 renditions (never upscaled), with a quality
  selector on the watch page; without ffmpeg, videos simply play in their original format
- **Shorts** — vertical clips under a minute are auto-detected at upload and get
  their own swipeable full-screen feed (`/shorts`) with snap scrolling,
  autoplay-in-view, looping, like/share actions, and keyboard navigation, plus
  a Shorts shelf on the home page
- **Player** — HTML5 playback with seeking (HTTP Range), a quality + speed menu,
  picture-in-picture, theater mode, autoplay-next, resume-where-you-left-off, and
  keyboard shortcuts (`space`/`k`, `j`/`l`, arrows, `m`, `f`, `0`–`9`, `<`/`>`)
- **Search** — full-text search with SQLite FTS5 (BM25 relevance, prefix matching)
  and search-as-you-type autocomplete
- **Recommendations** — tag-based related videos, a personalized home feed
  (subscriptions + watch-history affinity), and a time-decayed Trending feed
- **Engagement** — likes/dislikes, comments, subscriptions, Watch Later, and a
  watch history with a "continue watching" shelf
- **Navigation** — left sidebar (Home, Trending, Subscriptions, History, Liked,
  Watch Later), category browsing, and infinite scroll across every feed
- **UI** — a hard-edged neon design system (Helvetica Neue, boxy geometry,
  cyan/magenta glow on near-black, flat single-stroke SVG icons) with a
  responsive layout, mobile drawer, persisted light/dark theme toggle, loading
  skeletons, toast notifications, and keyboard/focus accessibility
- **Channels** — per-user channel pages with stats, plus subscribe/unsubscribe
- **Hardening** — rate limiting on login/register/recovery/2FA/comments/uploads,
  security headers + a CSP (helmet), gzip compression, reverse-proxy-aware
  cookies/WebAuthn (`trust proxy`), and video owners can remove comments on
  their own videos
- **Trust & safety** — report buttons on every video (watch page + Shorts) and
  comment; an admin moderation queue at `/admin` (dismiss, remove content,
  suspend accounts); reversible video takedowns that vanish from all feeds and
  search; account suspension that kills sessions instantly; and public
  [Community Guidelines](/guidelines) that new accounts must accept

## Getting started

```bash
npm install
npm start
```

Then open http://localhost:3000, create an account, and upload your first video.

Uploaded media and the SQLite database live in `data/` (gitignored). Set `PORT`
to change the listening port.

Password-reset "emails" are written to `data/outbox/` (and logged) in
development — swap `sendMail()` in `auth.js` for a real SMTP sender in
production. Passkeys require a secure context: they work on `localhost` in
development and need HTTPS when deployed.

To enable the transcoding pipeline, install ffmpeg (e.g. `apt-get install ffmpeg`)
and restart the server — it detects ffmpeg at startup and logs whether
transcoding is active. Videos interrupted mid-transcode are picked up again on
the next start, and the original upload is always playable while (and even if)
transcoding runs.

### Moderation

Promote an account to admin with `npm run make-admin -- <username>`. Admins
get a shield icon in the header with an open-report count, linking to the
review queue at `/admin`. Takedowns are reversible (hidden videos stay
visible to their owner, flagged with a removal notice); suspensions block
sign-in and kill existing sessions immediately.

### Backups

`npm run backup` writes a hot, consistent snapshot of the database and all
uploaded media to `backups/<timestamp>/` (also gitignored). Safe to run while
the server is live. Wire it into cron for unattended backups, e.g. daily at
3am while keeping the last 14:

```
0 3 * * * cd /path/to/Anchor && npm run backup && \
  ls -1dt backups/*/ | tail -n +15 | xargs -r rm -rf
```

### Deploying behind a reverse proxy

The app trusts the first proxy hop (`trust proxy`), so put it behind nginx,
Caddy, or Cloudflare for TLS termination — this is what makes the session
cookie's `Secure` flag and WebAuthn's origin detection work correctly over
real HTTPS. Caddy is the simplest option since it provisions Let's Encrypt
certificates automatically; a minimal `Caddyfile` is just:

```
your.domain.example {
  reverse_proxy localhost:3000
}
```

## Stack

- [Express 5](https://expressjs.com/) HTTP server, plain HTML/CSS/JS frontend (no build step)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for storage
- [multer](https://github.com/expressjs/multer) for multipart uploads
- [helmet](https://github.com/helmetjs/helmet), [compression](https://github.com/expressjs/compression),
  and [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) for hardening
