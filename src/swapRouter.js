// src/swapRouter.js
// =============================================================================
// Smart router: detect if a token is on pump.fun bonding curve and use the
// direct pump.fun path. Otherwise fall back to Jupiter. This gives us
// 200-400ms speedup for pre-graduation tokens (which is most of what
// copy-trade snipers encounter).
//
// v0.8.0 (June 2026).
// =============================================================================

import * as pumpfun from './pumpfun.js';
import * as jupiter from './jupiterMetis.js';

// Cache of "is this mint on pump.fun" to avoid re-checking every signal.
// Once a token graduates (mcap > ~$69k), this flips to false permanently.
const PUMP_CHECK_CACHE = new Map();
const PUMP_CHECK_TTL_MS = 30_000;  // recheck every 30s in case of graduation

/**
 * Get buy quote. Auto-routes to pump.fun if available, else Jupiter.
 * @returns {Promise<{quote, route: 'pumpfun' | 'jupiter'}>}
 */
export async function getBuyQuote({ solAmount, outputMint, slippageBps = 500 }) {
  const isPF = await _isPumpfunToken(outputMint);
  if (isPF) {
    try {
      const quote = await pumpfun.getBuyQuote({ solAmount, outputMint, slippageBps });
      if (quote && quote.outAmount && quote.outAmount !== '0') {
        return { quote, route: 'pumpfun' };
      }
      // quote returned but outAmount is 0/invalid → treat as failure
      console.warn(`[swapRouter] pumpfun getBuyQuote returned invalid quote (outAmount=${quote?.outAmount}); falling back to jupiter`);
    } catch (e) {
      // v0.8.0: detailed log so we can diagnose 'no quote' errors.
      // Common causes: "graduated" → use Jupiter. "not found" → use Jupiter.
      // But for bonding-curve tokens, the path SHOULD work — log it.
      console.warn(`[swapRouter] pumpfun getBuyQuote failed for ${outputMint.toString()}: ${e.message}; falling back to jupiter`);
    }
  }
  const quote = await jupiter.getBuyQuote({ solAmount, outputMint, slippageBps });
  if (!quote || !quote.outAmount) {
    throw new Error(
      `no quote available for ${outputMint.toString()} (route=${isPF ? 'pumpfun-fallback' : 'jupiter'}); ` +
      `solAmount=${solAmount} SOL, slippageBps=${slippageBps}`
    );
  }
  return { quote, route: 'jupiter' };
}

export async function getSellQuote({ tokenRawAmount, inputMint, slippageBps = 500 }) {
  const isPF = await _isPumpfunToken(inputMint);
  if (isPF) {
    try {
      const quote = await pumpfun.getSellQuote({ tokenRawAmount, inputMint, slippageBps });
      if (quote && quote.outAmount && quote.outAmount !== '0') {
        return { quote, route: 'pumpfun' };
      }
      console.warn(`[swapRouter] pumpfun getSellQuote returned invalid quote; falling back to jupiter`);
    } catch (e) {
      console.warn(`[swapRouter] pumpfun getSellQuote failed for ${inputMint.toString()}: ${e.message}; falling back to jupiter`);
    }
  }
  const quote = await jupiter.getSellQuote({ tokenRawAmount, inputMint, slippageBps });
  if (!quote || !quote.outAmount) {
    throw new Error(
      `no sell quote available for ${inputMint.toString()} (route=${isPF ? 'pumpfun-fallback' : 'jupiter'})`
    );
  }
  return { quote, route: 'jupiter' };
}

/**
 * Build swap transaction. The 'route' must match the quote's route.
 * For Jupiter, signature matches jupiterMetis.buildSwapTransaction exactly.
 * For pump.fun, we need the side ('buy' or 'sell') — derive from quote shape.
 */
export async function buildSwapTransaction({ quoteResponse, userPublicKey, route, side }) {
  if (route === 'pumpfun') {
    return pumpfun.buildSwapTransaction({ quoteResponse, userPublicKey, side });
  }
  return jupiter.buildSwapTransaction({ quoteResponse, userPublicKey });
}

// Internal: cached "is pump.fun token" check
// v0.8.5: also returns false for mayhem-mode tokens (they fail on-chain
// with NotAuthorized 6000 because the reserved fee recipients list isn't
// in the SDK IDL). Bot should fall back to Jupiter for mayhem tokens.
async function _isPumpfunToken(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  const cached = PUMP_CHECK_CACHE.get(m);
  if (cached && Date.now() - cached.checkedAt < PUMP_CHECK_TTL_MS) {
    return cached.value;
  }
  const isPF = await pumpfun.isPumpfunToken(m);
  let value = isPF;
  if (isPF) {
    const isMayhem = await pumpfun.isMayhemModeToken(m);
    if (isMayhem) {
      // v0.8.5: mayhem mode rejected → fall back to Jupiter
      value = false;
    }
  }
  PUMP_CHECK_CACHE.set(m, { value, checkedAt: Date.now() });
  return value;
}

export function invalidateRouterCache(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  PUMP_CHECK_CACHE.delete(m);
  pumpfun.invalidateBondingCurveCache(m);
}
