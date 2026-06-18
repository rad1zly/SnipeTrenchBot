// scripts/test-stats.js
// =============================================================================
// Quick runtime test for the new v0.8.0 win/loss + balance plumbing.
// Seeds a few closed positions (no real SOL), then asserts:
//   - pnl_percent column added (idempotent)
//   - winStats() counts wins/losses correctly
//   - best/worst arrays are sorted
//   - per-user scope is respected
// =============================================================================
import 'dotenv/config';
import { positionsDb, walletsDb, getDb } from '../src/db.js';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

const chatId = 999001;
const otherChat = 999002;
const dev = 'SoMeDeVWaLLeTxxxxxxxxxxxxxxxxxxxxxxx';
const dev2 = 'AnOtHeRdEvWaLLeTxxxxxxxxxxxxxxxxxx';

console.log('--- 1. idempotent column add ---');
// Re-init: this should not throw even if the column already exists.
getDb();
const cols = getDb().prepare(`PRAGMA table_info(positions)`).all().map((c) => c.name);
assert(cols.includes('pnl_percent'), 'pnl_percent column exists');
assert(cols.includes('hold_ms'), 'hold_ms column exists');

console.log('\n--- 2. seed closed positions for user A ---');
walletsDb.add({ chatId, address: dev, label: 'dev1' });
walletsDb.add({ chatId, address: dev2, label: 'dev2' });

// Clear any leftover positions from a prior test run
getDb().prepare(`DELETE FROM positions WHERE dev_wallet IN (?, ?)`).run(dev, dev2);

// 3 wins, 2 losses, 1 breakeven
const seed = [
  { mint: 'Mint1xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev, sol: 0.05, pnl: 0.012, pct: 24.0, hold: 1100 },  // win
  { mint: 'Mint2xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev, sol: 0.04, pnl: 0.008, pct: 20.0, hold: 950 },   // win
  { mint: 'Mint3xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev2, sol: 0.06, pnl: -0.009, pct: -15.0, hold: 1200 }, // loss
  { mint: 'Mint4xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev, sol: 0.05, pnl: 0.005, pct: 10.0, hold: 800 },   // win
  { mint: 'Mint5xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev2, sol: 0.03, pnl: -0.003, pct: -10.0, hold: 1300 }, // loss
  { mint: 'Mint6xxxxxxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev, sol: 0.02, pnl: 0.000, pct: 0.0, hold: 1000 },  // breakeven
];
for (const s of seed) {
  const r = positionsDb.open({ mint: s.mint, devWallet: s.devWallet, entrySig: 'sig', entrySol: s.sol, entryTokens: 1000 });
  const id = r.lastInsertRowid;
  positionsDb.close(id, { exitSig: 'sigx', exitSol: s.sol + s.pnl, pnlSol: s.pnl, pnlPercent: s.pct, holdMs: s.hold });
}

console.log('\n--- 3. winStats for user A (chatId = 999001) ---');
const a = positionsDb.winStats(chatId);
console.log(JSON.stringify(a, null, 2));
assert(a.totalClosed === 6, `totalClosed = 6 (got ${a.totalClosed})`);
assert(a.wins === 3, `wins = 3 (got ${a.wins})`);
assert(a.losses === 2, `losses = 2 (got ${a.losses})`);
assert(a.breakeven === 1, `breakeven = 1 (got ${a.breakeven})`);
assert(a.winRate !== null && Math.abs(a.winRate - 50.0) < 0.001, `winRate ≈ 50% (got ${a.winRate})`);
assert(Math.abs(a.totalPnlSol - 0.013) < 1e-9, `totalPnlSol ≈ +0.013 (got ${a.totalPnlSol})`);
assert(a.best.length > 0 && a.best[0].pnlSol === 0.012, `best[0] is Mint1 with +0.012 (got ${a.best[0]?.pnlSol})`);
assert(a.worst.length > 0 && a.worst[0].pnlSol === -0.009, `worst[0] is Mint3 with -0.009 (got ${a.worst[0]?.pnlSol})`);
assert(a.avgHoldMs !== null && a.avgHoldMs > 1000, `avgHoldMs > 1000 (got ${a.avgHoldMs})`);

console.log('\n--- 4. winStats for user B (chatId = 999002, no wallets) ---');
const b = positionsDb.winStats(otherChat);
assert(b.totalClosed === 0, `user B totalClosed = 0 (got ${b.totalClosed})`);
assert(b.winRate === null, `user B winRate = null (got ${b.winRate})`);

console.log('\n--- 5. winStats global ---');
const g = positionsDb.winStats(null);
assert(g.totalClosed === 6, `global totalClosed = 6 (got ${g.totalClosed})`);
assert(g.wins === 3, `global wins = 3 (got ${g.wins})`);

console.log('\n--- 6. winStats with no pnl_percent stored (legacy rows) ---');
// Insert a row without pnl_percent to verify fallback derivation
const r = positionsDb.open({ mint: 'LegacyMintxxxxxxxxxxxxxxxxxxxxxxxx', devWallet: dev, entrySig: 's', entrySol: 0.1, entryTokens: 100 });
getDb().prepare(`UPDATE positions SET exit_sig=?, exit_time=?, exit_sol=?, pnl_sol=?, status='CLOSED' WHERE id=?`)
  .run('sx', Date.now(), 0.12, 0.02, r.lastInsertRowid);
const g2 = positionsDb.winStats(null);
const legacyRow = g2.best.find((b) => b.mint === 'LegacyMintxxxxxxxxxxxxxxxxxxxxxxxx');
assert(legacyRow != null && Math.abs(legacyRow.pnlPercent - 20.0) < 0.001,
  `legacy row pnlPercent derived = 20% (got ${legacyRow?.pnlPercent})`);

console.log('\n--- 7. cleanup ---');
getDb().prepare(`DELETE FROM positions WHERE dev_wallet IN (?, ?)`).run(dev, dev2);
getDb().prepare(`DELETE FROM watched_wallets WHERE chat_id IN (?, ?)`).run(chatId, otherChat);
console.log('  test rows removed');

console.log(`\n${'='.repeat(40)}\n${passed} passed, ${failed} failed\n${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
