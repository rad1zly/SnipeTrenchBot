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
import { startExitLoop } from './exitEngine.js';
import { submitFastTrack } from './tipLanes.js';

// v0.8.8 (experimental) M2: parse a stored auto-sell setting (which is
// stored as a JSON string in user_settings) into a flat object with the
// fields the exit engine expects (tp1, tp1_sell, sl, trail, t1, etc).
// Returns an empty object if the input is null/empty/garbage so callers
// can spread without checking.
function parsePlan(raw) {
  if (!raw) return {};
  let v;
  try { v = JSON.parse(raw); } catch { return {}; }
  if (!v || typeof v !== 'object') return {};
  return v;
}
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
function isWithinTradingHours(chatId) {
  const start = settings.get('start_time', chatId) || '00:00';
  const end = settings.get('end_time', chatId) || '23:59';
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
  // v0.8.7.15: pass chatId for per-user Jupiter-route settings (anti_mev, priority fee).
  const txB64 = await buildSwapTransaction({
    quoteResponse,
    userPublicKey: kp.publicKey.toBase58(),
    route,
    side,
    chatId,
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
  // v0.8.1: use sendRawTransaction to bypass Helius sendTransaction's
  // pre-validation (simulateTransaction → 422 AccountNotFound for PDAs
  // that don't exist yet, e.g. bonding-curve-v2, user-volume-accumulator).
  // v0.8.8 (experimental) M4.0: replaced single-RPC submit with
  // tipLanes.submitFastTrack — 4 lanes (jito, helius, 0slot, astralane)
  // with fallback. When the primary lane is congested (e.g. Jito during
  // peak hours), the same signed tx is re-submitted to the next lane.
  // Per-lane timeout is TIP_LANE_TIMEOUT_MS (default 8s).
  const signedB64 = Buffer.from(tx.serialize()).toString('base64');
  const t0 = Date.now();
  const fastTrack = await submitFastTrack({
    signedTxB64: signedB64,
    side: side || (label === 'BUY' ? 'buy' : 'sell'),
    chatId,
  });
  return {
    signature: fastTrack.signature,
    simulated: false,
    landedIn: Date.now() - t0,
    lane: fastTrack.lane,
    landTimeMs: fastTrack.landTimeMs,
    laneAttempts: fastTrack.attempts,
  };
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
  // v0.8.8 (experimental) M3.1b: copy_mode is now PER-WALLET, not
  // per-user. The Helius monitor emits one event per (wallet, owner)
  // pair, so each event already carries the chatId of the user who
  // watches this specific wallet. The copy_mode for THIS event is
  // looked up from watched_wallets row matching (chatId, address).
  // This lets user A watch wallet X in reverse mode and wallet Y in
  // mirror mode at the same time.
  const { wallet: dev, mint } = event;
  const chatId = event.chatId;
  // v0.8.8 (experimental) M7: trade-decision settings can now be tuned
  // per watched wallet via settings.getForWallet(...). The fallback chain
  // is wallet_settings → user_settings → env → code default, so users
  // can selectively override one wallet without changing the global
  // behavior of the others.
  const walletCfg = walletsDb.getCopyConfig({ chatId, address: dev }) || { copy_mode: 'reverse', copy_ratio: 100 };
  const copyMode = walletCfg.copy_mode || 'reverse';
  // v0.8.8 (experimental) M6.1: copyRatio is now hardcoded to 100 (1:1 mirror).
  // The DB column is kept for back-compat but ignored. See _executeBuy for details.
  const copyRatio = 100;

  if (event.type === 'BUY_DETECTED') {
    if (copyMode === 'mirror') {
      // v0.8.8 (experimental) M5: trader_buy_limit_min/max filter.
      // Only mirror-buy if target's solSpent falls within configured range.
      // Default null/0 = no filter (backward compat with pre-M5 installs).
      // v0.8.8 M7: per-wallet override available via wallet_settings.
      const buyMin = settings.getForWallet('trader_buy_limit_min', chatId, dev);
      const buyMax = settings.getForWallet('trader_buy_limit_max', chatId, dev);
      const targetSol = event.solSpent;
      if (targetSol != null && targetSol > 0) {
        if (buyMin != null && targetSol < buyMin) {
          logStep('SIGNAL_IGNORED', {
            dev, mint, type: 'BUY_DETECTED',
            reason: `below trader_buy_limit_min (target ${targetSol} SOL < min ${buyMin} SOL)`,
          });
          return;
        }
        if (buyMax != null && targetSol > buyMax) {
          logStep('SIGNAL_IGNORED', {
            dev, mint, type: 'BUY_DETECTED',
            reason: `above trader_buy_limit_max (target ${targetSol} SOL > max ${buyMax} SOL)`,
          });
          return;
        }
      }
      // v0.8.8 M3.1b: mirror mode — fall through to the same BUY
      // execution path used by reverse-copy's SELL_DETECTED branch,
      // but flag the trigger type in the log.
      logStep('SIGNAL_ACCEPTED', {
        dev, mint,
        mode: 'MIRROR_BUY',
        copyMode,
        copyRatio,
      });
      return _executeBuy(event, { copyMode, copyRatio });
    }
    // 'off' or 'reverse': BUY_DETECTED is logged but doesn't trade.
    logStep('SIGNAL_IGNORED', {
      dev, mint,
      type: 'BUY_DETECTED',
      reason: `wallet.copy_mode=${copyMode} — only ${copyMode === 'reverse' ? 'SELL_DETECTED' : 'nothing'} triggers a trade`,
    });
    return;
  }
  if (event.type !== 'SELL_DETECTED') return;

  // v0.7.0 (06-15): user override — any watched wallet sell = trigger.
  // v0.8.8 M3.1b: copy_mode is per-wallet. Only execute if THIS wallet's
  // mode is 'reverse' (default) or 'mirror' (SELL_DETECTED is
  // informational in mirror mode but doesn't fire a buy — mirror mode
  // only buys on BUY_DETECTED, see above).
  if (copyMode === 'off') {
    logStep('SIGNAL_IGNORED', { dev, mint, type: 'SELL_DETECTED', reason: 'wallet.copy_mode=off' });
    return;
  }
  if (copyMode === 'mirror') {
    // Mirror mode: dev SELL is informational only.
    logStep('SIGNAL_IGNORED', { dev, mint, type: 'SELL_DETECTED', reason: 'wallet.copy_mode=mirror — only BUY_DETECTED triggers' });
    return;
  }
  // v0.8.8 (experimental) M5: trader_sell_limit_min/max filter (reverse mode).
  // Only counter-buy if target's solReceived falls within configured range.
  // Default null/0 = no filter (backward compat with pre-M5 installs).
  // v0.8.8 M7: per-wallet override available via wallet_settings.
  const sellMin = settings.getForWallet('trader_sell_limit_min', chatId, dev);
  const sellMax = settings.getForWallet('trader_sell_limit_max', chatId, dev);
  const devSolReceived = event.solReceived;
  if (devSolReceived != null && devSolReceived > 0) {
    if (sellMin != null && devSolReceived < sellMin) {
      logStep('SIGNAL_IGNORED', {
        dev, mint, type: 'SELL_DETECTED',
        reason: `below trader_sell_limit_min (target sold ${devSolReceived} SOL < min ${sellMin} SOL)`,
      });
      return;
    }
    if (sellMax != null && devSolReceived > sellMax) {
      logStep('SIGNAL_IGNORED', {
        dev, mint, type: 'SELL_DETECTED',
        reason: `above trader_sell_limit_max (target sold ${devSolReceived} SOL > max ${sellMax} SOL)`,
      });
      return;
    }
  }
  logStep('SIGNAL_ACCEPTED', { dev, mint, mode: 'COUNTER_BUY', copyMode, copyRatio });

  return _executeBuy(event, { copyMode, copyRatio });
}

/**
 * v0.8.8 (experimental) M3.1: internal BUY execution. Used by both
 * reverse-copy (SELL_DETECTED → counter-buy) and mirror-copy
 * (BUY_DETECTED → follow-buy) modes. The caller (executeSignal)
 * has already logged the SIGNAL_ACCEPTED / IGNORED decision and
 * validated the copy_mode. This function does the actual trade.
 *
 * M3.1b: now accepts { copyMode, copyRatio } from the per-wallet config
 * (looked up in executeSignal). copyRatio is used to size the buy in
 * mirror mode (dev's solSpent * copyRatio / 100).
 */
async function _executeBuy(event, { copyMode, copyRatio } = {}) {
  const { wallet: dev, mint } = event;
  const chatId = event.chatId;

  // ---- Time window gate (UTC) ----
  if (!isWithinTradingHours(chatId)) {
    logStep('SKIP_OUTSIDE_HOURS', {
      dev,
      mint,
      now: new Date().toISOString().slice(11, 16),
      window: `${settings.get('start_time', chatId)}-${settings.get('end_time', chatId)} UTC`,
    });
    signalsDb.log({ type: 'OUT_OF_HOURS', wallet: dev, mint, data: { event } });
    return;
  }

  // ---- Filter gate (opt-in on-chain checks) ----
  // v0.8.7.15: pass chatId so filters are scoped to this user.
  const createdAt = tokenMintByDev.get(dev)?.get(mint);
  const filterResult = await passesFilters({
    chatId,
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

  // ---- Read trade params from THIS USER's settings (mutable at runtime) ----
  // v0.8.7.15: chatId is REQUIRED for all settings reads. Each subscriber has
  // their own config — user A's fixed_buy_sol no longer leaks to user B.
  // v0.8.8 (experimental) M6.1: copyRatio REMOVED. Was per-wallet (M3.1b),
  // but added attack surface (typos, bad scaling) without a clear use case
  // beyond 100% (1:1). Mirror mode now always 1:1 (target.solSpent).
  // Reverse mode uses fixed_buy_sol as before. copyRatio param still
  // accepted for backward-compat with the M3.1b watcher signatures,
  // but always clamped to 100 in the caller (executeSignal).
  // v0.8.8 M7: trade-decision settings (fixed_buy_sol, slippage, hold_ms,
  // auto_sell, auto_retry, tp_sl_plan, trailing_stop, time_sell_plan) now
  // resolve per-watched-wallet first, then per-user. This lets users
  // tune sizing, exit plan, and tolerance per dev wallet.
  const fixedBuy = settings.getForWallet('fixed_buy_sol', chatId, dev);
  let solAmount;
  if (event.type === 'BUY_DETECTED' && typeof event.solSpent === 'number' && event.solSpent > 0) {
    // Mirror mode: 1:1 (target's solSpent). The copyRatio param is ignored.
    solAmount = event.solSpent;
    logStep('MIRROR_BUY_1TO1', { devSol: event.solSpent, botSol: solAmount });
  } else {
    solAmount = fixedBuy;
  }
  const slippageBps = settings.getForWallet('slippage_bps', chatId, dev);
  const pumpSlippageBps = settings.getForWallet('pump_slippage_bps', chatId, dev);
  const pumpSellSlippageBps = settings.getForWallet('pump_sell_slippage_bps', chatId, dev);  // v0.8.7.13: separate from buy
  const holdMs = settings.getForWallet('hold_ms', chatId, dev);
  const autoSell = settings.getForWallet('auto_sell', chatId, dev);
  const autoRetry = settings.getForWallet('auto_retry', chatId, dev);
  // v0.8.8 (experimental) M2: read the user's auto-sell plan and pass it
  // through to the position row as a snapshot. The exit engine reads
  // from the snapshot so plan edits mid-trade don't retro-fire tiers.
  const tpSlPlan     = parsePlan(settings.getForWallet('tp_sl_plan',     chatId, dev));
  const trailPlan    = parsePlan(settings.getForWallet('trailing_stop',  chatId, dev));
  const timePlan     = parsePlan(settings.getForWallet('time_sell_plan', chatId, dev));
  const autoSellPlan = { ...tpSlPlan, ...trailPlan, ...timePlan };
  const hasPlan = Object.keys(autoSellPlan).length > 0;

  // v0.8.7.15: pass chatId to guardTrade so cap checks (per-trade cap, daily
  // spend cap, buy-limit-per-token, manual pause) are per-user.
  const guard = guardTrade({ chatId, solAmount, mint });
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
  //   - pump.fun BUY: use pump_slippage_bps (default 1500 bps = 15%, wide)
  //   - pump.fun SELL: use pump_sell_slippage_bps (default 3000 bps = 30%, very wide)
  // Old code passed slippage_bps (5) to BOTH → 0.05% floor on pump.fun
  // trades → 6042 BuySlippageBelowMinTokensOut on every mayhem buy.
  // Live failure: 2026-06-19 16:07Z mint 4k3tYz...pump, sig 29o68pFW...
  // v0.8.7.13: BUY uses pump_slippage_bps, SELL uses pump_sell_slippage_bps.
  // BUY with 30% slippage caused 1.28–1.67× overspend on non-mayhem tokens.
  // v0.8.7.14: BUY slippage default 1500 → 100 (1%). User wants maxSolCost
  // ≈ solAmount (not 1.15× or 1.30×). With 1% slippage + non-mayhem 1.0×
  // fee mult: maxSolCost = 0.002 × 1.01 = 0.00202 SOL.
  // Reference tx from another bot (5R2U8rFR...): BC received 0.001975 SOL
  // for 0.002 SOL buy intent — confirms other bot uses maxSolCost ≈ 0.002.
  // Trade-off: tighter slippage → BUY may fail (6042) if curve moves >1%
  // adversely between quote and execute. Acceptable for copy-trade bot:
  // failed BUY = no loss, overspend = lost SOL.
  const buySlippageBps = pumpSlippageBps;  // try pump.fun slippage first
  const { quote: buyQuote, route: buyRoute } = await getBuyQuote({ solAmount, outputMint: mint, slippageBps: buySlippageBps, chatId });
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
  // v0.8.7.15: pass chatId so the position is owned by THIS user. Each
  // subscriber's positions are isolated, enabling per-user daily spend caps.
  const posRes = positionsDb.open({
    chatId,
    mint,
    devWallet: dev,
    entrySig: null, // filled below
    entrySol: solAmount,
    entryTokens: tokensExpected,
    autoSellPlan,   // v0.8.8 M2: snapshot the user's plan at entry time
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

  // ----- AUTO-SELL gate (M2 split) -----
  if (!autoSell) {
    // Skip the sell leg. Position stays OPEN until the user manually closes
    // it (future feature) or it ages out. We log so the user knows.
    logStep('SELL_SKIPPED_AUTO_OFF', { positionId, mint });
    signalsDb.log({ type: 'AUTO_SELL_OFF', wallet: dev, mint, data: { positionId } });
    return;
  }

  // v0.8.8 (experimental) M2: if the user has an auto-sell plan, hand the
  // position off to the exit engine. The engine polls the bonding curve
  // every 1s and fires TP/SL/Trailing/Time tiers as their conditions
  // are met. The executor's old immediate-sell path is the fallback for
  // users with no plan.
  if (hasPlan) {
    logStep('EXIT_LOOP_HANDOFF', { positionId, hasPlan: true, planKeys: Object.keys(autoSellPlan) });
    startExitLoop(positionId);
    return;
  }
  logStep('EXIT_LOOP_SKIPPED_NO_PLAN', { positionId });

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
  // as BUY: pass pump_sell_slippage_bps (3000 = 30% default since v0.8.7.11)
  // so the sell floor protects against post-buy sandwich drops. 30% gives
  // headroom for fast-moving curves (dev dump, sandwich attack).
  // v0.8.7.13: separated from pump_slippage_bps (used by BUY). SELL needs
  // wider slippage than BUY because:
  //   - BUY: user knows the price they're paying; if curve moves adversely,
  //     user pays more. We want tight slippage to fail fast.
  //   - SELL: user is exiting; any price is OK. Curve moving adversely is
  //     expected after a 1s hold. Wide slippage ensures the SELL lands.
  // Live failure: 2026-06-20 12:52:02Z, mint 3RQiJ4hA..., sig 2Rne662Y...
  //   30% BUY slippage caused 0.002567 SOL spend for 0.002 SOL intent (1.28×).
  //   With 15% BUY slippage + non-mayhem 1.0× fee mult, max spend = 0.0023 SOL
  //   — much closer to intent.
  const { quote: sellQuote, route: sellRoute } = await getSellQuote({ tokenRawAmount: tokensToSell, inputMint: mint, slippageBps: pumpSellSlippageBps, chatId });
  if (!sellQuote || sellQuote.error) {
    positionsDb.fail(positionId, `sell quote: ${sellQuote?.error || 'no quote'}`);
    logStep('SELL_QUOTE_FAILED', { error: sellQuote?.error });
    notifier.tradeFailed({ stage: 'SELL_QUOTE', mint, error: sellQuote?.error || 'no quote', chatId, solAmount: solAmount }).catch(() => {});
    return;
  }
  const solExpected = Number(sellQuote.outAmount) / config.LAMPORTS_PER_SOL;
  // v0.8.7.11: skip SELL if price impact > 50%. Live failure 20 Jun 2026
  // 11:22:48Z: dev's 2.6M token dump moved curve >15% in 1s, SELL failed
  // with 6003 TooLittleSolReceived. With 30% slippage (v0.8.7.11 default)
  // this should succeed. If still >50% impact, the market is too hostile —
  // close position as FAILED, let user recover manually.
  const priceImpactPct = Math.abs(parseFloat(sellQuote.priceImpactPct || 0));
  if (priceImpactPct > 50) {
    positionsDb.fail(positionId, `sell: price impact ${priceImpactPct.toFixed(2)}% exceeds 50% — skipping`);
    logStep('SELL_SKIPPED_HIGH_IMPACT', { mint, priceImpactPct, solExpected });
    notifier.tradeFailed({ stage: 'SELL', mint, error: `price impact ${priceImpactPct.toFixed(2)}% too high — manual recovery needed`, chatId, solAmount }).catch(() => {});
    return;
  }
  logStep('SELL_QUOTE_OK', { tokensIn: tokensToSell, solOut: solExpected, priceImpactPct });

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
 * v0.8.8 (experimental) M2: Execute a partial-or-full SELL for an existing
 * open position. Called by exitEngine.js when a TP/SL/Trailing/Time tier
 * fires. Returns the sell result { signature, solReceived } on success,
 * throws on failure (the exit engine handles the throw by notifying the
 * user and NOT marking the tier fired).
 *
 * Differs from the inner `sellAuto` (above) in that:
 *   - caller already has a position row (we don't re-insert / re-quote
 *     for the full entry — we know the token amount and target sell %)
 *   - chatId is required (so we know which wallet to use)
 *   - on success we update positions.{sold_pct, status=CLOSED, exit_sig,
 *     exit_sol, pnl_sol, pnl_percent, hold_ms}; on failure we just
 *     log to signals and return without touching the position row
 */
export async function executeSell({ positionId, mint, chatId, tokenRawAmount, slippageBps = null, tierName = null }) {
  // v0.8.8 M7: per-wallet sell slippage. Read from the position's dev
  // wallet if available, else fall back to the chatId-level setting.
  // We need the watched wallet (dev) to resolve the override. Pull it
  // from the position row (openPosition stored dev_wallet).
  let posDev = null;
  try {
    const { getDb } = await import('./db.js');
    const d = getDb();
    const pos = d.prepare('SELECT dev_wallet FROM positions WHERE id = ?').get(positionId);
    if (pos) posDev = pos.dev_wallet;
  } catch { /* not critical */ }

  // Defensive: make sure wallet is loaded.
  const w = walletManager.getStatus(chatId);
  if (!w.set) {
    throw new Error(`wallet not set for chat ${chatId} — cannot sell`);
  }

  const pumpSellSlippageBps = slippageBps ?? settings.getForWallet('pump_sell_slippage_bps', chatId, posDev);
  const autoRetry = settings.getForWallet('auto_retry', chatId, posDev) ?? 0;

  const { quote: sellQuote, route: sellRoute } = await getSellQuote({
    tokenRawAmount: BigInt(Math.floor(tokenRawAmount)),
    inputMint: mint,
    slippageBps: pumpSellSlippageBps,
    chatId,
  });
  if (!sellQuote || sellQuote.error) {
    throw new Error(`sell quote: ${sellQuote?.error || 'no quote'}`);
  }
  const priceImpactPct = Math.abs(parseFloat(sellQuote.priceImpactPct || 0));
  if (priceImpactPct > 50) {
    throw new Error(`price impact ${priceImpactPct.toFixed(2)}% exceeds 50%`);
  }
  const sellResult = await submitSwapWithRetry({
    quoteResponse: sellQuote,
    label: tierName ? `SELL:${tierName}` : 'SELL',
    maxAttempts: autoRetry,
    chatId,
    route: sellRoute,
    side: 'sell',
  });
  return {
    signature: sellResult.signature,
    solReceived: Number(sellQuote.outAmount) / config.LAMPORTS_PER_SOL,
    route: sellRoute,
  };
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
    // v0.8.7.15: per-user.anti_mev controls Jupiter URL. Pass chatId.
    effectiveJupiterUrl: chatId != null ? effectiveJupiterUrl(chatId) : config.JUPITER_API_URL,
    trackedMints: Array.from(tokenMintByDev.values()).reduce((a, m) => a + m.size, 0),
    // v0.8.7.15: per-user active filters. chatId may be null for global status.
    activeFilters: chatId != null ? activeFilters(chatId) : null,
  };
}
