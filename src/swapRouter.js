// src/swapRouter.js
// =============================================================================
// Smart router: detect if a token is on pump.fun bonding curve and use the
// direct pump.fun path. Jupiter fallback is DISABLED (M6.2 step 1) per user
// request — bot is now pump.fun-only. For graduated tokens, see step 2
// (M6.2b: add pump.fun AMM swap). Until then, trades on graduated tokens
// will fail with a clear "JUPITER_DISABLED" error so we can audit them.
//
// v0.8.0 (June 2026) + v0.8.8 M6.2 step 1 (June 2026).
// =============================================================================

import * as pumpfun from './pumpfun.js';
import * as jupiter from './jupiterMetis.js';  // kept import for back-compat; not called
import config from './config.js';  // v0.8.8 M6.2 step 2: SOL_MINT for AMM quote shape

const JUPITER_DISABLED = true;  // v0.8.8 M6.2 step 1 — set false to re-enable Jupiter fallback

// Cache of "is this mint on pump.fun" to avoid re-checking every signal.
// Once a token graduates (mcap > ~$69k), this flips to false permanently.
const PUMP_CHECK_CACHE = new Map();
const PUMP_CHECK_TTL_MS = 30_000;  // recheck every 30s in case of graduation

/**
 * Get buy quote. Auto-routes to pump.fun if available, else Jupiter.
 * v0.8.7.15: chatId threaded through so Jupiter-route uses per-user settings
 * (anti_mev, buy_priority_fee_sol). pump.fun route doesn't need it.
 * @returns {Promise<{quote, route: 'pumpfun' | 'jupiter'}>}
 */
export async function getBuyQuote({ solAmount, outputMint, slippageBps = 500, chatId = null }) {
  const isPF = await _isPumpfunToken(outputMint);
  if (isPF) {
    // v0.8.8 M6.2 step 1: pump.fun bonding path (unchanged).
    try {
      const quote = await pumpfun.getBuyQuote({ solAmount, outputMint, slippageBps });
      if (quote && quote.outAmount && quote.outAmount !== '0') {
        return { quote, route: 'pumpfun' };
      }
      throw new Error(`pumpfun quote invalid (outAmount=${quote?.outAmount})`);
    } catch (e) {
      throw new Error(
        `pumpfun getBuyQuote failed for ${outputMint.toString()}: ${e.message}. ` +
        `(Jupiter fallback disabled in M6.2 step 1.)`
      );
    }
  }
  // v0.8.8 M6.2 step 2: not on bonding. Try pump.fun AMM.
  const isAmm = await pumpfun.isAmmPoolExists(outputMint);
  if (isAmm) {
    try {
      // For AMM, the buy shape is different (we'd be buying base tokens with SOL).
      // But copy-trade bot only BUYs on bonding (fresh tokens). Buying on AMM is
      // a different strategy and not yet supported. Throw a clear error.
      throw new Error('AMM_BUY_NOT_SUPPORTED: copy-trade bot only buys on bonding. ' +
        'For AMM buys, use Jupiter or another tool. (M6.2 step 2 only supports AMM sell.)');
    } catch (e) {
      throw e;
    }
  }
  // v0.8.8 M6.2 step 1: Jupiter fallback disabled.
  const detail = await _describeRouteFailure(outputMint);
  throw new Error(
    `JUPITER_DISABLED: no pump.fun path for ${outputMint.toString()} ` +
    `(${detail}). Bot is pump.fun-only as of M6.2 step 1. ` +
    `Not a pump.fun token (no bonding curve, no AMM pool).`
  );
}

export async function getSellQuote({ tokenRawAmount, inputMint, slippageBps = 500, chatId = null }) {
  const isPF = await _isPumpfunToken(inputMint);
  if (isPF) {
    // v0.8.8 M6.2 step 1: pump.fun bonding path (unchanged).
    try {
      const quote = await pumpfun.getSellQuote({ tokenRawAmount, inputMint, slippageBps });
      if (quote && quote.outAmount && quote.outAmount !== '0') {
        return { quote, route: 'pumpfun' };
      }
      throw new Error(`pumpfun quote invalid (outAmount=${quote?.outAmount})`);
    } catch (e) {
      throw new Error(
        `pumpfun getSellQuote failed for ${inputMint.toString()}: ${e.message}. ` +
        `(Jupiter fallback disabled in M6.2 step 1.)`
      );
    }
  }
  // v0.8.8 M6.2 step 2: not on bonding. Try pump.fun AMM.
  const isAmm = await pumpfun.isAmmPoolExists(inputMint);
  if (isAmm) {
    try {
      const quote = await pumpfun.getAmmSellQuote({ inputMint, tokenRawAmount, slippageBps });
      if (!quote || quote.outAmount == null) {
        throw new Error('AMM quote returned invalid (outAmount=null)');
      }
      // Wrap in same shape as bonding quote (for downstream consumers)
      return {
        quote: {
          outAmount: quote.outAmount.toString(),  // lamports
          inAmount: tokenRawAmount.toString(),
          inputMint: inputMint.toString(),
          outputMint: config.SOL_MINT,
          _minSolOutput: quote.minOutAmount.toString(),
          _route: 'amm',
          _ammPoolState: quote.poolState,
        },
        route: 'amm',
      };
    } catch (e) {
      throw new Error(
        `pumpfun AMM getSellQuote failed for ${inputMint.toString()}: ${e.message}`
      );
    }
  }
  // v0.8.8 M6.2 step 1: Jupiter fallback disabled.
  const detail = await _describeRouteFailure(inputMint);
  throw new Error(
    `JUPITER_DISABLED: no pump.fun path for ${inputMint.toString()} ` +
    `(${detail}). Bot is pump.fun-only as of M6.2 step 1. ` +
    `Not a pump.fun token (no bonding curve, no AMM pool).`
  );
}

/**
 * Build swap transaction. The 'route' must match the quote's route.
 * For Jupiter, signature matches jupiterMetis.buildSwapTransaction exactly.
 * For pump.fun, we need the side ('buy' or 'sell') — derive from quote shape.
 * v0.8.8 M6.2 step 2: also support 'amm' route (graduated tokens).
 */
export async function buildSwapTransaction({ quoteResponse, userPublicKey, route, side, chatId = null }) {
  if (route === 'pumpfun') {
    // v0.8.7.16: pass chatId so pump.fun route honors per-user
    // buy_priority_fee_sol. Previously hardcoded to 0.00025 SOL.
    return pumpfun.buildSwapTransaction({ quoteResponse, userPublicKey, side, chatId });
  }
  if (route === 'amm') {
    // v0.8.8 M6.2 step 2: pump.fun AMM sell (no buy support yet).
    // quoteResponse._minSolOutput is lamports.
    return pumpfun.buildAmmSwapTransaction({
      quoteResponse,
      userPublicKey,
      chatId,
    });
  }
  return jupiter.buildSwapTransaction({ quoteResponse, userPublicKey, chatId });
}

// Internal: cached "is pump.fun token" check
// v0.8.6.2 (REVISED): mayhem-mode pump.fun tokens reject V1 buy on-chain
// with NotAuthorized 6000 (confirmed by real on-chain test 2026-06-19
// 22:51Z, mint 7Zg4GGUE18sTBZg6t68gRcJEzWFdApXymHnyTg6Dpump, sig
// JVJnGbuvfgoDJA7DYEFNHVqzWTNeccwdGBwSsVDbkYfLmUqQsopWTVbpJq1r9MD3fwdDagdQEPv5ZPu27wFDn1z).
// v0.8.6.1 had removed this guard based on a quote/build success — but
// build() doesn't validate on-chain authorization. V1 buy disc (66063d12...)
// for mayhem tokens: rejected at fee_recipient.rs:19 with NotAuthorized 6000.
// SDK BuyV2 disc (b817ee6167c5d33d) is in IDL but unverified on mainnet for
// mayhem tokens. The conservative path: skip mayhem tokens → fall back to
// Jupiter (which DOES work, on-chain verified 9/9 test-pumpfun-router.js pass).
async function _isPumpfunToken(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  const cached = PUMP_CHECK_CACHE.get(m);
  if (cached && Date.now() - cached.checkedAt < PUMP_CHECK_TTL_MS) {
    return cached.value;
  }
  // v0.8.6.4: mayhem tokens are now tradable via direct pump.fun with
  // reserved fee recipients (verified by 10/10 SELL simulation +
  // handcrafted BuyExactSolIn BUY works on-chain).
  // The old guard from v0.8.6.2 was needed when the SDK didn't support
  // mayhem fee_recipient selection; we now pass it explicitly in
  // pumpfun.buildBuyInstruction/buildSellInstruction.
  const isPF = await pumpfun.isPumpfunToken(m);
  PUMP_CHECK_CACHE.set(m, { value: isPF, checkedAt: Date.now() });
  return isPF;
}

// v0.8.8 M6.2 step 1: when route fails (Jupiter disabled), give a clearer
// error message distinguishing "not a pump.fun token" vs "graduated" so
// the executor/operator can decide what to do.
async function _describeRouteFailure(mint) {
  try {
    const state = await pumpfun.getBondingCurveState(mint);
    if (state && state.complete) {
      return 'graduated to AMM';
    }
    return 'bonding-curve quote failed';
  } catch (e) {
    if (/not found/i.test(e.message)) {
      return 'no pump.fun bonding curve (not a pump.fun token)';
    }
    return `pump.fun error: ${e.message}`;
  }
}

export function invalidateRouterCache(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  PUMP_CHECK_CACHE.delete(m);
  pumpfun.invalidateBondingCurveCache(m);
}
