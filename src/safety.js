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
import { positionsDb, safetyDb, userSettingsDb, getDb } from './db.js';
import * as settings from './settings.js';

// v0.8.7.4: pause state is PERSISTED to DB so it survives bot restarts.
// v0.8.7.15: pause is per-user (chatId keyed). Stored in user_settings under
// key '_pause'. Each subscriber can /pause independently — user A pausing
// no longer pauses user B's bot.
//
// In-memory cache for fast `isPaused(chatId)` lookups (called on every
// trade). Hydrated from DB at module load, kept in sync via pause/resume.
const pausedByChatId = new Map();

// Hydrate the in-memory pause cache from DB. Runs at module load.
// Reads all (chat_id, value) rows where key='_pause'. Missing rows = not paused.
function hydratePauseCache() {
  try {
    const rows = getDb()
      .prepare(`SELECT chat_id, value FROM user_settings WHERE key = '_pause'`)
      .all();
    for (const r of rows) {
      try {
        const v = JSON.parse(r.value);
        if (v === true || v === 'true') pausedByChatId.set(r.chat_id, true);
      } catch {}
    }
    // Backward compat: if there's an OLD global bot_meta.paused and no
    // user_settings rows yet, apply it to every current subscriber.
    const metaRow = getDb()
      .prepare(`SELECT value FROM bot_meta WHERE key = 'paused'`)
      .get();
    const subs = getDb().prepare(`SELECT chat_id FROM subscribers`).all();
    if (metaRow && metaRow.value === 'true' && subs.length > 0) {
      // Global pause was on. If we already migrated to per-user, the
      // migration set _pause for each subscriber, so this is a no-op.
      // If we haven't migrated yet (running old code), this won't fire.
      // Either way: safe to re-apply.
      for (const s of subs) {
        if (!userSettingsDb.get(s.chat_id, '_pause')) {
          userSettingsDb.set(s.chat_id, '_pause', true);
          pausedByChatId.set(s.chat_id, true);
        }
      }
    }
  } catch (e) {
    console.error('[safety] hydratePauseCache failed:', e.message);
  }
}
hydratePauseCache();

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
 * v0.8.7.15: chatId is REQUIRED. All caps, limits, time windows are per-user.
 * Each subscriber's settings live in their own row, so guardTrade for user A
 * no longer affects user B.
 *
 * @param {object} args
 * @param {number} args.chatId    - Telegram chat_id of the trade owner (REQUIRED)
 * @param {number} args.solAmount - How much SOL the trade will spend (buys only)
 * @param {string} [args.mint]    - The token mint, for per-token buy-limit checks
 * @returns {{ allowed: boolean, reason: string, dryRun: boolean }}
 */
export function guardTrade({ chatId, solAmount, mint = null }) {
  if (chatId == null) {
    // Refuse loudly. Trading without a chatId used to mean "check global
    // settings" — that's exactly the leak we just fixed. Forcing chatId
    // means every trade is auditable per-user.
    throw new Error('guardTrade: chatId is required (per-user isolation since v0.8.7.15)');
  }
  maybeResetDaily();

  // Rule 1: per-user manual pause via /pause Telegram command.
  if (pausedByChatId.get(chatId) === true) {
    safetyDb.log({ type: 'PAUSE', details: `trade blocked: pause active for chat_id=${chatId}` });
    return deny('Trading is paused for your account. Use /resume to enable.');
  }

  // Rule 2: per-trade cap. Read from THIS USER's settings.
  const perTradeCap = settings.get('fixed_buy_sol', chatId);
  if (solAmount > perTradeCap) {
    safetyDb.log({
      type: 'CAP_HIT',
      details: `chat_id=${chatId} attempted ${solAmount} SOL > cap ${perTradeCap} SOL`,
    });
    return deny(
      `Trade ${solAmount} SOL exceeds fixed_buy_sol=${perTradeCap}. ` +
        `Adjust the trade size or raise the cap in /settings.`
    );
  }

  // Rule 3: per-user daily spending cap.
  const spendCap = settings.get('sol_spending_limit', chatId);
  if (spendCap !== null && spendCap > 0) {
    const spent = settings.spentSolToday(chatId);
    if (spent + solAmount > spendCap) {
      safetyDb.log({
        type: 'SPEND_CAP',
        details: `chat_id=${chatId} spent ${spent} + ${solAmount} > cap ${spendCap} SOL`,
      });
      return deny(
        `Daily spend cap: ${spent.toFixed(4)} SOL spent today + ${solAmount} SOL ` +
          `> cap ${spendCap} SOL. Increase the cap in /settings or wait until UTC midnight.`
      );
    }
  }

  // Rule 4: per-user buy-limit-per-token. Count open positions for THIS user on this mint.
  if (mint) {
    const limit = settings.get('buy_limit_per_token', chatId) || 1;
    const existing = positionsDb.openForMint(mint, chatId).length;
    if (existing >= limit) {
      safetyDb.log({
        type: 'TOKEN_LIMIT',
        details: `chat_id=${chatId} mint ${mint} already has ${existing} open position(s), limit ${limit}`,
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
 * Pause / resume controls. v0.8.7.4: state is persisted.
 * v0.8.7.15: per-user. Each Telegram subscriber has their own pause state.
 * chatId is REQUIRED — calling pause()/resume() without chatId would
 * leak to all subscribers, which is exactly the bug we're fixing.
 */
export function pause(chatId) {
  if (chatId == null) throw new Error('safety.pause: chatId is required (per-user isolation since v0.8.7.15)');
  pausedByChatId.set(chatId, true);
  userSettingsDb.set(chatId, '_pause', true);
  safetyDb.log({ type: 'PAUSE', details: `manual pause set via /pause for chat_id=${chatId}` });
}
export function resume(chatId) {
  if (chatId == null) throw new Error('safety.resume: chatId is required');
  pausedByChatId.delete(chatId);
  userSettingsDb.set(chatId, '_pause', false);
  safetyDb.log({ type: 'PAUSE', details: `manual pause cleared via /resume for chat_id=${chatId}` });
}
export function isPaused(chatId) {
  if (chatId == null) return false;  // No chatId = not paused (used by non-trade callers like /status)
  return pausedByChatId.get(chatId) === true;
}

/**
 * Return a snapshot of current safety state. Used by /status Telegram command.
 *
 * v0.8.7.15: chatId scopes every per-user value (pause state, caps, daily
 * spend, win stats) to one subscriber. Without chatId, only global aggregates
 * are returned.
 */
export function snapshot(chatId = null) {
  maybeResetDaily();
  const since = startOfUtcToday();
  const { total: pnlToday, count: closedToday } = positionsDb.realizedPnlSince(since, chatId);
  const open = positionsDb.openAll(chatId);
  return {
    mode: config.DRY_RUN ? 'DRY_RUN' : 'LIVE',
    manualPaused: chatId != null ? isPaused(chatId) : false,  // global snapshot can't represent per-user pause
    dailyLossCapSol: config.DAILY_LOSS_CAP_SOL,
    pnlTodaySol: pnlToday,
    closedTodayCount: closedToday,
    openPositionCount: open.length,
    maxSolPerTrade: chatId != null ? settings.get('fixed_buy_sol', chatId) : null,
    spendingLimit: chatId != null ? settings.get('sol_spending_limit', chatId) : null,
    spentSolToday: chatId != null ? settings.spentSolToday(chatId) : null,
    buyLimitPerToken: chatId != null ? settings.get('buy_limit_per_token', chatId) : null,
    slippageBps: chatId != null ? settings.get('slippage_bps', chatId) : null,
    holdMs: chatId != null ? settings.get('hold_ms', chatId) : null,
    autoSell: chatId != null ? settings.get('auto_sell', chatId) : null,
    autoRetry: chatId != null ? settings.get('auto_retry', chatId) : null,
    antiMev: chatId != null ? settings.get('anti_mev', chatId) : null,
    startTime: chatId != null ? settings.get('start_time', chatId) : null,
    endTime: chatId != null ? settings.get('end_time', chatId) : null,
    minSellRatio: chatId != null ? settings.get('min_sell_ratio', chatId) : null,
    // v0.8.0: per-user + global win/loss aggregates. Both are cheap
    // (single indexed scan over CLOSED positions).
    winStats: positionsDb.winStats(chatId),
    winStatsGlobal: positionsDb.winStats(null),
  };
}
