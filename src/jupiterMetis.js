// src/jupiterMetis.js
// =============================================================================
// Jupiter Swap API client. Works with three endpoint styles via JUPITER_API_URL:
//   - Jupiter v6:        https://quote-api.jup.ag/v6
//   - Jupiter Swap v1:   https://api.jup.ag/swap/v1
//   - Jupiter Metis:     https://metis.jup.io  (MEV-protected, may need key)
//
// We intentionally use the GET/POST shape that all three endpoints accept.
// If you point JUPITER_API_URL at Metis, requests get routed through MEV-
// protected channels automatically.
//
// Two operations:
//   - getQuote(inputMint, outputMint, amount, slippageBps): { inputMint, ... }
//   - buildSwapTransaction(quoteResponse, userPublicKey): base64 transaction
//
// Submission to the network is done by the executor (which has the Keypair
// for signing). This module deliberately does NOT hold keys.
// =============================================================================

import axios from 'axios';
import config from './config.js';
import * as settings from './settings.js';

const HEADERS = {
  'Content-Type': 'application/json',
  // Jupiter v6 public API doesn't need a key. Swap v1 / Metis may rate-limit
  // without one. Attach if configured.
  ...(config.JUPITER_API_KEY ? { 'x-api-key': config.JUPITER_API_KEY } : {}),
};

// Resolve the effective Jupiter URL — if anti_mev is on, swap to Metis on
// the fly. We cache the "original" so toggling anti_mev back off restores
// the user-configured endpoint.
let _originalUrl = null;
// v0.8.7.15: chatId is now REQUIRED for setting reads.anti_mev is per-user.
export function effectiveJupiterUrl(chatId) {
  if (settings.get('anti_mev', chatId)) {
    if (!_originalUrl) _originalUrl = config.JUPITER_API_URL;
    return 'https://metis.jup.io';
  }
  return config.JUPITER_API_URL;
}

/**
 * Normalize the base URL — strip trailing slash.
 */
function base(chatId) {
  return effectiveJupiterUrl(chatId).replace(/\/$/, '');
}

/**
 * Get a swap quote. Amount is in the smallest unit of the input mint
 * (lamports for SOL, raw units for SPL tokens).
 *
 * Returns the full quote object, or null on failure.
 */
export async function getQuote({ inputMint, outputMint, amount, slippageBps = config.SLIPPAGE_BPS, chatId = null }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`getQuote: amount must be > 0, got ${amount}`);
  }
  const url = `${base(chatId)}/quote`;
  const params = {
    inputMint,
    outputMint,
    amount: Math.floor(amount),
    slippageBps,
    // Wrap/unwrap SOL for buys — we always pay in SOL.
    wrapAndUnwrapSol: true,
  };
  try {
    const res = await axios.get(url, { params, headers: HEADERS, timeout: 10_000 });
    if (!res.data) return null;
    return res.data;
  } catch (err) {
    // Surface the error message but don't throw — caller decides what to do.
    return { error: err.response?.data?.error || err.message, status: err.response?.status };
  }
}

/**
 * Build a swap transaction from a quote response. Returns base64-encoded
 * transaction that the caller must deserialize, sign, and submit.
 *
 * For v6, the endpoint is /swap. For Swap v1, it's /swap-instructions. We
 * detect the host and use the matching one.
 */
export async function buildSwapTransaction({ quoteResponse, userPublicKey, chatId = null }) {
  const b = base(chatId);
  // v0.8.0 (audit): priority fee read from settings DB (buy_priority_fee_sol, in SOL).
  // v0.8.7.15: per-user — each subscriber has their own buy_priority_fee_sol.
  const _pfEnvLamports = Math.floor(Number(config.PRIORITY_FEE_MICROLAMPORTS || 0) / 1e3); // micro->lamports
  const _pfSolLamports = Math.floor(Number(settings.get('buy_priority_fee_sol', chatId) || 0) * 1e9); // SOL->lamports
  const prioritizationFeeLamports = _pfSolLamports > 0 ? _pfSolLamports : _pfEnvLamports;
  if (b.includes('/swap/v1')) {
    // New Swap API v1 — uses /swap to return a serialized transaction.
    const url = `${b}/swap`;
    const body = {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports,
    };
    const res = await axios.post(url, body, { headers: HEADERS, timeout: 15_000 });
    return res.data?.swapTransaction || null;
  }
  // v6 (default): POST /swap with the same body.
  const url = `${b}/swap`;
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    // v6 supports dynamicComputeUnitLimit too.
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports,
  };
  const res = await axios.post(url, body, { headers: HEADERS, timeout: 15_000 });
  return res.data?.swapTransaction || null;
}

/**
 * Helper: get a quote for buying a token with X SOL.
 * Returns the quote object or null. The quote contains the expected output
 * amount (in raw token units) which the caller can log.
 */
export async function getBuyQuote({ solAmount, outputMint, slippageBps = config.SLIPPAGE_BPS, chatId = null }) {
  const lamports = Math.floor(solAmount * config.LAMPORTS_PER_SOL);
  return getQuote({
    inputMint: config.SOL_MINT,
    outputMint,
    amount: lamports,
    slippageBps,
    chatId,
  });
}

/**
 * Helper: get a quote for selling X raw units of a token for SOL.
 */
export async function getSellQuote({ tokenRawAmount, inputMint, slippageBps = config.SLIPPAGE_BPS, chatId = null }) {
  return getQuote({
    inputMint,
    outputMint: config.SOL_MINT,
    amount: Math.floor(tokenRawAmount),
    slippageBps,
    chatId,
  });
}
