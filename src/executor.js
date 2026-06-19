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
// v0.8.0 (critical fix): get quotes + buildSwapTransaction from swapRouter.js
// (which auto-routes to pump.fun for pre-graduation tokens). The jupiterMetis
// versions are Jupiter-only and return raw quote objects, which would not
// destructure into { quote, route } — causing the executor to fail with
// 'no quote' even when a valid route exists. This was a wiring bug introduced
// when pump.fun direct swap was added (commit 159a770) — the new module was
// created but the executor import wasn't updated.
import { getBuyQuote, getSellQuote, buildSwapTransaction } from './swapRouter.js';
import { effectiveJupiterUrl } from './jupiterMetis.js';
import notifier from './notifier.js';
import * as settings from './settings.js';
import { passesFilters, activeFilters } from './filters.js';
import { walletManager } from './walletManager.js';

let connection = null;
// v0.7.0: per-user keypair cache. Keyed by chat_id. Loaded on first use,
// evicted on error so the next attempt re-decrypts from DB. Plaintext never
// leaves this Map; we don't share with the global module scope.
const keypairByChatId = new Map();
const tokenMintByDev = new Map(); // devWallet -> Map<mint, createdAt> most recent first

export function initExecutor() {
  connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  if (config.DRY_RUN) {
    console.log('[executor] DRY_RUN mode — no transactions will be signed');
  } else {
    console.log('[executor] LIVE mode — keypairs loaded on demand per user (v0.7.0+)');
  }
}

/**
 * Load (or fetch from cache) the Keypair for a single user. v0.7.0+ —
 * each Telegram subscriber has their own trading wallet. Live mode would
 * only need this when actually submitting a transaction; DRY_RUN skips it
 * entirely. Throws if the user has no wallet set.
 */
function getKeypairFor(chatId) {
  if (chatId == null) throw new Error('executor: missing chatId — cannot load keypair');
  if (config.DRY_RUN) return null; // never used in DRY_RUN
  const cached = keypairByChatId.get(chatId);
  if (cached) return cached;
  const kp = walletManager.getKeypair(chatId);
  keypairByChatId.set(chatId, kp);
  return kp;
}

/**
 * Drop a user's keypair from the in-memory cache (e.g. on a "remove wallet"
 * event from Telegram). Next trade attempt re-decrypts.
 */
export function evictKeypair(chatId) {
  if (chatId == null) return;
  keypairByChatId.delete(chatId);
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
async function submitSwapWithRetry({ quoteResponse, label, maxAttempts = 0, chatId, route = 'jupiter', side = null }) {
  const attempts = Math.max(1, (maxAttempts || 0) + 1);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // v0.8.2: forward route + side so the builder uses the right program
      // (pumpfun vs jupiter). Without these, swapRouter falls through to
      // Jupiter for everything — including pump.fun pre-graduation tokens,
      // which Helius then 422s because the referenced accounts don't exist.
      return await submitSwap({ quoteResponse, label, chatId, route, side });
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

async function submitSwap({ quoteResponse, label, chatId, route = 'jupiter', side = null }) {
  if (config.DRY_RUN) {
    logStep(`${label}:DRY_RUN`, { inputAmount: quoteResponse?.inAmount, outputAmount: quoteResponse?.outAmount });
    return { signature: 'DRY_RUN_' + Date.now(), simulated: true };
  }
  // v0.7.0: per-user keypair. chatId identifies the wallet owner.
  const kp = getKeypairFor(chatId);
  if (!kp) {
    // No wallet set for this user — fail loudly with a clear hint.
    // The user can /start → 🔑 Wallet to set one without restarting the bot.
    throw new Error(
      `No trading wallet set for this account (chatId=${chatId}). ` +
        'Use /start → 🔑 Wallet in Telegram to set one. ' +
        '(The wallet is encrypted at rest; you do NOT need to add BOT_WALLET_PRIVATE_KEY to .env.)'
    );
  }
  // v0.8.2: pass route + side so the right builder is used.
  // Before this, route was undefined and swapRouter always fell through to
  // Jupiter, even for pump.fun pre-graduation tokens (→ Helius 422).
  const txB64 = await buildSwapTransaction({
    quoteResponse,
    userPublicKey: kp.publicKey.toBase58(),
    route,
    side,
  });
  if (!txB64) throw new Error(`buildSwapTransaction returned null for ${label}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([kp]);
  // v0.8.0 (speed): 'processed' commitment for send (single slot ~400ms).
  // skipPreflight: true saves ~200ms by skipping simulate step.
  // Trade-off: 'processed' can be re-org'd, but we sell within 1s anyway.
  // v0.8.1: use sendRawTransaction to bypass Helius sendTransaction's
  // pre-validation (simulateTransaction → 422 AccountNotFound for PDAs
  // that don't exist yet, e.g. bonding-curve-v2, user-volume-accumulator).
  // sendRawTransaction skips simulation and submits directly.
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: 'processed',
  });
  // v0.8.0 (speed): poll for 'processed' (1 slot, ~400ms) instead of 'confirmed'.
  // 'processed' is enough for our 1s hold — if buy reorgs, sell won't fire.
  // Fallback: bump to 'confirmed' if 'processed' doesn't land in 1.5s.
  // v0.8.3: searchTransactionHistory=true (was false) so we find old txs in
  // the node's history cache — important for failed txs that drop out of
  // the recent status cache quickly. Also widen the budget to 2.5s.
  const pollStart = Date.now();
  const POLL_BUDGET_MS = 2500;
  let status = null;
  while (Date.now() - pollStart < POLL_BUDGET_MS) {
    const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    status = r?.value?.[0];
    if (status) {
      if (status.err) {
        throw new Error(`${label} tx failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'processed' || status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { signature, simulated: false, landedIn: Date.now() - pollStart };
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // v0.8.3: budget exhausted — don't blindly proceed. Do one last
  // getTransaction (returns err if tx failed on-chain even if it's not
  // in the recent status cache). This is the safety net for the case
  // observed 2026-06-19 07:05Z where Helius's status cache was slow and
  // the bot reported BUY_OK on a tx that actually failed with 3012.
  try {
    const last = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (last?.meta?.err) {
      throw new Error(`${label} tx failed on-chain (late check): ${JSON.stringify(last.meta.err)}`);
    }
  } catch (e) {
    if (e.message.includes('tx failed on-chain')) throw e;
    // Network error on the late check — log but accept as best-effort.
    console.warn(`[executor] ${label} late status check failed for ${signature.slice(0,8)}...: ${e.message}`);
  }
  console.warn(`[executor] ${label} signature ${signature.slice(0,8)}... no processed status in ${POLL_BUDGET_MS}ms; proceeding`);
  return { signature, simulated: false, landedIn: POLL_BUDGET_MS };
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
  // v0.7.0: per-user keypair. chatId is set by the helius monitor from the
  // watched_wallets row, identifying which Telegram subscriber added this
  // dev wallet. The executor uses it to look up that user's trading wallet
  // for the buy/sell leg, and to route notifier messages back to them only.
  const chatId = event.chatId;

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
    soldAmount: event.tokenSent ?? null,   // v0.8.0: sell-ratio filter
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
  const { quote: buyQuote, route: buyRoute } = await getBuyQuote({ solAmount, outputMint: mint, slippageBps });
  if (!buyQuote || buyQuote.error) {
    logStep('BUY_QUOTE_FAILED', { error: buyQuote?.error });
    notifier.tradeFailed({ stage: 'BUY_QUOTE', mint, error: buyQuote?.error || 'no quote', chatId, solAmount }).catch(() => {});
    return;
  }
  const tokensExpected = Number(buyQuote.outAmount);
  logStep('BUY_ROUTE', { route: buyRoute, mint });
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
    buyResult = await submitSwapWithRetry({ quoteResponse: buyQuote, label: 'BUY', maxAttempts: autoRetry, chatId, route: buyRoute, side: 'buy' });
  } catch (err) {
    positionsDb.fail(positionId, `buy: ${err.message}`);
    logStep('BUY_FAILED', { error: err.message });
    notifier.tradeFailed({ stage: 'BUY', mint, error: err.message, chatId, solAmount }).catch(() => {});
    return;
  }
  // v0.7.0: log the USER's trading wallet (not a global one).
  const buyerWallet = config.DRY_RUN
    ? 'DRY_RUN'
    : (keypairByChatId.get(chatId)?.publicKey?.toBase58() ?? 'UNKNOWN');
  signalsDb.log({
    type: 'BUY',
    wallet: buyerWallet,
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
  notifier.tradeStep({
    step: 'BUY_OK',
    mint,
    wallet: dev,
    chatId, // v0.7.0: route to wallet owner
    details: {
      sig: buyResult.signature ? `${buyResult.signature.slice(0, 4)}…${buyResult.signature.slice(-4)}` : 'DRY_RUN',
      simulated: buyResult.simulated ? 'yes' : 'no',
      solSpent: solAmount.toFixed(6),
      tokensExpected,
    },
  }).catch((e) => console.error('[executor] notifier BUY_OK failed:', e.message));

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
  const { quote: sellQuote, route: sellRoute } = await getSellQuote({ tokenRawAmount: tokensToSell, inputMint: mint, slippageBps });
  if (!sellQuote || sellQuote.error) {
    positionsDb.fail(positionId, `sell quote: ${sellQuote?.error || 'no quote'}`);
    logStep('SELL_QUOTE_FAILED', { error: sellQuote?.error });
    notifier.tradeFailed({ stage: 'SELL_QUOTE', mint, error: sellQuote?.error || 'no quote', chatId, solAmount: solAmount }).catch(() => {});
    return;
  }
  const solExpected = Number(sellQuote.outAmount) / config.LAMPORTS_PER_SOL;
  logStep('SELL_QUOTE_OK', { tokensIn: tokensToSell, solOut: solExpected });

  let sellResult;
  try {
    sellResult = await submitSwapWithRetry({ quoteResponse: sellQuote, label: 'SELL', maxAttempts: autoRetry, chatId, route: sellRoute, side: 'sell' });
  } catch (err) {
    positionsDb.fail(positionId, `sell: ${err.message}`);
    logStep('SELL_FAILED', { error: err.message });
    notifier.tradeFailed({ stage: 'SELL', mint, error: err.message, chatId, solAmount }).catch(() => {});
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
    wallet: buyerWallet,
    mint,
    data: { solReceived: solExpected, tx: sellResult.signature },
  });
  logStep('SELL_OK', { signature: sellResult.signature, pnl, simulated: sellResult.simulated });
  notifier.tradeClosed({
    mint,
    wallet: dev,
    chatId, // v0.7.0: route to wallet owner
    entrySol: solAmount,
    exitSol: solExpected,
    pnl,
    holdMs,
  }).catch((e) => console.error('[executor] notifier SELL_OK failed:', e.message));
}

/**
 * Return executor status (for /status command). Per-user in v0.7.0: shows the
 * caller's own wallet, not a global one.
 */
export function status(chatId = null) {
  const w = walletManager.getStatus(chatId);
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
