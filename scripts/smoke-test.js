// scripts/smoke-test.js
// =============================================================================
// Smoke test for v0.1.1 additions. Exercises every new module without
// launching the real bot. Verifies:
//   1. settings table is created on db init
//   2. settings.get / set / reset round-trip works
//   3. safety.js exposes the new fields
//   4. settingsMenu renders all 6 views without error
//   5. applyPromptValue handles valid + invalid input
//   6. toggleSetting flips booleans
//   7. filters.js loads (no crash on require)
//   8. jupiterMetis.effectiveJupiterUrl() flips with anti_mev
//
// Run: `node scripts/smoke-test.js`
// =============================================================================

import 'dotenv/config'; // best-effort: works if .env exists, no-op otherwise
import { settingsDb, positionsDb, safetyDb, getDb } from '../src/db.js';
import * as settings from '../src/settings.js';
import * as settingsMenu from '../src/settingsMenu.js';
import * as filters from '../src/filters.js';
import { effectiveJupiterUrl } from '../src/jupiterMetis.js';
import { snapshot as safetySnapshot } from '../src/safety.js';

let passed = 0;
let failed = 0;
const fails = [];

function assert(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    fails.push(label);
    console.log(`  ❌ ${label}`);
  }
}

console.log('--- 1. settings table exists ---');
const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all();
assert(tables.length === 1, 'settings table created on db init');
assert(tables[0]?.name === 'settings', `table name is "settings" (got ${tables[0]?.name})`);

console.log('\n--- 2. settings round-trip ---');
settings.reset('fixed_buy_sol');
assert(settings.get('fixed_buy_sol') === 0.01, 'get returns default when unset');
settings.set('fixed_buy_sol', 0.07);
assert(settings.get('fixed_buy_sol') === 0.07, 'set then get round-trips');
settings.reset('fixed_buy_sol');
assert(settings.get('fixed_buy_sol') === 0.01, 'reset reverts to default');

console.log('\n--- 3. settings bounds ---');
try { settings.set('buy_limit_per_token', 4); assert(false, 'buy_limit_per_token=4 should throw'); }
catch (e) { assert(/must be 1, 2, or 3/.test(e.message), `buy_limit_per_token=4 throws (${e.message})`); }
try { settings.set('slippage_bps', 5); assert(false, 'slippage_bps=5 should throw'); }
catch (e) { assert(/must be 10-5000/.test(e.message), `slippage_bps=5 throws (${e.message})`); }
try { settings.set('fixed_buy_sol', 0); assert(false, 'fixed_buy_sol=0 should throw'); }
catch (e) { assert(/must be > 0/.test(e.message), `fixed_buy_sol=0 throws (${e.message})`); }

console.log('\n--- 4. settingsMenu renders all views ---');
for (const view of ['main', 'trade', 'filters', 'token', 'advanced', 'time']) {
  try {
    const v = settingsMenu.renderView(view);
    assert(v.text.length > 0, `${view} view has text`);
    assert(Array.isArray(v.keyboard) && v.keyboard.length > 0, `${view} view has keyboard (${v.keyboard.length} rows)`);
  } catch (e) {
    assert(false, `${view} view rendered: ${e.message}`);
  }
}

console.log('\n--- 5. applyPromptValue (success + error paths) ---');
settings.reset('start_time');
const r1 = settingsMenu.applyPromptValue('start_time', '09:00');
assert(r1.ok === true, `start_time=09:00 ok (${r1.message})`);
assert(settings.get('start_time') === '09:00', 'start_time persisted');
const r2 = settingsMenu.applyPromptValue('start_time', '25:00');
assert(r2.ok === false, 'start_time=25:00 rejected');
const r3 = settingsMenu.applyPromptValue('start_time', '9:00');
assert(r3.ok === true, 'start_time=9:00 normalized to 09:00');
assert(settings.get('start_time') === '09:00', 'start_time normalized to 09:00');
const r4 = settingsMenu.applyPromptValue('min_mc_usd', 'off');
assert(r4.ok === true, 'min_mc_usd=off → null');
assert(settings.get('min_mc_usd') === null, 'min_mc_usd is null after "off"');
const r5 = settingsMenu.applyPromptValue('min_mc_usd', '5.5');
assert(r5.ok === true, 'min_mc_usd=5.5');
assert(settings.get('min_mc_usd') === 5.5, 'min_mc_usd=5.5 persisted');
settings.reset('start_time');
settings.reset('min_mc_usd');

console.log('\n--- 6. toggleSetting ---');
settings.reset('unrenounced_only');
assert(settings.get('unrenounced_only') === false, 'unrenounced_only starts off');
const t1 = settingsMenu.toggleSetting('unrenounced_only');
assert(t1.value === true, 'toggle 1 → true');
const t2 = settingsMenu.toggleSetting('unrenounced_only');
assert(t2.value === false, 'toggle 2 → false');
settings.reset('unrenounced_only');

console.log('\n--- 7. filters module loads ---');
assert(typeof filters.passesFilters === 'function', 'passesFilters exported');
assert(typeof filters.activeFilters === 'function', 'activeFilters exported');
const af = filters.activeFilters();
assert(af.unrenounced_only === false, 'activeFilters.unrenounced_only off by default');
assert(af.min_mc_usd === null, 'activeFilters.min_mc_usd null by default');

console.log('\n--- 8. effectiveJupiterUrl flips with anti_mev ---');
const beforeUrl = effectiveJupiterUrl();
settings.reset('anti_mev');
assert(effectiveJupiterUrl() !== 'https://metis.jup.io', 'URL is not Metis when anti_mev off');
settings.set('anti_mev', true);
const afterUrl = effectiveJupiterUrl();
assert(afterUrl === 'https://metis.jup.io', `URL is Metis when anti_mev on (got ${afterUrl})`);
settings.reset('anti_mev');

console.log('\n--- 9. safety snapshot has new fields ---');
const snap = safetySnapshot();
assert('spendingLimit' in snap, 'spendingLimit in snapshot');
assert('spentSolToday' in snap, 'spentSolToday in snapshot');
assert('buyLimitPerToken' in snap, 'buyLimitPerToken in snapshot');
assert('autoSell' in snap, 'autoSell in snapshot');
assert('autoRetry' in snap, 'autoRetry in snapshot');
assert('antiMev' in snap, 'antiMev in snapshot');
assert('startTime' in snap, 'startTime in snapshot');
assert('endTime' in snap, 'endTime in snapshot');

console.log('\n--- 10. spentSolToday works ---');
const spent = settings.spentSolToday();
assert(typeof spent === 'number' && spent >= 0, `spentSolToday returns number (${spent})`);

console.log(`\n${'='.repeat(40)}\n${passed} passed, ${failed} failed\n${'='.repeat(40)}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
