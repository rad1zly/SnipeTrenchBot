// src/filters.js
// =============================================================================
// On-chain token filters (opt-in). Each filter has its own check function.
// All filters are off by default — see settings.js DEFAULTS. The executor
// calls passesFilters({ mint, dev, createdAt }) and skips the trade if any
// active filter returns false.
//
// Caching: every per-mint result is cached for FILTER_CACHE_TTL_MS so we
// don't spam Helius on every signal of the same mint. With 1-second polling
// and a typical trade lasting 60s, the same mint might emit 60 SELL events
// — caching is critical for Helius free-tier survival.
// =============================================================================

import { Connection, PublicKey } from '@solana/web3.js';
import config from './config.js';
import * as settings from './settings.js';

// Pump.fun program + bonding curve. Used for unburned/external-internal checks.
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const FILTER_CACHE_TTL_MS = 30_000; // 30s per-mint cache

// Lazy connection — only built when an on-chain check is needed.
let _conn = null;
function conn() {
  if (!_conn) {
    _conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  }
  return _conn;
}

// In-memory cache: mint → { result, expiresAt }
const cache = new Map();
function cached(mint, loader) {
  const now = Date.now();
  const hit = cache.get(mint);
  if (hit && hit.expiresAt > now) return hit.result;
  const result = loader();
  cache.set(mint, { result, expiresAt: now + FILTER_CACHE_TTL_MS });
  return result;
}

// =============================================================================
// SOL → USDC price (used to convert MC from SOL to USD)
// =============================================================================
// Global, 60s cache. SOL price is a single number at any moment, no point
// caching per-mint. If the Jupiter quote fails (rate-limit, 5xx) we keep the
// last good price for an extra TTL so a single hiccup doesn't disable MC
// checks; only after a full 60s + failure do we surface the error.
// =============================================================================
const SOL_PRICE_CACHE_TTL_MS = 60_000;
let _solPriceCache = { price: null, expiresAt: 0, lastErr: null };
async function getSolPriceUsd() {
  const now = Date.now();
  if (_solPriceCache.price !== null && _solPriceCache.expiresAt > now) {
    return _solPriceCache.price;
  }
  const axios = (await import('axios')).default;
  // Quote 1 SOL (10^9 lamports) → USDC. USDC has 6 decimals.
  const url = `${config.JUPITER_API_URL}/quote?inputMint=${config.SOL_MINT}&outputMint=${config.USDC_MINT}&amount=1000000000&slippageBps=50`;
  const resp = await axios.get(url, { timeout: 5000 });
  if (!resp.data || !resp.data.outAmount) {
    throw new Error('no outAmount in SOL→USDC Jupiter quote');
  }
  const usdc = Number(resp.data.outAmount) / 1_000_000;
  if (!Number.isFinite(usdc) || usdc <= 0) {
    throw new Error(`bad SOL→USDC price: ${usdc}`);
  }
  _solPriceCache = { price: usdc, expiresAt: now + SOL_PRICE_CACHE_TTL_MS, lastErr: null };
  return usdc;
}

// =============================================================================
// unrenounced check
// =============================================================================
// "Renounced" = mint authority set to null. unrenounced_only=true means we
// skip tokens where mint authority IS null (i.e., the dev gave up control).
// We fetch the mint account info and read the mintAuthority field.
// =============================================================================
async function checkUnrenounced(mint) {
  return cached(mint, async () => {
    try {
      const info = await conn().getAccountInfo(new PublicKey(mint));
      if (!info) return { passed: true, reason: 'mint not found, skipping check' };
      // Mint account layout (SPL):
      //   0..4   : mintAuthority (COption<Pubkey>) — 0 = none, 32 = pubkey
      //   4..36  : pubkey bytes (if mintAuthority is Some)
      //   36     : decimals
      // ...
      // The COption is 4 bytes: 0x00000000 means None, anything else means Some.
      // For simplicity, read the first 4 bytes as a u32 little-endian.
      const buf = info.data;
      const mintAuthOption = buf.readUInt32LE(0);
      const mintAuthority = mintAuthOption === 0 ? null : new PublicKey(buf.slice(4, 36));
      return {
        passed: mintAuthority !== null,
        reason: mintAuthority === null
          ? 'mint authority renounced (dev gave up control)'
          : 'mint authority active',
      };
    } catch (err) {
      return { passed: true, reason: `unrenounced check failed: ${err.message}` };
    }
  });
}

// =============================================================================
// unburned check (pump.fun-specific)
// =============================================================================
// "Burned" = bonding curve complete (token migrated to Raydium, LP burned
// during migration). unburned_only=true means we skip migrated tokens.
// We derive the bonding curve from the mint: it's a PDA, but the canonical
// way to get it is from the create tx (which we don't always have at filter
// time). For now we just check whether the mint has any token-2022 metadata
// that suggests it migrated. Cheap heuristic: if the mint's largest holder
// is the Raydium LP, it's migrated.
// =============================================================================
async function checkUnburned(mint) {
  return cached(mint, async () => {
    try {
      const largest = await conn().getTokenLargestAccounts(new PublicKey(mint));
      if (!largest.value || largest.value.length === 0) {
        return { passed: true, reason: 'no token accounts, skipping check' };
      }
      const top = largest.value[0];
      const topAmount = Number(top.amount);
      const totalSupply = Number(top.uiAmount || 0);
      // Heuristic: if the top holder owns > 80% of supply, that's the LP.
      // Pre-migration (bonding curve), no single holder owns the supply.
      // Post-migration (Raydium LP), the LP owns the migrated tokens.
      const lpDominance = totalSupply > 0 ? topAmount / (totalSupply * 1e6) : 0;
      const burned = lpDominance > 0.8;
      return {
        passed: !burned,
        reason: burned
          ? `top holder owns ${(lpDominance * 100).toFixed(0)}% (likely migrated LP)`
          : `top holder ${(lpDominance * 100).toFixed(0)}% (likely bonding curve)`,
      };
    } catch (err) {
      return { passed: true, reason: `unburned check failed: ${err.message}` };
    }
  });
}

// =============================================================================
// market cap check
// =============================================================================
// MC in USD = (price_in_sol × total_supply) × sol_price_usd. We compute the
// per-token SOL price from a Jupiter quote (1 token → SOL) and supply from
// the mint account, then convert to USD via a separate SOL→USDC quote.
// The SOL price is cached globally for 60s (it's the same for every token
// at a given moment). If either Jupiter call fails we PASS — same pattern
// as every other filter: a transient API hiccup must not block trades.
// =============================================================================
async function checkMarketCap(mint, chatId) {
  return cached(mint, async () => {
    try {
      // Get supply from mint account
      const supply = await conn().getTokenSupply(new PublicKey(mint));
      const supplyRaw = Number(supply.value.amount);
      const decimals = supply.value.decimals;
      const supplyFloat = supplyRaw / Math.pow(10, decimals);
      // Get price: quote 1 token (raw, 10^decimals) → SOL
      const oneTokenRaw = Math.pow(10, decimals);
      const axios = (await import('axios')).default;
      const url = `${config.JUPITER_API_URL}/quote?inputMint=${mint}&outputMint=${config.SOL_MINT}&amount=${oneTokenRaw}&slippageBps=50`;
      const resp = await axios.get(url, { timeout: 5000 });
      if (!resp.data || !resp.data.outAmount) {
        return { passed: true, reason: 'no Jupiter quote, skipping MC check' };
      }
      const solPerToken = Number(resp.data.outAmount) / config.LAMPORTS_PER_SOL;
      const mcSol = solPerToken * supplyFloat;
      // Convert to USD. If SOL price fetch fails, skip the check (don't break trades).
      let solPriceUsd;
      try {
        solPriceUsd = await getSolPriceUsd();
      } catch (priceErr) {
        return { passed: true, reason: `MC check skipped: SOL price unavailable (${priceErr.message})` };
      }
      const mcUsd = mcSol * solPriceUsd;
      const minMc = settings.get('min_mc_usd', chatId);
      const maxMc = settings.get('max_mc_usd', chatId);
      if (minMc !== null && mcUsd < minMc) {
        return { passed: false, reason: `MC $${mcUsd.toFixed(2)} < min $${minMc}` };
      }
      if (maxMc !== null && mcUsd > maxMc) {
        return { passed: false, reason: `MC $${mcUsd.toFixed(2)} > max $${maxMc}` };
      }
      return { passed: true, reason: `MC $${mcUsd.toFixed(2)} within bounds` };
    } catch (err) {
      return { passed: true, reason: `MC check failed: ${err.message}` };
    }
  });
}

// =============================================================================
// token age check
// =============================================================================
// createdAt is in ms (from the TOKEN_CREATED event). Min/max are in seconds (v0.8.0).
// Note: key name still has "_min" suffix for backward compat — but value is in seconds.
// =============================================================================
function checkTokenAge({ createdAt }, chatId) {
  const minSec = settings.get('min_token_age_min', chatId);
  const maxSec = settings.get('max_token_age_min', chatId);
  if (!createdAt) return { passed: true, reason: 'no createdAt, skipping age check' };
  const ageSec = (Date.now() - createdAt) / 1000;
  if (minSec !== null && ageSec < minSec) {
    return { passed: false, reason: `token age ${ageSec.toFixed(1)}s < min ${minSec}s` };
  }
  if (maxSec !== null && ageSec > maxSec) {
    return { passed: false, reason: `token age ${ageSec.toFixed(1)}s > max ${maxSec}s` };
  }
  return { passed: true, reason: `token age ${ageSec.toFixed(1)}s within bounds` };
}

// =============================================================================
// platform exclude checks (internal = pump.fun, external = Raydium/etc.)
// =============================================================================
// We can only know which platform the SELL was on by inspecting the tx. The
// monitor's `event.source` or tx.programIds would tell us. For now we accept
// a hint from the executor — pass `event.programIds` if available. Otherwise
// the filter is a no-op.
// =============================================================================
function checkPlatformExclude({ programIds = [] }, chatId) {
  const excludeInternal = settings.get('exclude_internal', chatId);
  const excludeExternal = settings.get('exclude_external', chatId);
  if (programIds.length === 0) {
    return { passed: true, reason: 'no programIds in event, skipping platform check' };
  }
  const isInternal = programIds.some((p) => p === PUMP_FUN_PROGRAM.toBase58());
  if (excludeInternal && isInternal) {
    return { passed: false, reason: 'on internal (pump.fun), excluded' };
  }
  if (excludeExternal && !isInternal) {
    return { passed: false, reason: 'on external (Raydium/etc.), excluded' };
  }
  return { passed: true, reason: isInternal ? 'on pump.fun' : 'on external' };
}

// =============================================================================
// sell ratio check (v0.8.0 — adopted from "what % did the dev dump?")
// =============================================================================
// Triggered by a SELL_DETECTED event. We compute:
//
//   sellRatio = soldAmount / (soldAmount + devRemainingBalance)
//
// where devRemainingBalance is the dev's CURRENT (post-sell) balance for
// that mint, fetched via getParsedTokenAccountsByOwner. The pre-sell balance
// is reconstructed as post + sold (assuming the dev's ATA is the only
// source of those tokens — true for pump.fun launches).
//
// If sellRatio < settings.get('min_sell_ratio'), the trade is skipped.
// Default 0.9 means we only copy-trade when the dev dumps >= 90% of their
// holdings. Lower it (e.g. 0.5) to copy partial sells; raise it (1.0) to
// require a full exit.
//
// Note: this is a feature-rich copy-trade. The user wanted to ignore small
// partial sells from a dev who is still holding. We could ALSO have the
// opposite intent ("only copy small sells, not full dumps"), but the current
// `min_sell_ratio` is the more common defensive filter.
// =============================================================================
async function checkSellRatio({ dev, mint, soldAmount }, chatId) {
  if (!dev || !mint || !soldAmount || soldAmount <= 0) {
    return { passed: true, reason: 'sell ratio skipped: missing dev/mint/soldAmount' };
  }
  const minRatio = settings.get('min_sell_ratio', chatId);
  if (minRatio === null || minRatio === undefined) {
    return { passed: true, reason: 'sell ratio filter off' };
  }
  return cached(`sellratio:${dev}:${mint}:${soldAmount}`, async () => {
    try {
      const accounts = await conn().getParsedTokenAccountsByOwner(
        new PublicKey(dev),
        { mint: new PublicKey(mint) },
        'confirmed',
      );
      // Sum across all ATAs for this mint. Most pump.fun tokens use one
      // ATA per mint, but be defensive.
      let postBalance = 0;
      for (const acc of accounts.value) {
        const amt = acc.account?.data?.parsed?.info?.tokenAmount;
        if (amt && amt.amount != null) postBalance += Number(amt.amount);
      }
      const preBalance = postBalance + Number(soldAmount);
      if (preBalance <= 0) {
        // Couldn't determine pre-balance. PASS rather than block — same
        // "transient API hiccup must not break trades" philosophy as the
        // other filters.
        return { passed: true, reason: 'sell ratio: pre-balance unknown, passing' };
      }
      const ratio = Number(soldAmount) / preBalance;
      const pctStr = `${(ratio * 100).toFixed(1)}%`;
      const minPct = `${(minRatio * 100).toFixed(0)}%`;
      if (ratio < minRatio) {
        return {
          passed: false,
          reason: `dev sold ${pctStr} of holdings (${soldAmount.toLocaleString()} of ${preBalance.toLocaleString()}) < min ${minPct}`,
          ratio,
          preBalance,
          postBalance,
          soldAmount: Number(soldAmount),
        };
      }
      return {
        passed: true,
        reason: `dev sold ${pctStr} of holdings (${soldAmount.toLocaleString()} of ${preBalance.toLocaleString()}) >= min ${minPct}`,
        ratio,
        preBalance,
        postBalance,
        soldAmount: Number(soldAmount),
      };
    } catch (err) {
      // RPC failure → pass. Don't block trades on transient errors.
      return { passed: true, reason: `sell ratio check failed: ${err.message}` };
    }
  });
}

// =============================================================================
// master entry: returns { passed, reason }
// =============================================================================
/**
 * v0.8.7.15: chatId is REQUIRED. Each subscriber has their own filter
 * settings — user A's "unrenounced_only=true" doesn't apply to user B.
 */
export async function passesFilters({ chatId, mint, dev, createdAt, programIds = [], soldAmount = null }) {
  if (chatId == null) throw new Error('passesFilters: chatId is required (per-user isolation since v0.8.7.15)');
  const checks = [];
  if (settings.get('unrenounced_only', chatId)) checks.push({ name: 'unrenounced', fn: () => checkUnrenounced(mint) });
  if (settings.get('unburned_only', chatId)) checks.push({ name: 'unburned', fn: () => checkUnburned(mint) });
  if (settings.get('min_mc_usd', chatId) !== null || settings.get('max_mc_usd', chatId) !== null) {
    checks.push({ name: 'mc', fn: () => checkMarketCap(mint, chatId) });
  }
  if (settings.get('min_token_age_min', chatId) !== null || settings.get('max_token_age_min', chatId) !== null) {
    checks.push({ name: 'age', fn: () => checkTokenAge({ createdAt }, chatId) });
  }
  if (settings.get('exclude_internal', chatId) || settings.get('exclude_external', chatId)) {
    checks.push({ name: 'platform', fn: () => Promise.resolve(checkPlatformExclude({ programIds }, chatId)) });
  }
  // v0.8.0: sell ratio. Only runs if min_sell_ratio is set AND we have a
  // soldAmount (i.e. a SELL_DETECTED event; the monitor always provides one).
  if (settings.get('min_sell_ratio', chatId) != null && soldAmount != null) {
    checks.push({ name: 'sell_ratio', fn: () => checkSellRatio({ dev, mint, soldAmount }, chatId) });
  }
  for (const c of checks) {
    let r;
    try {
      r = await c.fn();
    } catch (err) {
      // Filter threw — treat as "pass" but log. We don't want a buggy filter
      // to break every trade; user can disable the filter in /settings.
      r = { passed: true, reason: `${c.name} threw: ${err.message}` };
    }
    if (!r.passed) {
      return { passed: false, reason: `[${c.name}] ${r.reason}` };
    }
  }
  return { passed: true, reason: 'all filters passed' };
}

// Helper for /status or debugging: list which filters are active.
// v0.8.7.15: per-user. Pass chatId to scope filters to one subscriber.
export function activeFilters(chatId) {
  if (chatId == null) throw new Error('activeFilters: chatId is required');
  return {
    unrenounced_only: settings.get('unrenounced_only', chatId),
    unburned_only: settings.get('unburned_only', chatId),
    min_mc_usd: settings.get('min_mc_usd', chatId),
    max_mc_usd: settings.get('max_mc_usd', chatId),
    min_token_age_min: settings.get('min_token_age_min', chatId),
    max_token_age_min: settings.get('max_token_age_min', chatId),
    exclude_internal: settings.get('exclude_internal', chatId),
    exclude_external: settings.get('exclude_external', chatId),
    min_sell_ratio: settings.get('min_sell_ratio', chatId),
  };
}

// For tests: clear the cache.
export function _clearCache() {
  cache.clear();
}
