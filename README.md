# ⚓ Anchor

A self-hosted video sharing site in the spirit of YouTube. Upload videos, watch
them with a seekable player, and build channels with subscriptions, likes and
comments — all backed by a single Node.js server and a SQLite database.

## Features

- **Accounts** — register/sign in (scrypt-hashed passwords, cookie sessions)
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
- **UI** — responsive layout with a mobile drawer, a persisted light/dark theme
  toggle, loading skeletons, toast notifications, and keyboard/focus accessibility
- **Channels** — per-user channel pages with stats, plus subscribe/unsubscribe

## Getting started

```bash
npm install
npm start
```

Then open http://localhost:3000, create an account, and upload your first video.

Uploaded media and the SQLite database live in `data/` (gitignored). Set `PORT`
to change the listening port.

To enable the transcoding pipeline, install ffmpeg (e.g. `apt-get install ffmpeg`)
and restart the server — it detects ffmpeg at startup and logs whether
transcoding is active. Videos interrupted mid-transcode are picked up again on
the next start, and the original upload is always playable while (and even if)
transcoding runs.

## Stack

- [Express 5](https://expressjs.com/) HTTP server, plain HTML/CSS/JS frontend (no build step)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for storage
- [multer](https://github.com/expressjs/multer) for multipart uploads
