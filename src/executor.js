// src/executor.js
// =============================================================================
// The copy-trade execution engine. One method: `executeSignal(event)`.
//
// Flow when a SELL_DETECTED event arrives:
//   1. Guard the trade (DRY_RUN / cap / daily loss / pause).
//   2. Look up the dev's last-created token for this mint (we keep an
//      in-memory map from TOKEN_CREATED events).
//   3. Quote SOL → token (buy).
//   4. Sign and submit the swap transaction.
//   5. Wait HOLD_MS (default 1000).
//   6. Get current token balance (for sell amount).
//   7. Quote token → SOL (sell).
//   8. Sign and submit the swap transaction.
//   9. Log the closed position with PnL.
//
// In DRY_RUN mode, every step is logged but no transaction is signed or
// submitted. The user sees exactly what would have happened.
// =============================================================================

import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import config from './config.js';
import { guardTrade } from './safety.js';
import { positionsDb, signalsDb, walletsDb } from './db.js';
import { getBuyQuote, getSellQuote, buildSwapTransaction, effectiveJupiterUrl } from './jupiterMetis.js';
import * as settings from './settings.js';
import { passesFilters, activeFilters } from './filters.js';
import { walletManager } from './walletManager.js';

let connection = null;
let botKeypair = null;
const tokenMintByDev = new Map(); // devWallet -> Map<mint, createdAt> most recent first

export function initExecutor() {
  connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  if (!config.DRY_RUN) {
    // LIVE mode: try to load the encrypted wallet. If the user hasn't set
    // one via /wallet yet, log a clear warning and continue — the bot will
    // fail at submitSwap time with a readable error. (We don't want to
    // crash at boot just because the user hasn't configured the key.)
    if (walletManager.hasKey()) {
      try {
        botKeypair = walletManager.getKeypair();
        const s = walletManager.getStatus();
        console.log(`[executor] LIVE mode — bot wallet: ...${s.last4} (set ${new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ')}Z)`);
      } catch (err) {
        console.error(`[executor] LIVE mode — failed to load encrypted wallet: ${err.message}`);
        console.error(`[executor] Set a new wallet via /start → 🔑 Wallet, or remove the wallet and re-add it.`);
        botKeypair = null;
      }
    } else {
      console.warn('[executor] LIVE mode — no wallet set. Use /start → 🔑 Wallet to set one. Bot will fail at first trade.');
    }
  } else {
    console.log('[executor] DRY_RUN mode — no transactions will be signed');
  }
}

export function recordTokenCreated({ dev, mint, timestamp }) {
  if (!tokenMintByDev.has(dev)) tokenMintByDev.set(dev, new Map());
  tokenMintByDev.get(dev).set(mint, timestamp);
}

function isRecentToken({ dev, mint, maxAgeMs = 24 * 3600 * 1000 }) {
  const m = tokenMintByDev.get(dev)?.get(mint);
  if (!m) return false;
  return Date.now() - m < maxAgeMs;
}

function logStep(label, data) {
  console.log(`[executor] ${label}`, JSON.stringify(data));
}

// =============================================================================
// Time window check (UTC)
// =============================================================================
// Returns true if current UTC time is between start_time and end_time.
// Handles wrap-around (e.g. 22:00 → 06:00 = active overnight).
// =============================================================================
function isWithinTradingHours() {
  const start = settings.get('start_time') || '00:00';
  const end = settings.get('end_time') || '23:59';
  const now = new Date();
  const curMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return true; // window collapsed = always active
  if (startMin < endMin) {
    return curMin >= startMin && curMin <= endMin;
  }
  // Wrap-around (e.g. 22:00 → 06:00)
  return curMin >= startMin || curMin <= endMin;
}

// =============================================================================
// Retry wrapper
// =============================================================================
// Submits a swap up to N+1 times on transient errors (429, 5xx, network).
// Returns the first successful result. If all retries fail, returns null
// so the caller can fail the position with the last error.
// =============================================================================
async function submitSwapWithRetry({ quoteResponse, label, maxAttempts = 0 }) {
  const attempts = Math.max(1, (maxAttempts || 0) + 1);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await submitSwap({ quoteResponse, label });
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const transient = /429|5\d\d|ETIMEDOUT|ECONNRESET|network|fetch failed|timeout/i.test(msg);
      if (!transient || i === attempts - 1) throw err;
      // Exponential-ish backoff: 500ms, 1500ms, 3000ms...
      const delay = 500 * Math.pow(3, i);
      logStep(`${label}:RETRY`, { attempt: i + 1, err: msg, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function submitSwap({ quoteResponse, label }) {
  if (config.DRY_RUN) {
    logStep(`${label}:DRY_RUN`, { inputAmount: quoteResponse?.inAmount, outputAmount: quoteResponse?.outAmount });
    return { signature: 'DRY_RUN_' + Date.now(), simulated: true };
  }
  if (!botKeypair) {
    // No wallet set (or decryption failed) — fail loudly with a clear hint.
    // The user can /start → 🔑 Wallet to set one without restarting the bot.
    throw new Error(
      'No trading wallet loaded. Use /start → 🔑 Wallet in Telegram to set one. ' +
      '(The wallet is encrypted at rest; you do NOT need to add BOT_WALLET_PRIVATE_KEY to .env.)'
    );
  }
  const txB64 = await buildSwapTransaction({
    quoteResponse,
    userPublicKey: botKeypair.publicKey.toBase58(),
  });
  if (!txB64) throw new Error(`buildSwapTransaction returned null for ${label}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([botKeypair]);
  const signature = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: true });
  // Wait for confirmation with a 30s budget.
  const latest = await connection.confirmTransaction(signature, 'confirmed');
  if (latest.value?.err) {
    throw new Error(`${label} tx failed on-chain: ${JSON.stringify(latest.value.err)}`);
  }
  return { signature, simulated: false };
}

/**
 * Main entry point. Called by index.js for every event the monitor emits.
 * Only acts on SELL_DETECTED. Logs but ignores everything else.
 */
export async function executeSignal(event) {
  if (event.type === 'TOKEN_CREATED') {
    recordTokenCreated(event);
    return;
  }
  if (event.type !== 'SELL_DETECTED') return;

  const { wallet: dev, mint, solReceived, signature: devSellSig } = event;

  // v0.7.0 (06-15): user override — any watched wallet sell = buy trigger.
  // Skip isRecentToken check; we don't care if it's our token, a recent
  // launch, or a random token the wallet is dumping.
  logStep('SIGNAL_ACCEPTED', { dev, mint });

  // ---- Time window gate (UTC) ----
  if (!isWithinTradingHours()) {
    logStep('SKIP_OUTSIDE_HOURS', {
      dev,
      mint,
      now: new Date().toISOString().slice(11, 16),
      window: `${settings.get('start_time')}-${settings.get('end_time')} UTC`,
    });
    signalsDb.log({ type: 'OUT_OF_HOURS', wallet: dev, mint, data: { event } });
    return;
  }

  // ---- Filter gate (opt-in on-chain checks) ----
  const createdAt = tokenMintByDev.get(dev)?.get(mint);
  const filterResult = await passesFilters({
    mint,
    dev,
    createdAt,
    programIds: event.programIds || [],
  });
  if (!filterResult.passed) {
    logStep('SKIP_FILTER', { mint, reason: filterResult.reason });
    signalsDb.log({ type: 'FILTERED', wallet: dev, mint, data: { reason: filterResult.reason } });
    return;
  }

  // ---- Read trade params from settings (mutable at runtime) ----
  const solAmount = settings.get('fixed_buy_sol');
  const slippageBps = settings.get('slippage_bps');
  const pumpSlippageBps = settings.get('pump_slippage_bps');
  const holdMs = settings.get('hold_ms');
  const autoSell = settings.get('auto_sell');
  const autoRetry = settings.get('auto_retry');

  const guard = guardTrade({ solAmount, mint });
  if (!guard.allowed) {
    logStep('TRADE_DENIED', { reason: guard.reason });
    signalsDb.log({ type: 'BUY_DENIED', wallet: dev, mint, data: { reason: guard.reason } });
    return;
  }

  // ----- BUY -----
  const buyQuote = await getBuyQuote({ solAmount, outputMint: mint, slippageBps });
  if (!buyQuote || buyQuote.error) {
    logStep('BUY_QUOTE_FAILED', { error: buyQuote?.error });
    return;
  }
  const tokensExpected = Number(buyQuote.outAmount);
  logStep('BUY_QUOTE_OK', {
    dev,
    mint,
    solIn: solAmount,
    tokensOut: tokensExpected,
    slippageBps,
  });

  // Open position row FIRST, then submit, then update on success.
  const posRes = positionsDb.open({
    mint,
    devWallet: dev,
    entrySig: null, // filled below
    entrySol: solAmount,
    entryTokens: tokensExpected,
  });
  const positionId = posRes.lastInsertRowid;

  let buyResult;
  try {
    buyResult = await submitSwapWithRetry({ quoteResponse: buyQuote, label: 'BUY', maxAttempts: autoRetry });
  } catch (err) {
    positionsDb.fail(positionId, `buy: ${err.message}`);
    logStep('BUY_FAILED', { error: err.message });
    return;
  }
  signalsDb.log({
    type: 'BUY',
    wallet: botKeypair?.publicKey?.toBase58() || 'DRY_RUN',
    mint,
    data: { solSpent: solAmount, tokensExpected, tx: buyResult.signature, slippageBps },
  });
  // v0.6.0: bump this wallet's copy_count + last_copy_at (atomic).
  // We do this AFTER signalsDb.log so a DB failure on stats doesn't lose the
  // signal. If the wallet was removed mid-trade, markCopied returns 0 — fine.
  const updated = walletsDb.markCopied(dev);
  const newStats = walletsDb.getStats(dev);
  logStep('WALLET_STATS_BUMPED', { dev, updated, copyCount: newStats?.copy_count ?? 'n/a' });
  logStep('BUY_OK', { signature: buyResult.signature, simulated: buyResult.simulated });

  // ----- HOLD -----
  await new Promise((r) => setTimeout(r, holdMs));
  logStep('HOLD_DONE', { heldMs: holdMs });

  // ----- AUTO-SELL gate -----
  if (!autoSell) {
    // Skip the sell leg. Position stays OPEN until the user manually closes
    // it (future feature) or it ages out. We log so the user knows.
    logStep('SELL_SKIPPED_AUTO_OFF', { positionId, mint });
    signalsDb.log({ type: 'AUTO_SELL_OFF', wallet: dev, mint, data: { positionId } });
    return;
  }

  // ----- SELL -----
  // In dry-run, pretend we have the expected tokens. In live, we don't fetch
  // the balance here to save an RPC call — we use the quote's outAmount as the
  // sell amount. (For SPL tokens with decimals, the quote uses raw units too,
  // so this is consistent.)
  const tokensToSell = tokensExpected;
  const sellQuote = await getSellQuote({ tokenRawAmount: tokensToSell, inputMint: mint, slippageBps });
  if (!sellQuote || sellQuote.error) {
    positionsDb.fail(positionId, `sell quote: ${sellQuote?.error || 'no quote'}`);
    logStep('SELL_QUOTE_FAILED', { error: sellQuote?.error });
    return;
  }
  const solExpected = Number(sellQuote.outAmount) / config.LAMPORTS_PER_SOL;
  logStep('SELL_QUOTE_OK', { tokensIn: tokensToSell, solOut: solExpected });

  let sellResult;
  try {
    sellResult = await submitSwapWithRetry({ quoteResponse: sellQuote, label: 'SELL', maxAttempts: autoRetry });
  } catch (err) {
    positionsDb.fail(positionId, `sell: ${err.message}`);
    logStep('SELL_FAILED', { error: err.message });
    return;
  }
  const pnl = solExpected - solAmount;
  positionsDb.close(positionId, {
    exitSig: sellResult.signature,
    exitSol: solExpected,
    pnlSol: pnl,
  });
  signalsDb.log({
    type: 'SELL',
    wallet: botKeypair?.publicKey?.toBase58() || 'DRY_RUN',
    mint,
    data: { solReceived: solExpected, tx: sellResult.signature },
  });
  logStep('SELL_OK', { signature: sellResult.signature, pnl, simulated: sellResult.simulated });
}

/**
 * Return executor status (for /status command).
 */
export function status() {
  const w = walletManager.getStatus();
  return {
    mode: config.DRY_RUN ? 'DRY_RUN' : 'LIVE',
    botWallet: w.set
      ? `${w.address.slice(0, 4)}…${w.address.slice(-4)} (last 4: ${w.last4})`
      : 'NOT SET — /start → 🔑 Wallet',
    rpc: config.SOLANA_RPC_URL,
    jupiterUrl: config.JUPITER_API_URL,
    effectiveJupiterUrl: effectiveJupiterUrl(),
    trackedMints: Array.from(tokenMintByDev.values()).reduce((a, m) => a + m.size, 0),
    activeFilters: activeFilters(),
  };
}
