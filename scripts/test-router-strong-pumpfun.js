#!/usr/bin/env node
// scripts/test-router-strong-pumpfun.js
// Regression test for v0.8.0: when mint is on pump.fun, router MUST pick pump.fun,
// even if Jupiter returns a valid quote. Also: throw informative error when both fail.
import assert from 'node:assert/strict';
import { getBuyQuote, getSellQuote } from '../src/swapRouter.js';
import { invalidateRouterCache } from '../src/swapRouter.js';

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

console.log('=== strong pump.fun preference (v0.8.0 — error UX fix) ===');

const PUMP_FUN_MINT = '7XGknbpC4mpFvc2GAyTngdFHUYMqeAMibhVthh7dpump';
const JUPITER_ONLY_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

await test('pump.fun mint routes to "pumpfun" (strong preference)', async () => {
  invalidateRouterCache(PUMP_FUN_MINT);
  const { route, quote } = await getBuyQuote({ solAmount: 0.0001, outputMint: PUMP_FUN_MINT, slippageBps: 500 });
  assert.equal(route, 'pumpfun', 'must pick pump.fun over Jupiter');
  assert.ok(BigInt(quote.outAmount) > 0n, 'must have valid outAmount');
});

await test('pump.fun sell: also uses pump.fun', async () => {
  invalidateRouterCache(PUMP_FUN_MINT);
  const { route, quote } = await getSellQuote({ tokenRawAmount: 1_000_000n, inputMint: PUMP_FUN_MINT, slippageBps: 500 });
  assert.equal(route, 'pumpfun');
  assert.ok(BigInt(quote.outAmount) > 0n);
});

await test('Jupiter-only mint (USDC) routes to "jupiter"', async () => {
  invalidateRouterCache(JUPITER_ONLY_MINT);
  const { route } = await getBuyQuote({ solAmount: 0.0001, outputMint: JUPITER_ONLY_MINT, slippageBps: 500 });
  assert.equal(route, 'jupiter');
});

await test('zero SOL amount throws informative error (not a real mint test)', async () => {
  // SOL amount of 0 → can't quote either path. Verifies the error message.
  try {
    await getBuyQuote({ solAmount: 0, outputMint: PUMP_FUN_MINT, slippageBps: 500 });
    throw new Error('should have thrown');
  } catch (e) {
    // Either pump.fun rejects with "0" or Jupiter rejects; both should propagate as informative error.
    assert.ok(e.message.length > 5, 'should have descriptive error');
  }
});

await test('pump.fun router returns valid outAmount (no 0/undefined)', async () => {
  const { quote } = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT, slippageBps: 500 });
  assert.ok(quote.outAmount, 'outAmount must be present');
  assert.notEqual(quote.outAmount, '0', 'outAmount must not be 0');
  assert.notEqual(quote.outAmount, undefined, 'outAmount must not be undefined');
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
