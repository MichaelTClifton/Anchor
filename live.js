// Live streaming: RTMP ingest (OBS + per-user stream key) -> HLS for viewers
// -> automatic VOD archive when the stream ends. Also owns the ephemeral
// per-stream chat hub (SSE). Mirrors transcode.js's degradation philosophy:
// without ffmpeg the feature is simply disabled and the rest of the app is
// unaffected.

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR, LIVE_DIR, reindexVideo } = require('./db');
const transcode = require('./transcode');

const RTMP_PORT = parseInt(process.env.RTMP_PORT, 10) || 1935;
const MIN_VOD_SECONDS = 5;

const enabled = transcode.available;

// streamId -> { key, userId, nmsSessionId, proc, dir, done }
const active = new Map();
const byKey = new Map(); // stream key -> streamId
const bySession = new Map(); // NMS session id -> streamId

// streamId -> { clients:Set<res>, ring:[{...}] } — ephemeral chat + presence.
const chatRooms = new Map();

let nms = null;

function probeDuration(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
    ], { encoding: 'utf8' });
    return parseFloat(JSON.parse(out).format?.duration) || 0;
  } catch (e) {
    return 0;
  }
}

// ---------- chat hub ----------

function room(streamId, create = false) {
  let r = chatRooms.get(streamId);
  if (!r && create) {
    r = { clients: new Set(), ring: [] };
    chatRooms.set(streamId, r);
  }
  return r;
}

function sseWrite(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { /* dead socket */ }
}

function broadcast(streamId, data) {
  const r = room(streamId);
  if (!r) return;
  for (const client of r.clients) sseWrite(client, data);
}

function viewerCount(streamId) {
  return room(streamId) ? room(streamId).clients.size : 0;
}

function chatSubscribe(streamId, req, res) {
  const r = room(streamId, true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform makes the compression middleware skip this response, so
    // events flush immediately instead of buffering inside gzip.
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  for (const msg of r.ring) sseWrite(res, msg);
  r.clients.add(res);
  broadcast(streamId, { type: 'viewers', n: r.clients.size });
  req.on('close', () => {
    r.clients.delete(res);
    broadcast(streamId, { type: 'viewers', n: r.clients.size });
  });
}

function chatSend(streamId, user, text) {
  const msg = { type: 'chat', user_id: user.id, username: user.username, text, ts: Math.floor(Date.now() / 1000) };
  const r = room(streamId, true);
  r.ring.push(msg);
  if (r.ring.length > 50) r.ring.shift();
  broadcast(streamId, msg);
}

function closeRoom(streamId, vodId) {
  const r = room(streamId);
  if (!r) return;
  broadcast(streamId, { type: 'ended', vod_id: vodId || null });
  for (const client of r.clients) { try { client.end(); } catch (e) { /* already gone */ } }
  chatRooms.delete(streamId);
}

// Proxies buffering SSE (and browsers timing out idle connections) are kept
// alive with a periodic comment + refreshed viewer count.
setInterval(() => {
  for (const [streamId, r] of chatRooms) {
    for (const client of r.clients) {
      try { client.write(': ping\n\n'); } catch (e) { /* dead */ }
    }
    broadcast(streamId, { type: 'viewers', n: r.clients.size });
  }
}, 25000).unref();

// ---------- stream lifecycle ----------

// The relay is the only RTMP consumer: it turns the publisher's feed into
// (a) a rolling HLS window for live viewers and (b) a full MPEG-TS recording.
// TS (not MP4) so a crash mid-stream leaves a salvageable file — MP4 only
// writes its moov atom on clean exit.
function spawnRelay(streamId, key, dir) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', `rtmp://127.0.0.1:${RTMP_PORT}/live/${key}`, // key visible in ps args; acceptable on a single-admin host
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'hls',
    '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'),
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts',
    path.join(dir, 'recording.ts'),
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

// Archive a finished (or salvaged) recording as a normal Anchor video and
// hand it to the existing transcode pipeline for thumbnail/renditions.
function archiveRecording(streamRow, recordingPath) {
  const duration = probeDuration(recordingPath);
  if (duration < MIN_VOD_SECONDS) return null;
  const filename = `${crypto.randomBytes(8).toString('hex')}.mp4`;
  try {
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', recordingPath,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart',
      path.join(UPLOADS_DIR, filename),
    ], { stdio: 'ignore' });
  } catch (e) {
    console.error(`Live: VOD remux failed for stream ${streamRow.id}: ${e.message}`);
    return null;
  }
  const videoId = crypto.randomBytes(6).toString('base64url');
  const title = streamRow.title
    || `Live stream — ${new Date(streamRow.started_at * 1000).toISOString().slice(0, 10)}`;
  db.prepare(`INSERT INTO videos (id, user_id, title, description, filename, duration, status, is_short)
    VALUES (?, ?, ?, '', ?, ?, 'processing', 0)`)
    .run(videoId, streamRow.user_id, title, filename, duration);
  reindexVideo(videoId); // VODs carry no tags, so index here or search never sees them
  db.prepare('UPDATE streams SET vod_video_id = ? WHERE id = ?').run(videoId, streamRow.id);
  transcode.enqueue(videoId);
  return videoId;
}

// Single teardown path (idempotent): mark ended, archive, notify chat, clean.
function finalize(streamId) {
  const entry = active.get(streamId);
  if (entry) {
    if (entry.done) return;
    entry.done = true;
  }
  db.prepare('UPDATE streams SET live = 0, ended_at = COALESCE(ended_at, unixepoch()) WHERE id = ?')
    .run(streamId);
  const streamRow = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  const dir = path.join(LIVE_DIR, streamId);
  const recording = path.join(dir, 'recording.ts');
  let vodId = null;
  if (streamRow && fs.existsSync(recording)) {
    vodId = archiveRecording(streamRow, recording);
  }
  closeRoom(streamId, vodId);
  fs.rmSync(dir, { recursive: true, force: true });
  if (entry) {
    byKey.delete(entry.key);
    bySession.delete(entry.nmsSessionId);
    active.delete(streamId);
  }
  console.log(`Live: stream ${streamId} ended${vodId ? `, archived as video ${vodId}` : ' (no VOD)'}`);
}

function stopStream(streamId) {
  const entry = active.get(streamId);
  if (!entry || !nms) return false;
  const session = nms.getSession(entry.nmsSessionId);
  if (session) session.reject(); // publisher socket destroyed -> relay EOFs -> finalize
  else if (entry.proc && !entry.proc.killed) entry.proc.kill('SIGKILL');
  return true;
}

function stopStreamsForUser(userId) {
  for (const [streamId, entry] of active) {
    if (entry.userId === userId) stopStream(streamId);
  }
}

function listActiveIds() {
  return [...active.keys()];
}

// ---------- startup ----------

function init() {
  if (!enabled) return;

  // Crash recovery BEFORE accepting new publishes: streams left live by a
  // previous process are over; salvage whatever the TS recording captured.
  for (const row of db.prepare('SELECT * FROM streams WHERE live = 1').all()) {
    db.prepare('UPDATE streams SET live = 0, ended_at = COALESCE(ended_at, unixepoch()) WHERE id = ?')
      .run(row.id);
    const recording = path.join(LIVE_DIR, row.id, 'recording.ts');
    if (fs.existsSync(recording)) {
      const vodId = archiveRecording(row, recording);
      console.log(`Live: salvaged interrupted stream ${row.id}${vodId ? ` as video ${vodId}` : ''}`);
    }
  }
  for (const leftover of fs.readdirSync(LIVE_DIR)) {
    fs.rmSync(path.join(LIVE_DIR, leftover), { recursive: true, force: true });
  }

  const NodeMediaServer = require('node-media-server');
  nms = new NodeMediaServer({
    logType: 2,
    rtmp: {
      port: RTMP_PORT,
      chunk_size: 60000,
      gop_cache: false, // only consumer is the local relay; no late-joiner burst needed
      ping: 30,
      ping_timeout: 60, // publishers that vanish without FIN are torn down within a minute
    },
  });

  nms.on('prePublish', (id, streamPath) => {
    const match = /^\/live\/([a-f0-9]{24})$/.exec(streamPath);
    const user = match
      ? db.prepare('SELECT id, suspended, stream_title FROM users WHERE stream_key = ?').get(match[1])
      : null;
    if (!user || user.suspended) {
      const session = nms.getSession(id);
      if (session) session.reject();
    }
  });

  nms.on('postPublish', (id, streamPath) => {
    const match = /^\/live\/([a-f0-9]{24})$/.exec(streamPath);
    if (!match) return;
    const key = match[1];
    const user = db.prepare('SELECT id, stream_title FROM users WHERE stream_key = ?').get(key);
    if (!user) return;

    const streamId = crypto.randomBytes(6).toString('base64url');
    const dir = path.join(LIVE_DIR, streamId);
    fs.mkdirSync(dir, { recursive: true });
    db.prepare('INSERT INTO streams (id, user_id, title) VALUES (?, ?, ?)')
      .run(streamId, user.id, user.stream_title || '');

    const proc = spawnRelay(streamId, key, dir);
    const entry = { key, userId: user.id, nmsSessionId: id, proc, dir, done: false };
    active.set(streamId, entry);
    byKey.set(key, streamId);
    bySession.set(id, streamId);

    let relayErr = '';
    proc.stderr.on('data', d => { relayErr += d; });
    proc.on('close', code => {
      // Early exit while the publisher is still connected = the relay choked
      // (usually a non-H.264/AAC codec) — record why and drop the publisher.
      if (!entry.done && bySession.has(id)) {
        if (code !== 0) {
          db.prepare('UPDATE streams SET error = ? WHERE id = ?')
            .run(`relay exited (${code}): ${relayErr.slice(0, 300)}`, streamId);
          console.error(`Live: relay failed for stream ${streamId} (exit ${code})`);
        }
        const session = nms.getSession(id);
        if (session) session.reject();
      }
      finalize(streamId);
    });
    console.log(`Live: user ${user.id} started stream ${streamId}`);
  });

  nms.on('donePublish', (id) => {
    const streamId = bySession.get(id);
    if (!streamId) return;
    const entry = active.get(streamId);
    if (!entry) return;
    // The relay sees RTMP EOF and exits on its own (which finalizes); this
    // timer is only a backstop against a wedged ffmpeg.
    setTimeout(() => {
      if (!entry.done && entry.proc && entry.proc.exitCode === null) entry.proc.kill('SIGKILL');
    }, 15000).unref();
  });

  // The relay is the only legitimate RTMP consumer; block remote players so
  // a leaked stream key can't be used to watch around session auth.
  nms.on('prePlay', (id) => {
    const session = nms.getSession(id);
    if (session && !session.isLocal) session.reject();
  });

  // nms.run() installs process-global uncaughtException/SIGINT handlers that
  // would turn app crashes into log-and-continue. Strip exactly what it adds.
  const beforeUncaught = process.listeners('uncaughtException');
  const beforeSigint = process.listeners('SIGINT');
  nms.run();
  for (const l of process.listeners('uncaughtException')) {
    if (!beforeUncaught.includes(l)) process.removeListener('uncaughtException', l);
  }
  for (const l of process.listeners('SIGINT')) {
    if (!beforeSigint.includes(l)) process.removeListener('SIGINT', l);
  }
}

module.exports = {
  enabled, init, RTMP_PORT,
  viewerCount, chatSubscribe, chatSend,
  stopStream, stopStreamsForUser, listActiveIds,
};
