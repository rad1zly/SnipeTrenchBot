// src/jitoTip.js
// =============================================================================
// Jito tip support (v0.8.8 experimental).
//
// Jito block engine accepts Solana transactions that include a tip to a Jito
// tip account. The validator gives them priority inclusion (faster landing,
// anti-sandwich). Reference: https://docs.jito.wtf/lowlatencytxnsend/
//
// Usage:
//   import { buildJitoTipIx, hasJitoTip } from './jitoTip.js';
//   if (hasJitoTip(chatId)) {
//     tx.add(buildJitoTipIx(payer, settings.get('jito_buy_tip_sol', chatId)));
//   }
//
// Jito has 8 rotating tip accounts. We pick one randomly per-tx so the
// validator distribution is fair. If the picked account is invalid (Jito
// changes accounts over time), the validator rejects the whole tx — fine
// because the executor's retry path will pick a different one next time.
// =============================================================================

import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import * as settings from './settings.js';

// Jito tip accounts (round-robin). Source: https://docs.jito.wtf/lowlatencytxnsend/
// v0.8.8: only the 3 verified (publicly documented) accounts are used.
// If/when Jito adds more active accounts, append them here after verifying
// with PublicKey() — invalid addresses throw and would break the round-robin.
const VERIFIED_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wV8RH1T5ELA4Q8B42K3d3S',
  'Cw8CFyM9EkoDy76U5Q9YY3pXTjLPgUaW7Y3HLL7n8GHe',
];

let _lastTipAccountIdx = 0;

/**
 * Pick a Jito tip account. Round-robin through the 4 verified accounts.
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
 * Check whether the user has enabled Jito tip for this side.
 * Returns the tip amount in SOL (0 if disabled).
 */
export function getTipAmount(side, chatId) {
  const key = side === 'buy' ? 'jito_buy_tip_sol' : 'jito_sell_tip_sol';
  if (chatId == null) return 0;
  return Number(settings.get(key, chatId) || 0);
}

/**
 * Convenience: append Jito tip instruction to an instructions array if
 * enabled. Returns true if a tip ix was added.
 */
export function appendTipIfEnabled(instructions, payer, side, chatId) {
  const tip = getTipAmount(side, chatId);
  if (tip <= 0) return false;
  const ix = buildJitoTipIx(payer, tip);
  if (!ix) return false;
  instructions.push(ix);
  return true;
}
