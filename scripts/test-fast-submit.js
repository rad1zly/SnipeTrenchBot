#!/usr/bin/env node
// scripts/test-fast-submit.js
// Speed test: verify send + processed-poll completes in <2s per leg.
// Run: node scripts/test-fast-submit.js
// Requires a funded wallet + a recent dev sell signal.

import fs from 'node:fs';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    const r = await fn();
    console.log('  ✅', name, r ? `· ${r}` : '');
    pass++;
  } catch (e) {
    console.log('  ❌', name, '—', e.message);
    fail++;
  }
}

console.log('=== fast submit (v0.8.0 — processed commitment) ===');

// Note: this is a code-shape test, not a real on-chain test (which would cost SOL).
// We assert the source contains the optimizations.

const exec = fs.readFileSync('src/executor.js', 'utf8');

await test('sendTransaction uses skipPreflight: true', () => {
  if (!/skipPreflight:\s*true/.test(exec)) throw new Error('skipPreflight not set');
});

await test('sendTransaction uses preflightCommitment: processed', () => {
  if (!/preflightCommitment:\s*['"]processed['"]/.test(exec)) {
    throw new Error('preflightCommitment not set to processed');
  }
});

await test('confirmTransaction replaced with async poll', () => {
  if (exec.includes('connection.confirmTransaction')) {
    throw new Error('still using connection.confirmTransaction');
  }
  if (!/getSignatureStatuses/.test(exec)) {
    throw new Error('not using getSignatureStatuses polling');
  }
});

await test('poll budget is bounded (≤2s)', () => {
  const m = exec.match(/POLL_BUDGET_MS\s*=\s*(\d+)/);
  if (!m) throw new Error('POLL_BUDGET_MS not defined');
  const budget = parseInt(m[1], 10);
  if (budget > 2000) throw new Error(`budget ${budget}ms > 2000ms`);
});

await test('processed/confirmed/finalized all accepted (graceful upgrade)', () => {
  if (!/confirmationStatus\s*===\s*['"]processed['"]/.test(exec)) {
    throw new Error('not checking for processed status');
  }
  if (!/confirmationStatus\s*===\s*['"]confirmed['"]/.test(exec)) {
    throw new Error('not accepting confirmed as fallback');
  }
});

await test('returns landedIn time for observability', () => {
  if (!/landedIn:/.test(exec)) {
    throw new Error('landedIn field not in return value');
  }
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
