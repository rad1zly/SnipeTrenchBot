// scripts/test-mint-routing.js
// Dry-run routing + quote test for a specific mint.
// SAFETY: this script NEVER calls submitSwap — only getBuyQuote, getSellQuote,
// and buildSwapTransaction, all of which return data without signing or
// submitting transactions. Safe to run with DRY_RUN=false.
//
// Usage: node scripts/test-mint-routing.js <MINT>

import 'dotenv/config';
import config from '../src/config.js';
import * as swapRouter from '../src/swapRouter.js';
import * as pumpfun from '../src/pumpfun.js';

const MINT = process.argv[2];
if (!MINT) {
  console.error('Usage: node scripts/test-mint-routing.js <MINT>');
  process.exit(1);
}

// Valid Solana pubkey for the test (uses a known-format placeholder; the
// Jupiter quote doesn't actually validate the pubkey is funded, just that
// it's a parseable address).
const TEST_BUYER = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const BUY_AMOUNT_SOL = 0.001; // tiny — routing test only

function log(label, val) {
  console.log(`  ${label.padEnd(28)} ${val}`);
}

async function main() {
  console.log('=== SnipeTrenchBot routing test ===');
  console.log(`Mint: ${MINT}`);
  console.log();

  // Settings check
  console.log('[Settings]');
  log('DRY_RUN:', config.DRY_RUN);
  log('MAX_SOL_PER_TRADE:', config.MAX_SOL_PER_TRADE);
  log('SLIPPAGE_BPS:', config.SLIPPAGE_BPS);
  log('HOLD_MS:', config.HOLD_MS);
  log('RPC:', config.SOLANA_RPC_URL ? config.SOLANA_RPC_URL.slice(0, 60) + '...' : 'unset');
  console.log();

  // 1. Detection
  console.log('[1] Token detection');
  const isPF = await pumpfun.isPumpfunToken(MINT);
  log('pumpfun.isPumpfunToken():', isPF);

  // 2. Mayhem check
  const isMayhem = isPF ? await pumpfun.isMayhemModeToken(MINT) : false;
  log('pumpfun.isMayhemModeToken():', isMayhem);
  console.log();

  // Expected route
  // v0.8.6.1: mayhem-mode tokens ARE tradable on pump.fun direct (V2 instruction
  // includes reserved fee recipients in additionalAccounts). The earlier guard
  // that fell back to Jupiter for mayhem was overly conservative — verified by
  // on-chain history of 7Zg4G...pump where mayhem=true still had successful V2
  // buy/sell txs in the last 10 sigs.
  const expectedRoute = isPF ? 'pumpfun' : 'jupiter';
  console.log(`[2] Router decision → expected route: ${expectedRoute}`);
  console.log();

  // 3. Buy quote (swapRouter returns { quote, route })
  console.log('[3] getBuyQuote()');
  const buyWrap = await swapRouter.getBuyQuote({
    outputMint: MINT,
    solAmount: BUY_AMOUNT_SOL,
    slippageBps: config.SLIPPAGE_BPS,
  });
  const buyQuote = buyWrap?.quote;
  log('route:', buyWrap?.route ?? 'null');
  log('outAmount:', buyQuote?.outAmount ?? 'null');
  log('priceImpactPct:', buyQuote?.priceImpactPct ?? 'null');
  if (!buyQuote || buyQuote.outAmount == null) {
    throw new Error('BUY quote returned no outAmount');
  }
  console.log();

  // 4. Sell quote (swapRouter returns { quote, route })
  console.log('[4] getSellQuote()');
  const sellWrap = await swapRouter.getSellQuote({
    inputMint: MINT,
    tokenRawAmount: buyQuote.outAmount,
    slippageBps: config.SLIPPAGE_BPS,
  });
  const sellQuote = sellWrap?.quote;
  log('route:', sellWrap?.route ?? 'null');
  log('outAmount (lamports):', sellQuote?.outAmount ?? 'null');
  log('priceImpactPct:', sellQuote?.priceImpactPct ?? 'null');
  if (!sellQuote || sellQuote.outAmount == null) {
    throw new Error('SELL quote returned no outAmount');
  }
  console.log();

  // 5. Build swap tx (NOT signed, NOT submitted)
  console.log('[5] buildSwapTransaction()');
  const txB64 = await swapRouter.buildSwapTransaction({
    quoteResponse: buyQuote,
    userPublicKey: TEST_BUYER,
    side: 'buy',
    route: buyWrap.route,  // use route from quote
  });
  if (!txB64) {
    throw new Error('buildSwapTransaction returned null');
  }
  log('route:', buyWrap.route);
  log('tx length (b64 chars):', txB64.length);
  log('tx length (bytes est):', Math.floor(txB64.length * 3 / 4));
  console.log();

  // 6. Verdict
  console.log('[6] Verdict');
  const routeMatch = buyWrap.route === expectedRoute;
  log('route matches expected:', routeMatch ? '✅' : '❌ MISMATCH');
  if (!routeMatch) {
    process.exit(1);
  }
  console.log();
  console.log('=== ALL CHECKS PASSED (no tx submitted) ===');
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
