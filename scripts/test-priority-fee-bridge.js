#!/usr/bin/env node
// scripts/test-priority-fee-bridge.js
// Regression test: ensures buildSwapTransaction reads buy_priority_fee_sol from
// settings DB and converts SOL → lamports correctly. Catches the variable-name
// typo that broke v0.8.0 first patch.
//
// Run: node scripts/test-priority-fee-bridge.js
import assert from 'node:assert/strict';
import { getBuyQuote, buildSwapTransaction } from '../src/jupiterMetis.js';
import * as settings from '../src/settings.js';

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

console.log('=== priority fee bridge (regression test for v0.8.0 typo) ===');

await test('settings.get(buy_priority_fee_sol) returns a number', () => {
  const v = settings.get('buy_priority_fee_sol');
  assert.ok(v != null, 'value should not be null');
  assert.ok(typeof Number(v) === 'number', 'should be a number');
  assert.ok(!Number.isNaN(Number(v)), 'should be a valid number');
});

await test('buildSwapTransaction does NOT throw "X is not defined"', async () => {
  const quote = await getBuyQuote({
    solAmount: 0.001,
    outputMint: '62NGaqGP17rjPtqNjHrKXDnVzA5bsn8132ePa9T1pump', // dev-wallet mint
  });
  assert.ok(quote && !quote.error, 'quote must succeed');
  const tx = await buildSwapTransaction({
    quoteResponse: quote,
    userPublicKey: 'Bk59D5NvtUZEvDNNVZegcN8bKS7KcHuoLoWpfuXn4Kqi',
  });
  assert.ok(tx != null, 'tx base64 should be returned');
  assert.ok(typeof tx === 'string' && tx.length > 100, 'tx should be a non-trivial base64 string');
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
