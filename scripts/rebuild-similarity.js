// One-shot rebuild of the video_similarity table (plus the stale-impression
// prune that rides along with every build). The running server rebuilds
// hourly on its own via startSimilarityJob(); run this manually
// (`node scripts/rebuild-similarity.js`) after seeding or restoring data.

const { db } = require('../db');
const { rebuildSimilarity } = require('../recommend');

try {
  const stats = rebuildSimilarity();
  console.log(`Similarity rebuilt: ${stats.pairs} neighbor pairs across ${stats.videos} videos.`);
  db.close();
  process.exit(0);
} catch (err) {
  console.error('Similarity rebuild failed:', err);
  process.exit(1);
}
