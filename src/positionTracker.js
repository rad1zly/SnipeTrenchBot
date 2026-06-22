// src/positionTracker.js
// =============================================================================
// Position tracker for the v0.8.8 (experimental) M2 exit engine.
//
// Each open position is tracked in the `positions` table with these key
// columns (M2.1):
//   - current_sol_value   live SOL value of the held position, refreshed on
//                         every price poll tick
//   - peak_sol_value      highest current_sol_value observed since open —
//                         used by the Trailing Stop trigger
//   - last_check_at       epoch ms of the most recent price observation;
//                         lets us detect a stale / dropped feed
//   - sold_pct            % of entry already sold (TP1 50% would set 0.5)
//   - tp_sl_fired         JSON array of tier names already executed
//                         (["tp1", "tp2", "sl"]) — used so we don't fire
//                         the same tier twice
//   - auto_sell_plan_snapshot
//                         JSON: copy of the user's plan at entry time so
//                         plan changes mid-trade don't retro-fire tiers
//
// This module is the *writer* side — it just updates columns. The
// *decider* (which tier to fire next) lives in `exitEngine.js` and reads
// the live values from here. The split is intentional: tracker stays
// dumb so it can be called from many places (poll tick, retry, manual
// override) without coupling to exit-decision logic.
// =============================================================================

import { getDb } from './db.js';

/**
 * Open a fresh position row. Called from executor.js on BUY_OK.
 *
 * @param {object} args
 * @param {string} args.mint            token mint
 * @param {string} args.devWallet       dev wallet (the watched one)
 * @param {number} args.chatId          owner chat
 * @param {number} args.entrySol        SOL spent on the buy (incl. tip)
 * @param {number} args.entryTokens     token amount received
 * @param {string|null} args.entrySig   buy tx signature
 * @param {object|null} args.autoSellPlan
 *                                      snapshot of user's TP/SL/trailing/
 *                                      time-sell plan at entry time. The
 *                                      executor passes this through so
 *                                      that plan edits mid-trade don't
 *                                      retroactively enable/disable tiers.
 * @returns {number}                    new position id (auto-increment)
 */
export function openPosition({ mint, devWallet, chatId, entrySol, entryTokens, entrySig, autoSellPlan = null }) {
  const d = getDb();
  const now = Date.now();
  // Initial peak = entry (no gain yet, but we want a non-null value
  // so trailing-stop logic doesn't have to special-case NULL).
  const result = d.prepare(`
    INSERT INTO positions (
      mint, dev_wallet, chat_id, entry_sig, entry_time, entry_sol, entry_tokens,
      current_sol_value, peak_sol_value, last_check_at, sold_pct, tp_sl_fired,
      auto_sell_plan_snapshot, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'OPEN', ?)
  `).run(
    mint,                // 1. mint
    devWallet,           // 2. dev_wallet
    chatId,              // 3. chat_id
    entrySig ?? null,    // 4. entry_sig
    now,                 // 5. entry_time
    entrySol,            // 6. entry_sol
    entryTokens,         // 7. entry_tokens
    entrySol,            // 8. current_sol_value (== entry on open)
    entrySol,            // 9. peak_sol_value (== entry on open)
    now,                 // 10. last_check_at
    JSON.stringify([]),  // 11. tp_sl_fired (no tiers fired yet)
    autoSellPlan ? JSON.stringify(autoSellPlan) : null, // 12. auto_sell_plan_snapshot
    now,                 // 13. created_at
  );
  return Number(result.lastInsertRowid);
}

/**
 * Update the live SOL value of a position. Called every poll tick.
 * If new value > peak, peak is bumped (this is the trailing stop
 * reference point).
 *
 * @param {number} positionId
 * @param {number} newSolValue     live SOL value of held tokens
 * @returns {object}               updated row (peak included)
 */
export function updatePositionValue(positionId, newSolValue) {
  const d = getDb();
  const now = Date.now();
  // Use GREATEST via a subquery so we don't need two round trips.
  d.prepare(`
    UPDATE positions
       SET current_sol_value = ?,
           peak_sol_value   = MAX(IFNULL(peak_sol_value, 0), ?),
           last_check_at    = ?
     WHERE id = ?
  `).run(newSolValue, newSolValue, now, positionId);
  return getPosition(positionId);
}

/**
 * Mark a tier as fired (idempotent — caller decides).
 * @param {number} positionId
 * @param {string} tierName          e.g. "tp1", "tp2", "sl", "trail", "t1"
 * @returns {string[]}               new tp_sl_fired array
 */
export function markTierFired(positionId, tierName) {
  const d = getDb();
  const pos = getPosition(positionId);
  if (!pos) return [];
  const fired = parseFired(pos.tp_sl_fired);
  if (fired.includes(tierName)) return fired;
  fired.push(tierName);
  d.prepare(`UPDATE positions SET tp_sl_fired = ? WHERE id = ?`)
    .run(JSON.stringify(fired), positionId);
  return fired;
}

/**
 * v0.8.8 M6.2 step 2: mark a position as graduated to pump.fun AMM.
 * Idempotent — only updates if is_graduated is currently 0. Returns
 * the new state (true if newly marked, false if already graduated).
 */
export function markGraduated(positionId, ammPoolAddress = null) {
  const d = getDb();
  const pos = getPosition(positionId);
  if (!pos) return false;
  if (pos.is_graduated) return false;  // already graduated
  d.prepare(`UPDATE positions SET is_graduated = 1, amm_pool_address = ?, graduated_at = ? WHERE id = ?`)
    .run(ammPoolAddress, Date.now(), positionId);
  return true;
}

/**
 * Add to the sold_pct (caller passes the absolute pct sold, not delta).
 * This is the canonical "what's been sold" counter. The exit engine
 * checks this so it doesn't try to sell more than the user has left.
 *
 * @param {number} positionId
 * @param {number} soldPct           percent of entry already sold (0-100)
 */
export function setSoldPct(positionId, soldPct) {
  const d = getDb();
  d.prepare(`UPDATE positions SET sold_pct = ? WHERE id = ?`).run(soldPct, positionId);
}

/**
 * Close a position row. Called from executor.js on SELL_OK or SELL_FAIL.
 *
 * @param {number} positionId
 * @param {object} exit              { sig, solReceived, failReason, status }
 */
export function closePosition(positionId, exit) {
  const d = getDb();
  const pos = getPosition(positionId);
  if (!pos) return;
  const now = Date.now();
  const pnlSol = (exit.solReceived ?? 0) - pos.entry_sol;
  const pnlPct = pos.entry_sol > 0 ? (pnlSol / pos.entry_sol) * 100 : 0;
  d.prepare(`
    UPDATE positions
       SET status      = ?,
           exit_sig    = ?,
           exit_time   = ?,
           exit_sol    = ?,
           pnl_sol     = ?,
           pnl_percent = ?,
           hold_ms     = ?
     WHERE id = ?
  `).run(
    exit.status, // 'CLOSED' or 'FAILED'
    exit.sig ?? null,
    exit.status === 'CLOSED' ? now : null,
    exit.solReceived ?? null,
    pnlSol,
    pnlPct,
    pos.status === 'OPEN' ? now - pos.entry_time : pos.hold_ms,
    positionId,
  );
}

/**
 * Read a single position by id.
 * @param {number} positionId
 * @returns {object|null}
 */
export function getPosition(positionId) {
  const d = getDb();
  return d.prepare(`SELECT * FROM positions WHERE id = ?`).get(positionId) ?? null;
}

/**
 * Get all OPEN positions for a chat (or across all chats if chatId is null).
 * Used by the exit engine's poll loop and by /positions.
 *
 * @param {number|null} chatId
 * @returns {object[]}
 */
export function getOpenPositions(chatId = null) {
  const d = getDb();
  if (chatId == null) {
    return d.prepare(`SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_time ASC`).all();
  }
  return d.prepare(`SELECT * FROM positions WHERE status = 'OPEN' AND chat_id = ? ORDER BY entry_time ASC`).all(chatId);
}

/**
 * Find a position by mint (used when executor needs to look up a
 * position to attach an exit plan to).
 *
 * @param {string} mint
 * @returns {object|null}
 */
export function getOpenPositionByMint(mint) {
  const d = getDb();
  return d.prepare(`SELECT * FROM positions WHERE mint = ? AND status = 'OPEN' LIMIT 1`).get(mint);
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

/**
 * Parse tp_sl_fired JSON safely. Empty / null / malformed => [].
 */
function parseFired(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Parse the auto_sell_plan_snapshot JSON safely.
 * @param {string|null} raw
 * @returns {object|null}
 */
export function parsePlanSnapshot(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
