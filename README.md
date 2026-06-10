# ⚓ Anchor

A self-hosted video sharing site in the spirit of YouTube. Upload videos, watch
them with a seekable player, and build channels with subscriptions, likes and
comments — all backed by a single Node.js server and a SQLite database.

## Features

- **Accounts** — register/sign in (scrypt-hashed passwords, cookie sessions)
- **Uploads** — drag-and-drop MP4/WebM/OGG/MOV up to 1 GB, with a live progress bar
- **Thumbnails** — auto-captured in the browser from the video itself (no ffmpeg required)
- **Transcoding** — when ffmpeg is installed, uploads are encoded in the background
  into 1080p/720p/480p/360p H.264 renditions (never upscaled), with a quality
  selector on the watch page; without ffmpeg, videos simply play in their original format
- **Playback** — HTML5 player with seeking (HTTP Range requests) and view counts
- **Engagement** — likes/dislikes, threaded comment section, delete-your-own moderation
- **Channels** — per-user channel pages with stats, plus subscribe/unsubscribe
- **Search** — full search across titles, descriptions and channel names
- **Home feed** — responsive grid of the latest uploads with durations and view counts

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
