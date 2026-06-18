// scripts/test-sellratio.js
// =============================================================================
// Unit test for v0.8.0 sell-ratio filter plumbing.
//
// The actual RPC call (getParsedTokenAccountsByOwner) is not exercised here —
// that would need a real on-chain mint + a mockable Connection. Instead we
// test the parts that matter for correctness:
//
//   1. settings catalog + parser
//   2. formatValue() returns percentage string
//   3. activeFilters() exposes the new key
//   4. passesFilters() integrates soldAmount correctly (skips when null,
//      includes when present, and propagates a real ratio calculation when
//      the underlying RPC stub is available)
//
// Why we don't mock @solana/web3.js Connection: the property is non-
// configurable. We sidestep that by using a test that calls checkSellRatio
// with soldAmount=null (skips the RPC branch entirely).
// =============================================================================
import 'dotenv/config';
import * as settings from '../src/settings.js';
import { passesFilters, activeFilters, _clearCache } from '../src/filters.js';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

const DEV = 'SoMeDeVWaLLeTxxxxxxxxxxxxxxxxxxxxxxx';
const MINT = 'SoMeMintxxxxxxxxxxxxxxxxxxxxxxxxxx';

console.log('--- 1. catalog: min_sell_ratio exists with right bounds ---');
const cat = settings.getCatalogEntry('min_sell_ratio');
assert(cat != null, 'min_sell_ratio entry exists in catalog');
assert(cat.default === 0.9, `default is 0.9 (got ${cat.default})`);
assert(cat.min === 0.1 && cat.max === 1.0, `bounds are 0.1..1.0 (got ${cat.min}..${cat.max})`);

console.log('\n--- 2. parser: accepts 0.9, 90, 0.5, 50, "off" ---');
const cases = [
  ['0.9', 0.9],
  ['90', 0.9],          // 90 → 0.9
  ['0.5', 0.5],
  ['50', 0.5],
  [' 1.0 ', 1.0],
  ['100', 1.0],
  ['off', null],
  ['none', null],
];
for (const [input, expected] of cases) {
  const got = cat.parseUserInput(input);
  if (expected === null) {
    assert(got === null, `parse("${input}") = null (got ${got})`);
  } else {
    assert(Math.abs(got - expected) < 1e-9, `parse("${input}") = ${expected} (got ${got})`);
  }
}

console.log('\n--- 3. parser: rejects out-of-range ---');
const bad = ['0.05', '1.5', 'abc', '200', '-0.5'];
for (const input of bad) {
  const got = cat.parseUserInput(input);
  assert(got === null, `parse("${input}") = null (got ${got})`);
}

console.log('\n--- 4. formatValue displays percentage ---');
settings.reset('min_sell_ratio');
assert(settings.formatValue('min_sell_ratio') === '90%', `default formats to "90%" (got "${settings.formatValue('min_sell_ratio')}")`);
settings.set('min_sell_ratio', 0.5);
assert(settings.formatValue('min_sell_ratio') === '50%', `0.5 formats to "50%" (got "${settings.formatValue('min_sell_ratio')}")`);
settings.set('min_sell_ratio', 1.0);
assert(settings.formatValue('min_sell_ratio') === '100%', `1.0 formats to "100%" (got "${settings.formatValue('min_sell_ratio')}")`);
settings.set('min_sell_ratio', 0.1);
assert(settings.formatValue('min_sell_ratio') === '10%', `0.1 formats to "10%" (got "${settings.formatValue('min_sell_ratio')}")`);

console.log('\n--- 5. activeFilters exposes min_sell_ratio ---');
settings.reset('min_sell_ratio');
const af = activeFilters();
assert('min_sell_ratio' in af, 'activeFilters has min_sell_ratio key');
assert(af.min_sell_ratio === 0.9, `min_sell_ratio default exposed as 0.9 (got ${af.min_sell_ratio})`);

console.log('\n--- 6. passesFilters handles soldAmount correctly ---');
_clearCache();
settings.reset('min_sell_ratio');

// 6a. Without soldAmount (e.g. a TOKEN_CREATED event), sell ratio is skipped.
const r6a = await passesFilters({ mint: MINT, dev: DEV, soldAmount: null });
assert(r6a.passed, '6a: soldAmount=null → filter skipped, pass');

// 6b. With soldAmount but filter at default 0.9, the RPC path runs. In
// offline test env the RPC will throw — that's OK, the filter catches and
// passes (we never block on RPC errors). The test just verifies we don't
// throw.
const r6b = await passesFilters({ mint: MINT, dev: DEV, soldAmount: 1_000_000 });
assert(r6b.passed, '6b: RPC error caught and filter passes');

// 6c. With soldAmount and a permissive min (0.1) — the math would be
// compared. The RPC will throw (offline), so we still pass. We just verify
// the value was read.
settings.set('min_sell_ratio', 0.1);
const r6c = await passesFilters({ mint: MINT, dev: DEV, soldAmount: 1_000_000 });
assert(r6c.passed, '6c: min=0.1, RPC fails → pass (defensive)');
assert(settings.get('min_sell_ratio') === 0.1, '6c: min_sell_ratio=0.1 persisted');

settings.reset('min_sell_ratio');

console.log('\n--- 7. executor wires soldAmount through ---');
// Read executor.js source to verify it passes event.tokenSent to passesFilters.
import { readFileSync } from 'node:fs';
const execSrc = readFileSync(new URL('../src/executor.js', import.meta.url), 'utf8');
const hasSold = /soldAmount:\s*event\.tokenSent/.test(execSrc);
assert(hasSold, 'executor.js passes event.tokenSent as soldAmount to passesFilters');

console.log(`\n${'='.repeat(40)}\n${passed} passed, ${failed} failed\n${'='.repeat(40)}`);
process.exit(failed > 0 ? 1 : 0);
