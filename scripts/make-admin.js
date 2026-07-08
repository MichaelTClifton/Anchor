// Promote an existing account to admin (moderation queue at /admin).
// Usage: npm run make-admin -- <username>

const { db } = require('../db');

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run make-admin -- <username>');
  process.exit(1);
}

// username is COLLATE NOCASE, so this matches case-insensitively.
const info = db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username);
if (info.changes === 0) {
  console.error(`No such user: ${username}`);
  process.exit(1);
}
console.log(`${username} is now an admin.`);
db.close();
