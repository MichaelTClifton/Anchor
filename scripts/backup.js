// Cold-safe snapshot of the DB + uploaded media into a timestamped folder
// under backups/. Run manually (`npm run backup`) or from cron; nothing else
// in the app depends on this file.
//
// Example cron entry (daily at 3am, keeping the last 14 backups):
//   0 3 * * * cd /path/to/Anchor && npm run backup && \
//     ls -1dt backups/*/ | tail -n +15 | xargs -r rm -rf

const path = require('path');
const fs = require('fs');
const { db, DATA_DIR, UPLOADS_DIR, THUMBS_DIR } = require('../db');

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  // db.backup() is an online hot backup (safe to run against a live,
  // WAL-mode database — no need to stop the server first).
  await db.backup(path.join(outDir, 'anchor.db'));

  for (const [name, dir] of [['uploads', UPLOADS_DIR], ['thumbnails', THUMBS_DIR]]) {
    if (fs.existsSync(dir)) fs.cpSync(dir, path.join(outDir, name), { recursive: true });
  }
  const outboxDir = path.join(DATA_DIR, 'outbox');
  if (fs.existsSync(outboxDir)) fs.cpSync(outboxDir, path.join(outDir, 'outbox'), { recursive: true });

  console.log(`Backup written to ${outDir}`);
  db.close();
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
