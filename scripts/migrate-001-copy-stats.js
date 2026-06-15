#!/usr/bin/env node
// scripts/migrate-001-copy-stats.js
// =============================================================================
// Migration 001 — Add per-wallet copy-trade stats to watched_wallets.
//
// Adds two columns:
//   copy_count  INTEGER NOT NULL DEFAULT 0   (number of times this wallet was copied)
//   last_copy_at INTEGER NOT NULL DEFAULT 0  (ms epoch of last successful copy)
//
// Idempotent: skips columns that already exist (safe to re-run).
// Forward-only: does not drop columns or roll back.
//
// Usage:
//   node scripts/migrate-001-copy-stats.js
//   npm run migrate -- 1   (if you wire a migrate script in package.json)
//
// Backups: stop the bot before running. We do not take a backup automatically
// because the DB is small (<1MB typically) and the change is additive (DEFAULT 0).
// =============================================================================

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'snipetrench.db');

const MIGRATIONS = [
  {
    id: 1,
    name: 'watched_wallets.copy_count + last_copy_at',
    columns: [
      { name: 'copy_count',   sql: 'ALTER TABLE watched_wallets ADD COLUMN copy_count INTEGER NOT NULL DEFAULT 0' },
      { name: 'last_copy_at', sql: 'ALTER TABLE watched_wallets ADD COLUMN last_copy_at INTEGER NOT NULL DEFAULT 0' },
    ],
  },
];

function columnExists(db, table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

function run() {
  const db = new Database(DB_PATH);
  try {
    let applied = 0;
    let skipped = 0;
    for (const m of MIGRATIONS) {
      console.log(`\n[001] ${m.name}`);
      for (const col of m.columns) {
        if (columnExists(db, 'watched_wallets', col.name)) {
          console.log(`  ⏭  ${col.name} already exists — skipping`);
          skipped++;
          continue;
        }
        db.exec(col.sql);
        console.log(`  ✓ added ${col.name}`);
        applied++;
      }
    }
    console.log(`\nDone. applied=${applied} skipped=${skipped}`);
    if (applied > 0) {
      console.log('\nVerify with:');
      console.log("  node -e \"const d=new (require('better-sqlite3'))('data/snipetrench.db',{readonly:true}); console.log(d.prepare('PRAGMA table_info(watched_wallets)').all())\"");
    }
  } catch (err) {
    console.error('\nMigration FAILED:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

run();
