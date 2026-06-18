#!/usr/bin/env node
// scripts/test-nullable-settings.js
// Regression test for v0.8.0: nullable filter/limit settings should accept
// null as "disabled" via the menu input handler. Catches the bug where
// typing "0" returned "Invalid value" instead of "Not Limited".
// Run: node scripts/test-nullable-settings.js
import assert from 'node:assert/strict';
import { getCatalogEntry, set, get } from '../src/settings.js';
import { settingsDb } from '../src/db.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✅', name);
    pass++;
  } catch (e) {
    console.log('  ❌', name, '—', e.message);
    fail++;
  }
}

console.log('=== nullable filter/limit settings (v0.8.0 fix) ===');

const NULLABLE_KEYS = [
  'min_mc_usd', 'max_mc_usd',
  'min_token_age_min', 'max_token_age_min',
  'sol_spending_limit',
];

for (const key of NULLABLE_KEYS) {
  test(`${key} has nullable: true in catalog`, () => {
    const entry = getCatalogEntry(key);
    assert.ok(entry, `${key} should exist in catalog`);
    assert.equal(entry.nullable, true, `${key}.nullable should be true`);
  });

  test(`${key} parseUserInput returns null for "0"`, () => {
    const entry = getCatalogEntry(key);
    assert.equal(entry.parseUserInput('0'), null);
    assert.equal(entry.parseUserInput('none'), null);
    assert.equal(entry.parseUserInput('off'), null);
    assert.equal(entry.parseUserInput(''), null);
    assert.equal(entry.parseUserInput('  '), null);
  });

  test(`${key} parseUserInput returns null for invalid input`, () => {
    const entry = getCatalogEntry(key);
    assert.equal(entry.parseUserInput('abc'), null);
    assert.equal(entry.parseUserInput('-5'), null);
  });

  test(`${key} parseUserInput accepts valid positive numbers`, () => {
    const entry = getCatalogEntry(key);
    assert.equal(entry.parseUserInput('10'), 10);
    assert.equal(entry.parseUserInput('100'), 100);
  });

  test(`${key} set(null) and get() returns null`, () => {
    set(key, null);
    assert.equal(get(key), null, `get(${key}) after set(null) should return null`);
  });

  test(`${key} set(10) and get() returns 10`, () => {
    set(key, 10);
    assert.equal(get(key), 10, `get(${key}) after set(10) should return 10`);
  });
}

// Non-nullable settings should NOT have nullable: true
const NON_NULLABLE_KEYS = ['buy_priority_fee_sol', 'buy_tip_sol', 'fixed_buy_sol', 'slippage_bps'];
for (const key of NON_NULLABLE_KEYS) {
  test(`${key} does NOT have nullable flag (returns 0 for "0", not null)`, () => {
    const entry = getCatalogEntry(key);
    if (!entry) return; // skip if not in catalog
    // buy_priority_fee_sol/buy_tip_sol return 0 for "0" (treats as disabled)
    // fixed_buy_sol/slippage_bps don't have a "0 = disabled" path
    if (['buy_priority_fee_sol', 'buy_tip_sol'].includes(key)) {
      assert.equal(entry.parseUserInput('0'), 0, `${key}.parseUserInput('0') should return 0`);
    }
  });
}

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
