#!/usr/bin/env node
// scripts/test-executor-route-forward.js
// Regression test for v0.8.2: submitSwap must forward route + side to
// buildSwapTransaction. Without this, the swapRouter falls through to the
// Jupiter builder for pump.fun pre-graduation tokens, and Helius 422s the
// transaction because the referenced accounts don't exist on Jupiter routes.
//
// Run: node scripts/test-executor-route-forward.js
//
// This is a code-shape test (text search) because mocking the full Solana
// stack for a behavioral test is brittle. The code-shape test would have
// failed on v0.8.1 (and earlier).

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

console.log('=== executor route forwarding (v0.8.2 — pump.fun 422 fix) ===');

const exec = fs.readFileSync('src/executor.js', 'utf8');
const router = fs.readFileSync('src/swapRouter.js', 'utf8');

await test('submitSwapWithRetry forwards route to submitSwap', () => {
  // Find the body of submitSwapWithRetry's retry call.
  const m = exec.match(/async function submitSwapWithRetry[^{]*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('submitSwapWithRetry not found');
  const body = m[1];
  if (!/submitSwap\s*\(\s*\{[^}]*route/.test(body)) {
    throw new Error('submitSwapWithRetry does not pass route to submitSwap');
  }
});

await test('submitSwapWithRetry forwards side to submitSwap', () => {
  const m = exec.match(/async function submitSwapWithRetry[^{]*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('submitSwapWithRetry not found');
  const body = m[1];
  if (!/submitSwap\s*\(\s*\{[^}]*side/.test(body)) {
    throw new Error('submitSwapWithRetry does not pass side to submitSwap');
  }
});

await test('submitSwap accepts route + side params', () => {
  const sig = exec.match(/async function submitSwap\s*\(\s*\{[^}]*\}\s*\)/);
  if (!sig) throw new Error('submitSwap signature not found');
  if (!/route/.test(sig[0])) throw new Error('submitSwap missing route param');
  if (!/side/.test(sig[0])) throw new Error('submitSwap missing side param');
});

await test('submitSwap passes route + side to buildSwapTransaction', () => {
  // Find the call to buildSwapTransaction inside submitSwap.
  const m = exec.match(/async function submitSwap\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('submitSwap body not found');
  const body = m[1];
  if (!/buildSwapTransaction\s*\(\s*\{[^}]*route[^}]*side/s.test(body) &&
      !/buildSwapTransaction\s*\(\s*\{[^}]*side[^}]*route/s.test(body)) {
    throw new Error('buildSwapTransaction call missing route+side');
  }
});

await test('BUY call site passes route: buyRoute, side: "buy"', () => {
  if (!/submitSwapWithRetry\([^)]*route:\s*buyRoute[^)]*side:\s*['"]buy['"]/s.test(exec) &&
      !/submitSwapWithRetry\([^)]*side:\s*['"]buy['"][^)]*route:\s*buyRoute/s.test(exec)) {
    throw new Error('BUY call site does not pass route: buyRoute, side: "buy"');
  }
});

await test('SELL call site passes route: sellRoute, side: "sell"', () => {
  if (!/submitSwapWithRetry\([^)]*route:\s*sellRoute[^)]*side:\s*['"]sell['"]/s.test(exec) &&
      !/submitSwapWithRetry\([^)]*side:\s*['"]sell['"][^)]*route:\s*sellRoute/s.test(exec)) {
    throw new Error('SELL call site does not pass route: sellRoute, side: "sell"');
  }
});

await test('swapRouter.buildSwapTransaction requires route + side', () => {
  const sig = router.match(/export async function buildSwapTransaction\s*\(\s*\{[^}]*\}\s*\)/);
  if (!sig) throw new Error('buildSwapTransaction signature not found');
  if (!/route/.test(sig[0])) throw new Error('buildSwapTransaction missing route param');
  if (!/side/.test(sig[0])) throw new Error('buildSwapTransaction missing side param');
});

await test('swapRouter routes pump.fun to pumpfun builder (not Jupiter)', () => {
  const m = router.match(/export async function buildSwapTransaction\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!m) throw new Error('buildSwapTransaction body not found');
  const body = m[1];
  if (!/route\s*===\s*['"]pumpfun['"]/.test(body)) {
    throw new Error('swapRouter does not branch on route === "pumpfun"');
  }
  if (!/pumpfun\.buildSwapTransaction/.test(body)) {
    throw new Error('swapRouter does not call pumpfun.buildSwapTransaction');
  }
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
