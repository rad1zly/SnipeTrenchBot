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

import { Keypair, Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
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
// v0.8.7.8: secondary Connection to public Solana RPC. Used for two things:
// 1. Cross-checking ghost-sig patterns (Helius returns sig without
//    broadcasting). If public RPC also has no status → true ghost.
// 2. Resubmitting the SAME signed tx bytes via a different RPC node when
//    Helius drops it. The tx is already signed; resubmitting via a healthy
//    node often broadcasts it successfully.
// Live failure 20 Jun 2026 10:50:23Z: Helius returned sig AyKqGVJD...
// but never broadcast. Public RPC confirmed null. Without dual-RPC the
// bot wasted 5.5s polling Helius for nothing.
const PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';
let publicConnection = null;
// v0.7.0: per-user keypair cache. Keyed by chat_id. Loaded on first use,
// evicted on error so the next attempt re-decrypts from DB. Plaintext never
// leaves this Map; we don't share with the global module scope.
const keypairByChatId = new Map();
const tokenMintByDev = new Map(); // devWallet -> Map<mint, createdAt> most recent first

export function initExecutor() {
  connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  publicConnection = new Connection(PUBLIC_RPC_URL, 'confirmed');
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
      // v0.8.7.4: tightened transient regex. Old `/5\d\d/` matched any
      // 3-digit number in the error message — including "5500" in
      // "after 5500ms" or a position id like "5500XXX". That made the
      // executor retry on non-transient "BUY tx NOT FOUND" errors and
      // waste a second tx fee. New regex requires the 5xx to come from
      // HTTP status code context (e.g. "status code 503", "Request failed
      // with status code 5xx") or explicit network/timeout keywords.
      const transient = /status code (?:5\d\d|429)|Too Many Requests|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network error|timeout exceeded|connection (?:reset|refused)|socket hang up/i.test(msg);
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
  // v0.8.7.8: dual-RPC cross-check. After 1.2s of polling Helius with no
  // status, ALSO poll the public Solana RPC. If BOTH return null, it's a
  // ghost sig — try to RESUBMIT via public RPC (the tx is already signed;
  // broadcasting from a different node often works). If resubmit succeeds,
  // the public RPC will see status; otherwise abort. Live failure
  // 20 Jun 2026 10:50:23Z: Helius returned sig AyKqGVJD... but never
  // broadcast. Public RPC confirmed null. Resubmitting via public RPC
  // usually lands the tx.
  const pollStart = Date.now();
  const POLL_BUDGET_MS = 2500;
  const CROSSCHECK_AFTER_MS = 1200;  // first time we ask public RPC
  let status = null;
  let crossChecked = false;
  let resubmitted = false;
  while (Date.now() - pollStart < POLL_BUDGET_MS) {
    // Use whichever connection has the freshest view.
    const probeConn = resubmitted ? publicConnection : connection;
    const r = await probeConn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    status = r?.value?.[0];
    if (status) {
      if (status.err) {
        throw new Error(`${label} tx failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === 'processed' || status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { signature, simulated: false, landedIn: Date.now() - pollStart };
      }
    }
    // v0.8.7.8: cross-check via public RPC if Helius still silent after CROSSCHECK_AFTER_MS
    if (!crossChecked && !status && (Date.now() - pollStart) >= CROSSCHECK_AFTER_MS) {
      crossChecked = true;
      try {
        const pubRes = await publicConnection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const pubStatus = pubRes?.value?.[0];
        if (pubStatus) {
          if (pubStatus.err) {
            throw new Error(`${label} tx failed on-chain (public RPC): ${JSON.stringify(pubStatus.err)}`);
          }
          if (pubStatus.confirmationStatus === 'processed' || pubStatus.confirmationStatus === 'confirmed' || pubStatus.confirmationStatus === 'finalized') {
            console.log(`[executor] ${label} sig ${signature.slice(0,8)}... confirmed via public RPC after ${Date.now() - pollStart}ms (Helius was lagging)`);
            return { signature, simulated: false, landedIn: Date.now() - pollStart };
          }
        }
        // Both Helius AND public RPC still null after 1.2s — ghost sig.
        // Try ONE resubmit via public RPC. The signed bytes are still
        // valid; if Helius dropped the broadcast, public RPC will relay
        // it to a different set of leaders.
        if (!pubStatus && !resubmitted && raw) {
          try {
            const newSig = await publicConnection.sendRawTransaction(raw, {
              skipPreflight: true,
              maxRetries: 2,
              preflightCommitment: 'processed',
            });
            resubmitted = true;
            console.log(`[executor] ${label} resubmitted via public RPC (new sig ${newSig.slice(0,8)}...)`);
            // The new submission may get a different sig. Keep polling the
            // original sig (Solana dedupes — same tx = same sig).
          } catch (resubErr) {
            // Public RPC also rejected — likely the tx is genuinely
            // undeliverable (bad blockhash, expired, etc.).
            throw new Error(`${label} ghost sig detected AND public RPC resubmit failed: ${resubErr.message} (orig sig=${signature})`);
          }
        } else if (!pubStatus) {
          throw new Error(`${label} tx NOT FOUND on public RPC after ${CROSSCHECK_AFTER_MS}ms — ghost sig from Helius (sig=${signature})`);
        }
      } catch (crossErr) {
        // If the error is the ghost-sig abort we just threw, re-throw it.
        if (crossErr.message?.includes('ghost sig') || crossErr.message?.includes('resubmit failed')) throw crossErr;
        // Public RPC errored (rate limit, network) — don't abort, fall
        // back to the normal polling + late-check path.
        console.warn(`[executor] ${label} public RPC cross-check failed: ${crossErr.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  // v0.8.4: budget exhausted. Try getTransaction multiple times with retry.
  // If still null after 3s of extra polling → tx never landed → throw.
  const LATE_POLL_MS = 3000;
  const lateStart = Date.now();
  let last = null;
  while (Date.now() - lateStart < LATE_POLL_MS) {
    try {
      last = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    } catch (e) {
      console.warn(`[executor] ${label} late getTransaction attempt error: ${e.message}`);
    }
    if (last) {
      if (last.meta?.err) {
        throw new Error(`${label} tx failed on-chain (late check): ${JSON.stringify(last.meta.err)}`);
      }
      // tx found, no err — proceed
      console.log(`[executor] ${label} sig ${signature.slice(0,8)}... found via getTransaction after ${Date.now() - pollStart}ms`);
      return { signature, simulated: false, landedIn: Date.now() - pollStart };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // Still null after extended wait — tx never landed. DO NOT proceed to
  // next leg (SELL). This is the v0.8.3 bug fix: a missing tx means we
  // either have phantom tokens (next leg will 3007) or the RPC returned
  // a sig for a tx that never hit the network. Either way: abort.
  throw new Error(`${label} tx NOT FOUND on-chain after ${pollStart + LATE_POLL_MS - pollStart + POLL_BUDGET_MS}ms (sig=${signature})`);
}

/**
 * Main entry point. Called by index.js for every event the monitor emits.
 * Acts on SELL_DETECTED (counter-trade: bot buys when dev sells). The bot
 * is a "reverse copy" bot — its job is to mirror a dev's exit, not their
 * entries. BUY_DETECTED events are logged for observability but NOT acted
 * on. (v0.8.7 had mistakenly added mirror-buy execution; reverted in
 * v0.8.7.7 per user request: "harusnya kan namanya reverse copy ya
 * tinggal sell detected aja dan rasio nya sesuai yaudah".)
 */
export async function executeSignal(event) {
  if (event.type === 'TOKEN_CREATED') {
    recordTokenCreated(event);
    return;
  }
  if (event.type === 'BUY_DETECTED') {
    // v0.8.7.7: log but don't execute. This is a reverse-copy bot.
    logStep('SIGNAL_IGNORED', {
      dev: event.wallet,
      mint: event.mint,
      type: 'BUY_DETECTED',
      reason: 'reverse-copy mode — only SELL_DETECTED triggers a trade',
    });
    return;
  }
  if (event.type !== 'SELL_DETECTED') return;

  const { wallet: dev, mint } = event;
  const chatId = event.chatId;

  // v0.7.0 (06-15): user override — any watched wallet sell = trigger.
  logStep('SIGNAL_ACCEPTED', { dev, mint, mode: 'COUNTER_BUY' });

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
  // v0.8.6.7: Use route-aware slippage. pump.fun (and especially mayhem-mode
  // tokens) need wider tolerance than Jupiter — Jupiter aggregates many LPs,
  // but pump.fun bonding curve is single-source with high sandwich exposure.
  //   - Jupiter route: use slippage_bps (default 5 bps = 0.05%, tight)
  //   - pump.fun route: use pump_slippage_bps (default 1500 bps = 15%, wide)
  // Old code passed slippage_bps (5) to BOTH → 0.05% floor on pump.fun
  // trades → 6042 BuySlippageBelowMinTokensOut on every mayhem buy.
  // Live failure: 2026-06-19 16:07Z mint 4k3tYz...pump, sig 29o68pFW...
  const buySlippageBps = pumpSlippageBps;  // try pump.fun slippage first
  const { quote: buyQuote, route: buyRoute } = await getBuyQuote({ solAmount, outputMint: mint, slippageBps: buySlippageBps });
  if (!buyQuote || buyQuote.error) {
    logStep('BUY_QUOTE_FAILED', { error: buyQuote?.error });
    notifier.tradeFailed({ stage: 'BUY_QUOTE', mint, error: buyQuote?.error || 'no quote', chatId, solAmount }).catch(() => {});
    return;
  }

  // v0.8.6.8: Dust check — verify wallet has enough SOL for the buy + fees +
  // rent (ATA init ~0.002 SOL on Token-2022). Without this, bot submits a tx
  // that pump.fun then bounces with "Transfer: insufficient lamports X, need Y"
  // → custom program error 0x1. We lose 5000 lamports base fee per failed tx
  // and spam the wallet owner with cryptic errors.
  // Live failure: 2026-06-19 16:23:58Z mint EAV1y7w...pump, sig 3Ds9tNJ...
  //   wallet=0.011314106 SOL, need 0.011358023 SOL (off 0.0000439 SOL).
  if (!config.DRY_RUN) {
    try {
      const kp = getKeypairFor(chatId);
      const walletBal = await connection.getBalance(kp.publicKey);
      // Total cost: max_sol_cost (slippage upper bound) + 0.00203928 SOL buffer
      // (5000 lamports base fee + 0.002 SOL rent for new ATA, slightly padded
      // for priority fee headroom). 2_039_280 lamports.
      const SOL_BUFFER_LAMPORTS = 2_039_280n;
      const required = BigInt(buyQuote._maxSolCost) + SOL_BUFFER_LAMPORTS;
      if (BigInt(walletBal) < required) {
        const have = Number(walletBal) / 1e9;
        const need = Number(required) / 1e9;
        const reason = `insufficient lamports: wallet has ${have.toFixed(6)} SOL, need ${need.toFixed(6)} SOL (top up ${(need - have + 0.01).toFixed(4)} SOL)`;
        logStep('BUY_DENIED_DUST', { mint, have, need });
        signalsDb.log({ type: 'BUY_DENIED', wallet: dev, mint, data: { reason, stage: 'DUST_CHECK' } });
        notifier.tradeFailed({ stage: 'BUY_DUST', mint, error: reason, chatId, solAmount }).catch(() => {});
        return;
      }
    } catch (e) {
      // Don't block the trade on RPC failure — log and continue. Worst case
      // is the original 0x1 failure with clear log message.
      logStep('BUY_DUST_CHECK_ERR', { error: e.message });
    }
  }
  const tokensExpected = Number(buyQuote.outAmount);
  logStep('BUY_ROUTE', { route: buyRoute, mint });
  logStep('BUY_QUOTE_OK', {
    dev,
    mint,
    solIn: solAmount,
    tokensOut: tokensExpected,
    slippageBps: buySlippageBps,
    minTokensOut: buyQuote._minTokensOut,
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
    data: { solSpent: solAmount, tokensExpected, tx: buyResult.signature, slippageBps: buySlippageBps },
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
  // v0.8.7.9: use ACTUAL on-chain token balance, not the BUY quote's
  // tokensExpected. pump.fun bonding-curve buys move the spot price up as
  // you buy, so the actual tokens received on-chain is HIGHER than the
  // quote (which is computed at the spot price before your tx lands).
  // Live failure 20 Jun 2026 18:13:13Z: bot bought mint 3RQiJ4hA... for
  // 0.002 SOL, quote said 5,891,200,819 tokens but on-chain transfer was
  // 8,786,387,941 tokens. Bot then sold 5,891,200,819 leaving 2,895,187,122
  // (~2.9K) tokens stuck in the wallet as dust. Fetching the real balance
  // after BUY confirms avoids this completely.
  //
  // v0.8.7.9 also: NO ATA close. The bot does NOT close the user's ATA
  // after SELL — that's intentional. Speed matters more than rent recovery
  // (0.002 SOL). Closing the ATA adds an extra instruction which:
  //   1. Adds ~2k compute units (~5-10ms in practice)
  //   2. Can fail with InvalidAccountData on Token-2022 mints if the
  //      close_authority doesn't match
  //   3. May trigger unnecessary wallet UX (rent recovery tx in wallet UI)
  // If the user wants to clean up ATAs later, they can do it manually via
  // Phantom / Solflare. The bot never adds a close-ATA ix.
  let tokensToSell = tokensExpected;
  if (!config.DRY_RUN) {
    try {
      const kp = getKeypairFor(chatId);
      // pump.fun may use Token-2022 OR Token program depending on mint age
      // and V1/V2 program. Try both ATAs to find the right one.
      let bal = null;
      for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(mint), kp.publicKey, false, programId);
          const r = await connection.getTokenAccountBalance(ata).catch(() => null);
          if (r && r.value && Number(r.value.amount) > 0) {
            bal = Number(r.value.amount);
            break;
          }
        } catch (_) { /* try next program */ }
      }
      if (bal !== null && bal !== tokensExpected) {
        logStep('SELL_BALANCE_CORRECTION', {
          mint,
          quotedTokens: tokensExpected,
          actualTokens: bal,
          deltaPct: (((bal - tokensExpected) / tokensExpected) * 100).toFixed(2),
        });
        tokensToSell = bal;
      }
    } catch (balErr) {
      // Balance fetch failed — fall through to quoted amount. The bot will
      // still sell what it quoted, just may leave dust.
      console.warn(`[executor] SELL_BALANCE_FETCH_FAILED for ${mint.slice(0,12)}...: ${balErr.message}`);
    }
  }
  // v0.8.6.7: pump.fun route needs wider slippage than Jupiter. Same logic
  // as BUY: pass pump_slippage_bps (1500) so the sell floor protects against
  // post-buy sandwich drops within 15%. Without this, bot would set
  // min_sol_output very close to spot and reject 90% of sells when market
  // moved 1% during the 1s hold window.
  const { quote: sellQuote, route: sellRoute } = await getSellQuote({ tokenRawAmount: tokensToSell, inputMint: mint, slippageBps: pumpSlippageBps });
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
