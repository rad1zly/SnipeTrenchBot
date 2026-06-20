#!/usr/bin/env node
// scripts/test-pumpfun-router.js
// Regression test for v0.8.0: pump.fun direct swap via smart router.
import assert from 'node:assert/strict';
import { getBuyQuote, getSellQuote, buildSwapTransaction, invalidateRouterCache } from '../src/swapRouter.js';

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

console.log('=== pump.fun router (v0.8.0 — speed optimization) ===');

const PUMP_FUN_MINT = 'GTyGKtvxDgMJuLwEPyniqMpL1nDgPHB1CbPDMECspump';
const JUPITER_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER = '6DVEtijzmZbh18LvgMdF8fqYB2cFozdr2jAXhnVfDooM';

await test('pump.fun mint auto-detected as "pumpfun" route', async () => {
  const { route } = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  assert.equal(route, 'pumpfun');
});

await test('non-pump.fun mint falls back to "jupiter" route', async () => {
  const { route } = await getBuyQuote({ solAmount: 0.001, outputMint: JUPITER_MINT });
  assert.equal(route, 'jupiter');
});

await test('pump.fun buy quote returns valid outAmount', async () => {
  const { quote, route } = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  assert.equal(route, 'pumpfun');
  assert.ok(BigInt(quote.outAmount) > 0n, 'outAmount must be > 0');
  assert.ok(quote._maxSolCost, 'pump.fun quote must have _maxSolCost');
});

await test('pump.fun sell quote returns valid outAmount', async () => {
  const { quote, route } = await getSellQuote({ tokenRawAmount: 100_000n * 1_000_000n, inputMint: PUMP_FUN_MINT });
  assert.equal(route, 'pumpfun');
  assert.ok(BigInt(quote.outAmount) > 0n, 'outAmount must be > 0');
  assert.ok(quote._minSolOutput, 'pump.fun quote must have _minSolOutput');
});

await test('pump.fun buy transaction builds (compact < 1500 chars)', async () => {
  const { quote, route } = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  const txB64 = await buildSwapTransaction({ quoteResponse: quote, userPublicKey: USER, route, side: 'buy' });
  assert.ok(typeof txB64 === 'string' && txB64.length > 100, 'tx should be non-trivial base64');
  assert.ok(txB64.length < 1500, `pump.fun tx should be compact, got ${txB64.length} chars`);
});

await test('pump.fun sell transaction builds (compact < 1500 chars)', async () => {
  const { quote, route } = await getSellQuote({ tokenRawAmount: 100_000n * 1_000_000n, inputMint: PUMP_FUN_MINT });
  const txB64 = await buildSwapTransaction({ quoteResponse: quote, userPublicKey: USER, route, side: 'sell' });
  assert.ok(typeof txB64 === 'string' && txB64.length > 100);
  assert.ok(txB64.length < 1500, `pump.fun tx should be compact, got ${txB64.length} chars`);
});

await test('router cache is consistent across calls', async () => {
  invalidateRouterCache(PUMP_FUN_MINT);
  const r1 = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  const r2 = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  assert.equal(r1.route, r2.route, 'route should be consistent across calls');
  assert.equal(r1.quote.outAmount, r2.quote.outAmount, 'quote should be consistent');
});

await test('invalidateRouterCache forces recheck', async () => {
  invalidateRouterCache(PUMP_FUN_MINT);
  const { route } = await getBuyQuote({ solAmount: 0.001, outputMint: PUMP_FUN_MINT });
  assert.equal(route, 'pumpfun');
});

await test('Jupiter path still works (regression)', async () => {
  const { quote, route } = await getBuyQuote({ solAmount: 0.001, outputMint: JUPITER_MINT });
  assert.equal(route, 'jupiter');
  const txB64 = await buildSwapTransaction({ quoteResponse: quote, userPublicKey: USER, route });
  assert.ok(typeof txB64 === 'string' && txB64.length > 100);
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
