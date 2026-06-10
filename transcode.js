// Background transcoding pipeline. Activates only when ffmpeg/ffprobe are on
// PATH; without them videos simply stay in their original format, as before.

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { db, UPLOADS_DIR, THUMBS_DIR } = require('./db');

// Target heights, best first. Sources are never upscaled; the original file
// always remains available as its own (top) quality.
const LADDER = [1080, 720, 480, 360];

function detect(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

const available = detect('ffmpeg') && detect('ffprobe');

function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const data = JSON.parse(out);
  const stream = (data.streams && data.streams[0]) || {};
  return {
    width: stream.width || 0,
    height: stream.height || 0,
    duration: parseFloat(data.format && data.format.duration) || null,
  };
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

const queue = [];
let busy = false;

function enqueue(videoId) {
  if (!available) return;
  queue.push(videoId);
  drain();
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await processVideo(id);
    } catch (e) {
      console.error(`Transcode failed for video ${id}: ${e.message}`);
    }
    // The original upload is always playable, so the video ends up ready
    // even if some renditions failed.
    db.prepare("UPDATE videos SET status = 'ready' WHERE id = ?").run(id);
  }
  busy = false;
}

async function processVideo(id) {
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
  if (!video) return;
  const src = path.join(UPLOADS_DIR, video.filename);
  const base = path.parse(video.filename).name;
  const info = probe(src);

  if (info.duration) {
    db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(info.duration, id);
  }

  // Server-side thumbnail, for uploads where the browser couldn't capture one.
  if (!video.thumbnail && info.duration) {
    const thumbName = `${base}.jpg`;
    await ffmpeg([
      '-ss', String(Math.min(info.duration * 0.1, 5)),
      '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4',
      path.join(THUMBS_DIR, thumbName),
    ]);
    db.prepare('UPDATE videos SET thumbnail = ? WHERE id = ?').run(thumbName, id);
  }

  for (const height of LADDER) {
    if (!info.height || height >= info.height) continue;
    if (db.prepare('SELECT 1 FROM renditions WHERE video_id = ? AND height = ?').get(id, height)) continue;
    const outName = `${base}_${height}p.mp4`;
    await ffmpeg([
      '-i', src,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      path.join(UPLOADS_DIR, outName),
    ]);
    // Insert as each finishes so qualities appear progressively on the watch page.
    db.prepare('INSERT INTO renditions (video_id, height, filename) VALUES (?, ?, ?)')
      .run(id, height, outName);
  }
}

// Recover videos left mid-processing by a previous run.
if (available) {
  for (const v of db.prepare("SELECT id FROM videos WHERE status = 'processing'").all()) {
    enqueue(v.id);
  }
} else {
  db.prepare("UPDATE videos SET status = 'ready' WHERE status = 'processing'").run();
}

module.exports = { available, enqueue };
