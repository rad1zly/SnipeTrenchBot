// src/jitoTip.js
// =============================================================================
// Jito tip support (legacy wrapper around tipLanes).
//
// v0.8.8 (experimental) M4.0: TIP ROUTING IS NOW MULTI-LANE.
// jitoTip.js is kept as a thin back-compat shim around `src/tipLanes.js`.
// The new flow:
//   1. buildSwapTransaction appends a Jito-style tip ix (still uses the
//      Jito tip account by default — all 4 lanes accept it).
//   2. executor.submitSwap hands the SIGNED tx to
//      `tipLanes.submitFastTrack`, which tries the primary lane first
//      (default jito) then fallbacks (helius, 0slot, astralane).
//
// 4 lanes, configurable via env:
//   TIP_LANE_PRIMARY=jito
//   TIP_LANE_FALLBACKS=helius,0slot,astralane
//   JITO_BUY_TIP_SOL=0.001   JITO_SELL_TIP_SOL=0.001
//
// Reference: https://docs.jito.wtf/lowlatencytxnsend/
// =============================================================================

import { PublicKey, SystemProgram } from '@solana/web3.js';
import config from './config.js';
import { buildLaneTipIx, getLaneOrder } from './tipLanes.js';

// Jito tip accounts (round-robin). Source: https://docs.jito.wtf/lowlatencytxnsend/
// Now ALSO used as the tip account for non-Jito lanes (all 4 lanes are
// Jito-compatible; the tip ix is the same).
const VERIFIED_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wV8RH1T5ELA4Q8B42K3d3S',
  'Cw8CFyM9EkoDy76U5Q9YY3pXTjLPgUaW7Y3HLL7n8GHe',
];

let _lastTipAccountIdx = 0;

/**
 * Pick a Jito tip account. Round-robin through the 3 verified accounts.
 * Future: random selection + on-error retry with next account.
 */
export function pickTipAccount() {
  const idx = _lastTipAccountIdx % VERIFIED_TIP_ACCOUNTS.length;
  _lastTipAccountIdx += 1;
  return new PublicKey(VERIFIED_TIP_ACCOUNTS[idx]);
}

/**
 * Build a Jito tip transfer instruction. Sends `tipSol` SOL from `payer` to
 * a Jito tip account. Caller must append this as the LAST instruction of
 * the transaction (Jito requires tip to be last).
 */
export function buildJitoTipIx(payer, tipSol) {
  if (!tipSol || tipSol <= 0) return null;
  const lamports = Math.floor(Number(tipSol) * 1e9);
  if (lamports < 1) return null;
  return SystemProgram.transfer({
    fromPubkey: new PublicKey(payer),
    toPubkey: pickTipAccount(),
    lamports,
  });
}

/**
 * Check whether Jito tip is configured for this side.
 * Returns the tip amount in SOL (0 if disabled / not configured).
 *
 * v0.8.8 (experimental) M1.20: tip is a fixed admin config from
 * `config.JITO_BUY_TIP_SOL` / `config.JITO_SELL_TIP_SOL` (env-driven).
 * Per-user settings (jito_buy_tip_sol / jito_sell_tip_sol) are no longer
 * honored — those catalog entries are hidden from the menu.
 *
 * v0.8.8 (experimental) M4.0: still uses Jito tip account because all 4
 * lanes (jito, helius, 0slot, astralane) are Jito-compatible. The
 * fallback is at the SUBMISSION level (tipLanes.submitFastTrack), not
 * the tip account level.
 */
export function getTipAmount(side, chatId) {
  // chatId is unused now but kept in the signature so callers / tests
  // don't break.
  void chatId;
  if (side === 'buy') return Number(config.JITO_BUY_TIP_SOL || 0);
  if (side === 'sell') return Number(config.JITO_SELL_TIP_SOL || 0);
  return 0;
}

/**
 * Convenience: append Jito tip instruction to an instructions array if
 * enabled. Returns true if a tip ix was added.
 */
export function appendTipIfEnabled(instructions, payer, side, chatId) {
  const tip = getTipAmount(side, chatId);
  if (tip <= 0) return false;
  // v0.8.8 M4.0: use the primary lane's tip ix (default jito). All 4
  // lanes are Jito-compatible — the tip account doesn't need to differ
  // for fallback to work.
  const primaryLane = (config.TIP_LANE_PRIMARY || 'jito').toLowerCase();
  const ix = buildLaneTipIx(primaryLane, payer, tip) || buildJitoTipIx(payer, tip);
  if (!ix) return false;
  instructions.push(ix);
  return true;
}

