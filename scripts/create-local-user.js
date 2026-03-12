/**
 * Create / manage local users for the Identity Fabric web application.
 *
 * Local users are stored in the MongoDB "_localUsers" collection with bcrypt-hashed
 * passwords.  These accounts are independent of LDAP and Entra ID.
 *
 * Usage (interactive):
 *   node scripts/create-local-user.js
 *
 * Usage (non-interactive):
 *   node scripts/create-local-user.js --username admin --password "S3cur3!Pass" --role admin
 *   node scripts/create-local-user.js --username admin --delete
 *   node scripts/create-local-user.js --list
 */

const { MongoClient } = require('mongodb');
const bcryptjs = require('bcryptjs');
const readline = require('readline');
const path = require('path');

// Load env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB  = process.env.MONGO_DB  || 'IdentityFabric';
const COLLECTION = '_localUsers';
const BCRYPT_ROUNDS = 12;

// ── Helpers ────────────────────────────────────────────────────────────────────

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Mask password input
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      let password = '';
      const onData = (ch) => {
        const c = ch.toString('utf8');
        if (c === '\n' || c === '\r' || c === '\u0004') {
          stdin.setRawMode?.(wasRaw);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          rl.close();
          resolve(password);
        } else if (c === '\u0003') {
          process.exit();
        } else if (c === '\u007F' || c === '\b') {
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          password += c;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

function validatePassword(password) {
  const issues = [];
  if (password.length < 12)                       issues.push('at least 12 characters');
  if (!/[A-Z]/.test(password))                    issues.push('an uppercase letter');
  if (!/[a-z]/.test(password))                    issues.push('a lowercase letter');
  if (!/[0-9]/.test(password))                    issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(password))             issues.push('a special character (!@#$%^&*...)');
  return issues;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true;
      flags[key] = val;
    }
  }

  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(MONGO_DB);
    const coll = db.collection(COLLECTION);

    // Ensure unique index on username
    await coll.createIndex({ username: 1 }, { unique: true });

    // ── List users ──
    if (flags.list) {
      const users = await coll.find({}, {
        projection: { username: 1, displayName: 1, roles: 1, enabled: 1, createdAt: 1, lastLogin: 1 }
      }).toArray();

      if (users.length === 0) {
        console.log('\n  No local users exist yet.\n');
      } else {
        console.log('\n  Local Users:');
        console.log('  ' + '─'.repeat(80));
        for (const u of users) {
          const status = u.enabled === false ? '(DISABLED)' : '';
          const lastLogin = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never';
          console.log(`  ${u.username.padEnd(20)} ${(u.displayName || '').padEnd(25)} roles: [${u.roles?.join(', ')}] last login: ${lastLogin} ${status}`);
        }
        console.log('');
      }
      return;
    }

    // ── Delete user ──
    if (flags.delete && flags.username) {
      const result = await coll.deleteOne({ username: flags.username.toLowerCase() });
      if (result.deletedCount > 0) {
        console.log(`\n  ✓ User "${flags.username}" deleted.\n`);
      } else {
        console.log(`\n  ✗ User "${flags.username}" not found.\n`);
      }
      return;
    }

    // ── Create / update user ──
    let username = flags.username;
    let password = flags.password;
    let displayName = flags.displayname || flags.name;
    let role = flags.role || 'admin';

    // Interactive mode if args missing
    if (!username) {
      console.log('\n  ╔══════════════════════════════════════════════╗');
      console.log('  ║   Identity Fabric — Create Local User       ║');
      console.log('  ╚══════════════════════════════════════════════╝\n');

      username = await ask('  Username: ');
      if (!username) { console.log('  Cancelled.'); return; }

      displayName = await ask('  Display Name: ');
    }

    if (!password) {
      while (true) {
        password = await ask('  Password: ', true);
        const issues = validatePassword(password);
        if (issues.length > 0) {
          console.log(`\n  ⚠ Password must contain: ${issues.join(', ')}`);
          console.log('  Please try again.\n');
          continue;
        }
        const confirm = await ask('  Confirm Password: ', true);
        if (password !== confirm) {
          console.log('\n  ⚠ Passwords do not match. Please try again.\n');
          continue;
        }
        break;
      }
    } else {
      const issues = validatePassword(password);
      if (issues.length > 0) {
        console.error(`\n  ✗ Password must contain: ${issues.join(', ')}\n`);
        process.exit(1);
      }
    }

    if (!['admin', 'viewer'].includes(role)) {
      console.error(`\n  ✗ Invalid role "${role}". Must be "admin" or "viewer".\n`);
      process.exit(1);
    }

    username = username.toLowerCase();
    const hash = await bcryptjs.hash(password, BCRYPT_ROUNDS);

    const doc = {
      username,
      passwordHash: hash,
      displayName: displayName || username,
      roles: [role],
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLogin: null,
      failedAttempts: 0,
      lockedUntil: null,
    };

    const existing = await coll.findOne({ username });
    if (existing) {
      await coll.updateOne({ username }, {
        $set: {
          passwordHash: hash,
          displayName: doc.displayName,
          roles: doc.roles,
          enabled: true,
          updatedAt: doc.updatedAt,
          failedAttempts: 0,
          lockedUntil: null,
        }
      });
      console.log(`\n  ✓ User "${username}" updated (password reset, role: ${role}).\n`);
    } else {
      await coll.insertOne(doc);
      console.log(`\n  ✓ User "${username}" created (role: ${role}).\n`);
    }

    console.log('  You can now log in at the Identity Fabric web application');
    console.log('  using the "Local Account" option on the login page.\n');

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\n  ✗ Error: ${err.message}\n`);
  process.exit(1);
});
