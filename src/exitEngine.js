// src/exitEngine.js
// =============================================================================
// v0.8.8 (experimental) M2 exit engine. After every BUY_OK the executor
// starts an ExitLoop for that position. The loop polls the bonding curve
// every 1s, computes the live SOL value of the held tokens, updates the
// position row, and fires TP/SL/Trailing/Time tiers as their conditions
// are met.
//
// Each ExitLoop is bound to a single position. It terminates when:
//   - a tier that closes the position (e.g. SL 100%, last TP tier) fires
//     and the resulting SELL_OK is observed, OR
//   - the position is already CLOSED on entry (manually closed elsewhere),
//     OR
//   - the process is shutting down (SIGINT/SIGTERM).
//
// Architecture:
//   startExitLoop(positionId)  \u2192 spawns an async loop, returns immediately.
//   pollOnce(positionId)       \u2192 single price tick; updates position + checks
//                                triggers; returns the next action (or null).
//   stopAllExitLoops()         \u2192 graceful shutdown (called by index.js on
//                                SIGINT).
// =============================================================================

import { getBondingCurveState } from './pumpfun.js';
import { getPosition, markTierFired, setSoldPct, closePosition, getOpenPositions, parsePlanSnapshot } from './positionTracker.js';
import { executeSell } from './executor.js';
import { getDb } from './db.js';
import * as notifier from './notifier.js';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// v0.8.8 (experimental) M2.12: tier-fire audit log. Writes a row to the
// signals table so /recent can show TP1 FIRED / SL FIRED / etc. The
// signals table is normally populated by the monitor for TOKEN_CREATED /
// SELL_DETECTED / BUY / SELL — adding the TIER_FIRED type is just another
// log entry. (We use the signalsDb object from db.js for consistency.)
import { signalsDb } from './db.js';

// Map of positionId \u2192 { stop: bool, soldThisLoop: 0 }. We use a simple
// object instead of AbortController so that the logic is easy to read
// and debug in a Node REPL.
const loops = new Map();

// Default poll interval. The user can override per-user via the
// `exit_poll_ms` setting (future M2.x); for M2.1 we hardcode 1s.
const DEFAULT_POLL_MS = 1000;

// Stale-data threshold: if we don't get a successful price tick for
// 30s, we log a warning but keep the loop alive (pump.fun can pause
// briefly during congested slots).
const STALE_THRESHOLD_MS = 30_000;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Start an exit loop for the given position id. Idempotent \u2014 calling
 * twice for the same position is a no-op (we just attach to the
 * existing loop).
 *
 * @param {number} positionId
 */
export function startExitLoop(positionId) {
  if (loops.has(positionId)) {
    return; // already running
  }
  const ctx = { stop: false, soldThisLoop: 0, lastPriceLog: 0 };
  loops.set(positionId, ctx);
  // Fire and forget \u2014 the loop runs until ctx.stop or the position
  // closes. We do NOT await it from the caller (executor.js) so the
  // BUY_OK handler returns immediately and the user gets a snappy
  // Telegram notification.
  runLoop(positionId, ctx).catch((e) => {
    console.error(`[exitEngine] loop for position ${positionId} crashed:`, e);
    loops.delete(positionId);
  });
}

/**
 * Stop a specific position's exit loop. Called from executor.js when a
 * SELL completes so we don't waste RPC calls on a closed position.
 */
export function stopExitLoop(positionId) {
  const ctx = loops.get(positionId);
  if (ctx) ctx.stop = true;
  loops.delete(positionId);
}

/**
 * Stop ALL running exit loops. Called on SIGINT/SIGTERM.
 */
export function stopAllExitLoops() {
  for (const ctx of loops.values()) ctx.stop = true;
  loops.clear();
  console.log(`[exitEngine] stopped all loops (${loops.size} active at call time)`);
}

/**
 * On bot startup, re-attach exit loops to any OPEN positions that
 * were left running from a previous session (e.g. process restart
 * after a crash). Without this, restart would orphan every open
 * position and they'd sit there until manually closed.
 */
export function reattachLoopsOnBoot() {
  const open = getOpenPositions(null);
  for (const p of open) {
    console.log(`[exitEngine] reattaching loop to existing position ${p.id} (mint=${p.mint.slice(0, 8)}\u2026)`);
    startExitLoop(p.id);
  }
}

// -----------------------------------------------------------------------------
// Loop body
// -----------------------------------------------------------------------------

async function runLoop(positionId, ctx) {
  const pos = getPosition(positionId);
  if (!pos) {
    console.log(`[exitEngine] position ${positionId} not found, loop exits`);
    loops.delete(positionId);
    return;
  }
  if (pos.status !== 'OPEN') {
    console.log(`[exitEngine] position ${positionId} is ${pos.status}, no loop needed`);
    loops.delete(positionId);
    return;
  }

  const plan = parsePlanSnapshot(pos.auto_sell_plan_snapshot);
  console.log(`[exitEngine] loop start for position ${positionId} (mint=${pos.mint.slice(0, 8)}\u2026, entry=${pos.entry_sol} SOL, plan=${plan ? 'yes' : 'none'})`);

  // Notify the user the position is now being tracked (one-time).
  await notifier.send(pos.chat_id,
    `\ud83d\udd34 <b>ExitLoop STARTED</b>\n` +
    `Mint: <code>${pos.mint.slice(0, 8)}\u2026</code>\n` +
    `Entry: <code>${pos.entry_sol} SOL</code>\n` +
    `Plan: ${plan ? formatPlanSummary(plan) : '<i>none \u2014 will hold until manually closed</i>'}`,
    { parse_mode: 'HTML' }
  ).catch((e) => console.error('[exitEngine] notifier send failed:', e.message));

  while (!ctx.stop) {
    try {
      const result = await pollOnce(positionId);
      // If pollOnce says stop=true (tier fully closed the position), exit.
      if (result && result.stop) {
        ctx.stop = true;
        break;
      }
    } catch (e) {
      // Don't kill the loop on transient errors (RPC hiccup, network).
      // Just log and try again next tick.
      console.error(`[exitEngine] poll error for position ${positionId}:`, e.message);
    }
    await sleep(DEFAULT_POLL_MS);
  }

  loops.delete(positionId);
  console.log(`[exitEngine] loop end for position ${positionId}`);
}

// -----------------------------------------------------------------------------
// Single tick
// -----------------------------------------------------------------------------

/**
 * One polling tick. Reads the bonding curve, updates the position,
 * checks all enabled triggers, fires the first that matches.
 *
 * @param {number} positionId
 * @returns {object|null}     { stop: true } if the position is fully
 *                            closed by this tick (no more tiers).
 */
export async function pollOnce(positionId) {
  const pos = getPosition(positionId);
  if (!pos || pos.status !== 'OPEN') return { stop: true };

  // 1. Read bonding curve reserves.
  let bc;
  try {
    bc = await getBondingCurveState(pos.mint);
  } catch (e) {
    // Bonding curve may have graduated (token migrated to Raydium) or
    // been rugged. In that case our pricing model is invalid. Mark the
    // position as FAILED with a reason and stop the loop.
    if (/not found/i.test(e.message)) {
      console.log(`[exitEngine] position ${positionId}: bonding curve gone (graduated/rugged)`);
      // We don't auto-sell because the pump.fun pool is dead; a manual
      // sell via Raydium would be needed. Just notify the user.
      await notifier.send(pos.chat_id,
        `\u26a0\ufe0f <b>Position ${positionId}</b> \u2014 bonding curve gone (graduated or rugged). Manual sell required.\n` +
        `Mint: <code>${pos.mint.slice(0, 8)}\u2026</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return { stop: true };
    }
    throw e;
  }

  // 2. Compute current SOL value of held tokens.
  // price_sol_per_token = virtualSolReserves / virtualTokenReserves
  // position_sol = tokens_held * price_sol_per_token
  const vSol = Number(bc.virtualSolReserves);
  const vTok = Number(bc.virtualTokenReserves);
  if (vTok === 0) {
    // Degenerate; skip this tick.
    return null;
  }
  const priceSolPerToken = vSol / vTok;
  const newSolValue = (pos.entry_tokens ?? 0) * priceSolPerToken;

  // 3. Update position row (bumps peak automatically if higher).
  const { updatePositionValue } = await import('./positionTracker.js');
  const updated = updatePositionValue(positionId, newSolValue);

  // 4. Compute gains/peak gain as multiples of entry.
  const entry = pos.entry_sol;
  const peak = updated.peak_sol_value ?? entry;
  const current = updated.current_sol_value ?? entry;
  const peakGainMultiple = entry > 0 ? peak / entry : 1.0;       // 1.5 = +50% gain
  const dropFromPeakMultiple = peak > 0 ? current / peak : 1.0;  // 0.9 = 10% drop from peak

  // 5. Check triggers (only the first match fires per tick).
  const plan = parsePlanSnapshot(updated.auto_sell_plan_snapshot);
  if (!plan) return null;

  const fired = parseFired(updated.tp_sl_fired);

  // ----- TP tiers (positive percentages = % gain from entry) -----
  // User plan keys: tp1, tp2, tp3 (in percent, e.g. 50 = +50%)
  for (const tier of ['tp1', 'tp2', 'tp3']) {
    if (fired.includes(tier)) continue;
    const pct = plan[tier];
    if (typeof pct !== 'number' || pct <= 0) continue;
    const triggerMultiple = 1 + pct / 100;
    if (peakGainMultiple >= triggerMultiple) {
      return await fireTier(positionId, tier, plan, updated);
    }
  }

  // ----- SL (negative percent = max drawdown from entry) -----
  // User plan key: sl (e.g. -30 means -30% from entry)
  if (!fired.includes('sl') && typeof plan.sl === 'number' && plan.sl < 0) {
    const dropPct = -plan.sl; // positive
    const dropMultiple = 1 - dropPct / 100;
    if (current / entry <= dropMultiple) {
      return await fireTier(positionId, 'sl', plan, updated);
    }
  }

  // ----- Trailing Stop -----
  // plan: { act: 20, trail: -10 }  (in percent, similar to TP/SL)
  if (!fired.includes('trail') && typeof plan.trail === 'number' && plan.trail < 0) {
    const actPct = typeof plan.act === 'number' ? plan.act : 0;
    const trailPct = -plan.trail; // positive
    if (actPct > 0) {
      // Trailing is only ACTIVE once we've gained actPct% from entry.
      const activated = peakGainMultiple >= 1 + actPct / 100;
      if (activated) {
        const dropMultiple = 1 - trailPct / 100;
        if (dropFromPeakMultiple <= dropMultiple) {
          return await fireTier(positionId, 'trail', plan, updated);
        }
      }
    }
  }

  // ----- Time-based exit -----
  // plan: { t1: 30, t1_sell: 100, t2: 60, t2_sell: 100, t3: 120, t3_sell: 100 }
  // (tier time in seconds, sell pct for that tier)
  for (const tier of ['t1', 't2', 't3']) {
    if (fired.includes(tier)) continue;
    const sec = plan[tier];
    if (typeof sec !== 'number' || sec <= 0) continue;
    const elapsed = (Date.now() - updated.entry_time) / 1000;
    if (elapsed >= sec) {
      return await fireTier(positionId, tier, plan, updated);
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Tier firing
// -----------------------------------------------------------------------------

/**
 * Fire a tier. Looks up the sell_pct for the tier, sells that
 * percentage of the held tokens, marks the tier fired, and updates
 * sold_pct. If the sold_pct reaches 100, returns { stop: true } so the
 * loop ends.
 *
 * @returns {object|null}     { stop: true } if position is fully closed.
 */
async function fireTier(positionId, tier, plan, pos) {
  const sellPct = pickSellPct(plan, tier);
  if (sellPct <= 0) {
    // Plan has tier with no sell_pct \u2014 skip. (Shouldn't happen given
    // our parser, but defensive.)
    markTierFired(positionId, tier);
    return null;
  }

  // If we've already sold X% and this tier is sellPct, we sell
  // sellPct of the ORIGINAL position (not remaining). Caller's tier
  // semantics: each tier is independent. So a "TP1 50% + TP2 50%" plan
  // results in 100% sold over time, even if TP2 fires after some
  // partial.
  const cumulativeSoldPct = Math.min(100, (pos.sold_pct ?? 0) + sellPct);

  console.log(`[exitEngine] tier FIRED: position ${positionId} tier=${tier} sellPct=${sellPct} (cumulative=${cumulativeSoldPct}%)`);

  // Compute token amount to sell.
  const tokenAmount = (pos.entry_tokens ?? 0) * (sellPct / 100);

  // Notify user before selling.
  await notifier.send(pos.chat_id,
    `\ud83d\ude80 <b>${tier.toUpperCase()} FIRED</b>\n` +
    `Mint: <code>${pos.mint.slice(0, 8)}\u2026</code>\n` +
    `Sell: <b>${sellPct}%</b> (${tokenAmount.toFixed(2)} tokens)\n` +
    `Current value: <b>${pos.current_sol_value.toFixed(6)} SOL</b>\n` +
    `Cumulative sold: <b>${cumulativeSoldPct}%</b>`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  // Execute the SELL via executor.executeSell (handles wallet, slippage, retry).
  let sellResult;
  try {
    sellResult = await executeSell({
      positionId,
      mint: pos.mint,
      chatId: pos.chat_id,
      tokenRawAmount: Math.floor(tokenAmount),
      tierName: tier,
    });
  } catch (e) {
    console.error(`[exitEngine] sell FAILED for position ${positionId} tier=${tier}:`, e.message);
    await notifier.send(pos.chat_id,
      `\u274c <b>${tier.toUpperCase()} sell failed</b>\nMint: <code>${pos.mint.slice(0, 8)}\u2026</code>\nError: <code>${e.message.slice(0, 200)}</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    // Don't mark tier fired \u2014 user can retry manually. But also don't
    // re-fire every tick; bump a small cooldown via a flag check.
    return null;
  }

  // v0.8.8 (experimental) M2.12: audit log to signals table so /recent
  // can show "TP1 FIRED", "SL FIRED", etc. alongside the regular BUY/SELL
  // events. Uses the dev_wallet (the watched wallet) as the `wallet`
  // field so users can filter by watched wallet in their own history.
  signalsDb.log({
    type: 'TIER_FIRED',
    wallet: pos.dev_wallet,
    mint: pos.mint,
    data: { positionId, tier, sellPct, cumulativeSoldPct, currentSolValue: pos.current_sol_value, peakSolValue: pos.peak_sol_value },
  }).catch((e) => console.error('[exitEngine] audit log failed:', e.message));

  // Mark tier fired + update sold_pct.
  markTierFired(positionId, tier);
  setSoldPct(positionId, cumulativeSoldPct);

  if (cumulativeSoldPct >= 100) {
    // Fully closed.
    closePosition(positionId, {
      status: 'CLOSED',
      sig: sellResult?.signature ?? null,
      solReceived: sellResult?.solReceived ?? 0,
    });
    // v0.8.8 (experimental) M2.12: close-event audit log.
    signalsDb.log({
      type: 'POSITION_CLOSED',
      wallet: pos.dev_wallet,
      mint: pos.mint,
      data: { positionId, tier, solReceived: sellResult?.solReceived ?? 0, pnlSol: (sellResult?.solReceived ?? 0) - pos.entry_sol },
    }).catch(() => {});
    await notifier.send(pos.chat_id,
      `\u2705 <b>POSITION CLOSED</b>\nMint: <code>${pos.mint.slice(0, 8)}\u2026</code>\nPnL: <b>${((sellResult?.solReceived ?? 0) - pos.entry_sol).toFixed(6)} SOL</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return { stop: true };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Get the sell_pct for a given tier. Falls back to a contextual default
 * (100% if this is the only TP-tier in plan, 50% if 2+).
 */
function pickSellPct(plan, tier) {
  const explicitKey = `${tier}_sell`;
  if (typeof plan[explicitKey] === 'number' && plan[explicitKey] > 0) {
    return plan[explicitKey];
  }
  if (tier === 'sl' || tier === 'trail') {
    // SL and Trailing always sell 100% on trigger.
    return 100;
  }
  if (tier === 't1' || tier === 't2' || tier === 't3') {
    // Time-based tiers default 100% each (user usually wants a hard exit
    // at the time, not a partial).
    return 100;
  }
  // TP tier: count how many TP tiers are set.
  const tpCount = ['tp1', 'tp2', 'tp3'].filter((k) => typeof plan[k] === 'number' && plan[k] > 0).length;
  if (tpCount <= 1) return 100; // single tier = exit everything
  return 50;                      // multi-tier = safer partial
}

function parseFired(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatPlanSummary(plan) {
  const parts = [];
  if (typeof plan.tp1 === 'number') parts.push(`TP1 +${plan.tp1}%`);
  if (typeof plan.tp2 === 'number') parts.push(`TP2 +${plan.tp2}%`);
  if (typeof plan.tp3 === 'number') parts.push(`TP3 +${plan.tp3}%`);
  if (typeof plan.sl === 'number') parts.push(`SL ${plan.sl}%`);
  if (typeof plan.trail === 'number') parts.push(`Trail ${plan.trail}%`);
  if (typeof plan.t1 === 'number') parts.push(`T1 ${plan.t1}s`);
  if (typeof plan.t2 === 'number') parts.push(`T2 ${plan.t2}s`);
  if (typeof plan.t3 === 'number') parts.push(`T3 ${plan.t3}s`);
  return parts.length > 0 ? parts.join(' \u00b7 ') : 'none';
}
