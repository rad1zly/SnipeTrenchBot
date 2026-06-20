#!/usr/bin/env node
// scripts/test-token-age.js
// Regression test for v0.8.0: token age filter unit is SECONDS, not minutes.
// Run: node scripts/test-token-age.js
import assert from 'node:assert/strict';
import { passesFilters } from '../src/filters.js';
import { settingsDb } from '../src/db.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✅', name);
    pass++;
  } catch (e) {
    console.log('  ❌', name, '—', e.message);
    fail++;
  }
}

console.log('=== token age filter (v0.8.0 — unit is SECONDS) ===');

const ORIG_MIN = settingsDb.get('min_token_age_min')?.value;
const ORIG_MAX = settingsDb.get('max_token_age_min')?.value;
const restore = () => {
  if (ORIG_MIN == null) settingsDb.set('min_token_age_min', null);
  else settingsDb.set('min_token_age_min', ORIG_MIN);
  if (ORIG_MAX == null) settingsDb.set('max_token_age_min', null);
  else settingsDb.set('max_token_age_min', ORIG_MAX);
};
process.on('exit', restore);

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint (real, not used here)
const DEV = 'rYn57LmWs2qX98koT13cDz8GKMDoMNoBcTveSnHqM7v';

await test('min=10s, token age 5s → rejected (age in seconds)', async () => {
  settingsDb.set('min_token_age_min', 10);
  settingsDb.set('max_token_age_min', null);
  const createdAt = Date.now() - 5_000; // 5 seconds old
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  if (r.passed) throw new Error('should reject 5s-old token when min=10s');
  if (!/5\.\d+s < min 10s/.test(r.reason)) throw new Error('reason should show seconds, got: ' + r.reason);
});

await test('min=10s, token age 15s → passed', async () => {
  settingsDb.set('min_token_age_min', 10);
  settingsDb.set('max_token_age_min', null);
  const createdAt = Date.now() - 15_000; // 15s old
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  if (!r.passed) throw new Error('should pass 15s-old token when min=10s. reason: ' + r.reason);
});

await test('max=60s, token age 120s → rejected', async () => {
  settingsDb.set('min_token_age_min', null);
  settingsDb.set('max_token_age_min', 60);
  const createdAt = Date.now() - 120_000;
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  if (r.passed) throw new Error('should reject 120s-old token when max=60s');
  if (!/120\.\d+s > max 60s/.test(r.reason)) throw new Error('reason should show seconds');
});

await test('min=null, max=null → no age filter (1-day-old token passes)', async () => {
  settingsDb.set('min_token_age_min', null);
  settingsDb.set('max_token_age_min', null);
  const createdAt = Date.now() - 86_400_000; // 1 day old
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  if (!r.passed) throw new Error('1-day-old token should pass when no filter. reason: ' + r.reason);
});

await test('reason uses "s" suffix (not "min")', async () => {
  settingsDb.set('min_token_age_min', 100);
  settingsDb.set('max_token_age_min', null);
  const createdAt = Date.now() - 50_000; // 50s old
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  // "min" alone is fine (means "minimum"); reject "minutes" or "min" as a unit suffix
  if (/\bminutes\b/.test(r.reason) || /\d+\.\d+min\b/.test(r.reason)) {
    throw new Error('reason should not use minutes unit, got: ' + r.reason);
  }
  if (!r.reason.match(/\d+s/)) throw new Error('reason should show "s" suffix, got: ' + r.reason);
});

await test('boundary: min=10, age=10.5s → passed (just above min)', async () => {
  settingsDb.set('min_token_age_min', 10);
  settingsDb.set('max_token_age_min', null);
  const createdAt = Date.now() - 10_500;
  const r = await passesFilters({ mint: MINT, dev: DEV, createdAt });
  if (!r.passed) throw new Error('10.5s should pass min=10s. reason: ' + r.reason);
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
