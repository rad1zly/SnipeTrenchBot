// src/safety.js
// =============================================================================
// Centralized safety guard. Every trade goes through `guardTrade()` first.
// If DRY_RUN is on, the function returns a "dry-run approval" without touching
// any state. If DRY_RUN is off, it checks real constraints (per-trade cap,
// daily loss cap, daily spending cap, manual pause) and returns either an
// approval or a denial.
//
// Why a separate module: it keeps risk logic out of the executor and Telegram
// bot, so it's easy to audit. If you change a limit, change it here once.
// =============================================================================

import config from './config.js';
import { positionsDb, safetyDb, metaDb } from './db.js';
import * as settings from './settings.js';

// v0.8.7.4: pause state is PERSISTED to DB so it survives bot restarts.
// Previously an in-memory `let manualPaused = ...` flag, which meant /pause
// was lost on restart and bot would silently resume trading. User feedback
// (20 Jun 2026): "jangan mereset settingan setiap user" — keep user-set
// state across restarts.
//
// Read the persisted value at module load. Fall back to env var START_PAUSED
// for fresh installs (default: false = trading active on first boot).
function loadPauseState() {
  const persisted = metaDb.get('paused');
  if (persisted != null) {
    return persisted === 'true' || persisted === '1';
  }
  return process.env.START_PAUSED === 'true';
}
let manualPaused = loadPauseState();
let lastResetDate = null; // YYYY-MM-DD string of the day we last reset daily stats

/**
 * Reset daily counters at UTC midnight. Called lazily before any check.
 */
function maybeResetDaily() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (lastResetDate !== today) {
    lastResetDate = today;
    // No persistent counter to reset — realizedPnlSince() already filters by
    // timestamp >= start of today. We just update the cached "last reset" so
    // we know when the day rolled over for log purposes.
  }
}

/**
 * Compute the start-of-UTC-today timestamp in ms.
 */
function startOfUtcToday() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Result type for guardTrade / guardAction. `allowed: true` means proceed.
 * `allowed: false` means abort and surface the reason to the user.
 */
function allow(reason = 'ok') {
  return { allowed: true, reason, dryRun: config.DRY_RUN };
}
function deny(reason) {
  return { allowed: false, reason, dryRun: config.DRY_RUN };
}

/**
 * Top-level guard. Call this BEFORE any trade execution. The executor passes
 * the trade parameters; this function validates them against all active rules.
 *
 * @param {object} args
 * @param {number} args.solAmount  - How much SOL the trade will spend (buys only)
 * @param {string} [args.mint]     - The token mint, for per-token buy-limit checks
 * @returns {{ allowed: boolean, reason: string, dryRun: boolean }}
 */
export function guardTrade({ solAmount, mint = null }) {
  maybeResetDaily();

  // Rule 1: manual pause via /pause Telegram command.
  if (manualPaused) {
    safetyDb.log({ type: 'PAUSE', details: 'trade blocked: manual pause active' });
    return deny('Trading is paused. Use /resume to enable.');
  }

  // Rule 2: per-trade cap. Read from settings (DB) first, then .env.
  const perTradeCap = settings.get('fixed_buy_sol');
  if (solAmount > perTradeCap) {
    safetyDb.log({
      type: 'CAP_HIT',
      details: `attempted ${solAmount} SOL > cap ${perTradeCap} SOL`,
    });
    return deny(
      `Trade ${solAmount} SOL exceeds fixed_buy_sol=${perTradeCap}. ` +
        `Adjust the trade size or raise the cap in /settings.`
    );
  }

  // Rule 3: daily spending cap (separate from loss cap). If set, the bot
  // refuses new trades once cumulative entry_sol today exceeds the cap.
  const spendCap = settings.get('sol_spending_limit');
  if (spendCap !== null && spendCap > 0) {
    const spent = settings.spentSolToday();
    if (spent + solAmount > spendCap) {
      safetyDb.log({
        type: 'SPEND_CAP',
        details: `spent ${spent} + ${solAmount} would exceed cap ${spendCap} SOL`,
      });
      return deny(
        `Daily spend cap: ${spent.toFixed(4)} SOL spent today + ${solAmount} SOL ` +
          `> cap ${spendCap} SOL. Increase the cap in /settings or wait until UTC midnight.`
      );
    }
  }

  // Rule 4: buy-limit-per-token. If a mint is supplied, count open positions
  // for that mint and deny if already at the cap.
  if (mint) {
    const limit = settings.get('buy_limit_per_token') || 1;
    const existing = positionsDb.openForMint(mint).length;
    if (existing >= limit) {
      safetyDb.log({
        type: 'TOKEN_LIMIT',
        details: `mint ${mint} already has ${existing} open position(s), limit ${limit}`,
      });
      return deny(
        `Buy limit per token reached: ${existing} open position(s) for this mint, ` +
          `cap ${limit}. Increase buy_limit_per_token in /settings.`
      );
    }
  }

  // Rule 5: daily loss cap. Compare realized losses (closed positions) for
  // today. We don't include unrealized PnL — closing a position will realize
  // it, and at that point the next trade's guardTrade() will see it.
  const since = startOfUtcToday();
  const { total: pnlToday, count } = positionsDb.realizedPnlSince(since);
  if (pnlToday <= -config.DAILY_LOSS_CAP_SOL) {
    safetyDb.log({
      type: 'DAILY_LOSS',
      details: `realized pnl ${pnlToday} SOL over cap ${config.DAILY_LOSS_CAP_SOL} SOL (${count} closed)`,
    });
    return deny(
      `Daily loss cap hit: realized ${pnlToday.toFixed(4)} SOL across ${count} closed ` +
        `trades. Bot auto-pauses for the rest of UTC day.`
    );
  }

  // All checks passed.
  if (config.DRY_RUN) {
    safetyDb.log({ type: 'DRY_RUN', details: `would trade ${solAmount} SOL${mint ? ` on ${mint.slice(0, 8)}…` : ''}` });
  }
  return allow(config.DRY_RUN ? 'DRY_RUN: action logged only' : 'all checks passed');
}

/**
 * Pause / resume controls. v0.8.7.4: state is persisted to `bot_meta.paused`
 * so it survives bot restarts (previously in-memory only).
 */
export function pause() {
  manualPaused = true;
  // v0.8.7.4: persist to DB so state survives restart. Without this, a /pause
  // command would be silently cleared by the next `systemctl restart` and
  // bot would trade again — exactly the "settings reset on restart" pattern
  // the user complained about.
  metaDb.set('paused', 'true');
  safetyDb.log({ type: 'PAUSE', details: 'manual pause set via /pause' });
}
export function resume() {
  manualPaused = false;
  metaDb.set('paused', 'false');
  safetyDb.log({ type: 'PAUSE', details: 'manual pause cleared via /resume' });
}
export function isPaused() {
  return manualPaused;
}

/**
 * Return a snapshot of current safety state. Used by /status Telegram command.
 *
 * v0.8.0: now includes `winStats` (per-user + global). Caller passes
 * `chatId` when available so the win rate matches the user's own wallet
 * watchlist; otherwise the global aggregate is returned.
 */
export function snapshot(chatId = null) {
  maybeResetDaily();
  const since = startOfUtcToday();
  const { total: pnlToday, count: closedToday } = positionsDb.realizedPnlSince(since);
  const open = positionsDb.openAll();
  return {
    mode: config.DRY_RUN ? 'DRY_RUN' : 'LIVE',
    manualPaused,
    dailyLossCapSol: config.DAILY_LOSS_CAP_SOL,
    pnlTodaySol: pnlToday,
    closedTodayCount: closedToday,
    openPositionCount: open.length,
    maxSolPerTrade: settings.get('fixed_buy_sol'),
    spendingLimit: settings.get('sol_spending_limit'),
    spentSolToday: settings.spentSolToday(),
    buyLimitPerToken: settings.get('buy_limit_per_token'),
    slippageBps: settings.get('slippage_bps'),
    holdMs: settings.get('hold_ms'),
    autoSell: settings.get('auto_sell'),
    autoRetry: settings.get('auto_retry'),
    antiMev: settings.get('anti_mev'),
    startTime: settings.get('start_time'),
    endTime: settings.get('end_time'),
    minSellRatio: settings.get('min_sell_ratio'),
    // v0.8.0: per-user + global win/loss aggregates. Both are cheap
    // (single indexed scan over CLOSED positions).
    winStats: positionsDb.winStats(chatId),
    winStatsGlobal: positionsDb.winStats(null),
  };
}
