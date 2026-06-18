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
      return { quote, route: 'pumpfun' };
    } catch (e) {
      // Fall through to Jupiter if pump.fun fails (e.g. complete=true detected late)
      console.warn(`[swapRouter] pumpfun getBuyQuote failed: ${e.message}; falling back to jupiter`);
    }
  }
  const quote = await jupiter.getBuyQuote({ solAmount, outputMint, slippageBps });
  return { quote, route: 'jupiter' };
}

export async function getSellQuote({ tokenRawAmount, inputMint, slippageBps = 500 }) {
  const isPF = await _isPumpfunToken(inputMint);
  if (isPF) {
    try {
      const quote = await pumpfun.getSellQuote({ tokenRawAmount, inputMint, slippageBps });
      return { quote, route: 'pumpfun' };
    } catch (e) {
      console.warn(`[swapRouter] pumpfun getSellQuote failed: ${e.message}; falling back to jupiter`);
    }
  }
  const quote = await jupiter.getSellQuote({ tokenRawAmount, inputMint, slippageBps });
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
async function _isPumpfunToken(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  const cached = PUMP_CHECK_CACHE.get(m);
  if (cached && Date.now() - cached < PUMP_CHECK_TTL_MS) {
    return cached.value;
  }
  const value = await pumpfun.isPumpfunToken(m);
  PUMP_CHECK_CACHE.set(m, { value, checkedAt: Date.now() });
  return value;
}

export function invalidateRouterCache(mint) {
  const m = typeof mint === 'string' ? mint : mint.toString();
  PUMP_CHECK_CACHE.delete(m);
  pumpfun.invalidateBondingCurveCache(m);
}
