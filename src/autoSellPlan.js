// src/autoSellPlan.js
// =============================================================================
// Auto-Sell tier-by-tier helpers (v0.8.8 experimental M1.12)
// =============================================================================
// User feedback: raw JSON + presets is over-engineered. The user wants a
// simple click flow:
//   1. Tap "+ TP 1" → bot asks "Mau berapa %?" → user types 50 → done
//   2. Tap "+ TP 2" → same
//   3. Tap "+ SL"  → user types -30 → done
//
// Internally we still serialise to the JSON shape the executor expects:
//   tp_sl_plan       = { tiers:[{tp_pct, sell_pct}], sl_pct, sl_sell_pct }
//   trailing_stop    = { act_pct, trail_pct, sell_pct }
//   dev_sell_trigger = { mode, sell_pct }
//   time_sell_plan   = { tiers:[{after_s, sell_pct}] }
//
// This module owns:
//   - parseStored(key, rawJson): read existing JSON safely
//   - summarise(stored): one-line human readable ("TP1 +50/50 TP2 +100/50 SL -30/100")
//   - applyTierChange(key, slot, value, stored): mutate and serialise back
//   - AUTO_SELL_LAYOUT: ordered list of slot definitions per setting
//     (so the renderer in settingsMenu can build rows in display order)
// =============================================================================

// -----------------------------------------------------------------------------
// Layout: for each auto-sell setting, list the rows the user can edit.
// A row is either:
//   - an existing tier ("tp_sl_plan.tiers[0]", "time_sell_plan.tiers[1]")
//   - an "+ add" slot for a new tier
//   - a singleton field ("sl_pct", "trailing_stop.act_pct", ...)
// Slot IDs are stable strings the callback data uses.
// -----------------------------------------------------------------------------

const MAX_TP_TIERS = 3;     // TP 1, 2, 3
const MAX_TIME_TIERS = 3;

export const AUTO_SELL_LAYOUT = {
  tp_sl_plan: {
    label: '🎯 TP / SL Plan',
    header: 'Tap to add a Take-Profit level (sell X% when price is +Y% from entry).\nTap an existing tier to edit its %.',
    rows: [
      // tier slots (fixed 3)
      { id: 'tp1', kind: 'tier', tierIndex: 0, label: 'TP 1', addLabel: '+ TP 1' },
      { id: 'tp2', kind: 'tier', tierIndex: 1, label: 'TP 2', addLabel: '+ TP 2' },
      { id: 'tp3', kind: 'tier', tierIndex: 2, label: 'TP 3', addLabel: '+ TP 3' },
      // SL singleton (one allowed)
      { id: 'sl', kind: 'singleton', field: 'sl_pct', label: 'SL', addLabel: '+ SL' },
    ],
    emptyHint: 'Tap + TP 1 to add your first take-profit (e.g. +50%).',
  },
  trailing_stop: {
    label: '📉 Trailing Stop',
    header: 'Sells automatically once price drops X% from peak (after activation).\nExample: act +50% / trail -20% / sell 100% activates once price is +50% above entry; sells all if price then drops 20% from peak.',
    rows: [
      { id: 'act',  kind: 'singleton', field: 'act_pct',   label: 'Activate at +X%', addLabel: '+ Activate' },
      { id: 'tr',   kind: 'singleton', field: 'trail_pct', label: 'Trail -X%',       addLabel: '+ Trail' },
    ],
    emptyHint: 'Tap + Activate to set when trailing turns on.',
  },
  dev_sell_trigger: {
    label: '🚨 Dev Sell Auto-Exit',
    header: 'Auto-sell when the dev wallet sells.\nMode: "any" (any sell) or "whole" (full dump only). Sell % is the portion of YOUR position to exit.',
    rows: [
      { id: 'mode', kind: 'mode', field: 'mode', label: 'Mode', addLabel: '+ Mode' },
      { id: 'pct',  kind: 'singleton', field: 'sell_pct', label: 'Sell %', addLabel: '+ Sell %' },
    ],
    emptyHint: 'Tap + Mode to choose trigger (any / whole).',
  },
  time_sell_plan: {
    label: '⏱️ Time-based Exit',
    header: 'Sell X% of position after Y seconds of holding.\nExample: 30s/50%, 90s/100% = exit half after 30s, all after 90s.',
    rows: [
      { id: 't1', kind: 'timeTier', tierIndex: 0, label: 'After 30s', addLabel: '+ Tier 1 (default 30s)' },
      { id: 't2', kind: 'timeTier', tierIndex: 1, label: 'After 60s', addLabel: '+ Tier 2 (default 60s)' },
      { id: 't3', kind: 'timeTier', tierIndex: 2, label: 'After 120s', addLabel: '+ Tier 3 (default 120s)' },
    ],
    emptyHint: 'Tap + Tier 1 to add the first time-based exit.',
  },
};

// Default tier values for newly added tiers (the user only types ONE number per
// tier — the other field is auto-filled with these defaults).
const DEFAULTS = {
  // for tp_sl_plan tiers: user types tp_pct (e.g. 50), sell_pct defaults to 50
  tier_sell_pct_default: 50,
  // for time_sell_plan tiers: user types after_s (e.g. 60), sell_pct defaults to 100
  timeTier_sell_pct_default: 100,
  // trailing stop sell_pct defaults to 100 (sell everything when triggered)
  trailing_sell_pct_default: 100,
  // dev sell trigger sell_pct defaults to 100
  dev_sell_pct_default: 100,
  // dev sell trigger mode default
  dev_mode_default: 'any',
};

// -----------------------------------------------------------------------------
// parseStored / serialise
// -----------------------------------------------------------------------------

/** Read existing stored JSON safely. Returns {} when missing or invalid. */
export function parseStored(rawJson) {
  if (!rawJson) return {};
  try { return JSON.parse(rawJson); } catch { return {}; }
}

/** Serialise object back to JSON (or null if empty). */
export function serialise(obj) {
  const cleaned = stripEmpty(obj);
  return Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

// -----------------------------------------------------------------------------
// summarise(stored) — one-line pretty for the settings menu
// -----------------------------------------------------------------------------

export function summarise(key, stored) {
  if (!stored || Object.keys(stored).length === 0) return '—';
  const fmtPct = (n) => (n > 0 ? `+${n}%` : `${n}%`);
  if (key === 'tp_sl_plan') {
    const parts = [];
    if (Array.isArray(stored.tiers)) {
      stored.tiers.forEach((t, i) => {
        if (t && t.tp_pct != null) parts.push(`TP${i + 1} ${fmtPct(t.tp_pct)}/${t.sell_pct ?? 50}%`);
      });
    }
    if (stored.sl_pct != null) parts.push(`SL ${fmtPct(stored.sl_pct)}/${stored.sl_sell_pct ?? 100}%`);
    return parts.length ? parts.join('  ') : '—';
  }
  if (key === 'trailing_stop') {
    const parts = [];
    if (stored.act_pct != null) parts.push(`act ${fmtPct(stored.act_pct)}`);
    if (stored.trail_pct != null) parts.push(`trail ${fmtPct(stored.trail_pct)}`);
    if (stored.sell_pct != null) parts.push(`sell ${stored.sell_pct}%`);
    return parts.length ? parts.join(' / ') : '—';
  }
  if (key === 'dev_sell_trigger') {
    return `${stored.mode ?? '—'} → sell ${stored.sell_pct ?? 100}%`;
  }
  if (key === 'time_sell_plan') {
    if (!Array.isArray(stored.tiers) || stored.tiers.length === 0) return '—';
    return stored.tiers.map((t) => `${t.after_s}s/${t.sell_pct ?? 100}%`).join('  ');
  }
  return '—';
}

// -----------------------------------------------------------------------------
// applyTierChange — pure mutation, returns new object + human label
// -----------------------------------------------------------------------------
//
// API: applyTierChange(key, slot, action, inputText, stored) →
//   { ok: bool, obj?: updatedStored, json?: string, msg?: string }
//
// where:
//   key      = 'tp_sl_plan' | 'trailing_stop' | 'dev_sell_trigger' | 'time_sell_plan'
//   slot     = AUTO_SELL_LAYOUT[key].rows[i].id  ('tp1', 'sl', 'act', 'mode', ...)
//   action   = 'add' | 'edit' | 'remove'
//   inputText = user's reply text (number for tiers/singletons; 'any'|'whole' for dev mode)
//   stored   = current parsed object
//
// Returned obj is the *full* new stored object (caller persists it).

export function applyTierChange(key, slot, action, inputText, stored) {
  const layout = AUTO_SELL_LAYOUT[key];
  if (!layout) return { ok: false, msg: 'Unknown auto-sell setting' };
  const row = layout.rows.find((r) => r.id === slot);
  if (!row) return { ok: false, msg: `Unknown slot: ${slot}` };

  const obj = { ...stored };
  if (key === 'tp_sl_plan') {
    if (row.kind === 'tier') {
      obj.tiers = Array.isArray(obj.tiers) ? [...obj.tiers] : [];
      const idx = row.tierIndex;
      if (action === 'remove') {
        obj.tiers.splice(idx, 1);
        return commitTierChange(key, obj, `Removed ${row.label}`);
      }
      const n = parseNumber(inputText, { min: 1, max: 100000 });
      if (n == null) return { ok: false, msg: 'Invalid number. Send like: 50 (or +50).' };
      obj.tiers[idx] = { tp_pct: n, sell_pct: obj.tiers[idx]?.sell_pct ?? DEFAULTS.tier_sell_pct_default };
      return commitTierChange(key, obj, `${row.label} set to +${n}% (sell ${obj.tiers[idx].sell_pct}%)`);
    }
    if (row.kind === 'singleton' && row.field === 'sl_pct') {
      if (action === 'remove') { delete obj.sl_pct; delete obj.sl_sell_pct; return commitTierChange(key, obj, 'SL removed'); }
      const n = parseNumber(inputText, { min: -100, max: 0 });
      if (n == null) return { ok: false, msg: 'SL must be a NEGATIVE number between -100 and 0 (e.g. -30).' };
      obj.sl_pct = n;
      obj.sl_sell_pct = obj.sl_sell_pct ?? 100;
      return commitTierChange(key, obj, `SL set to ${n}% (sell ${obj.sl_sell_pct}%)`);
    }
  }

  if (key === 'trailing_stop') {
    if (row.field === 'act_pct') {
      if (action === 'remove') { delete obj.act_pct; return commitTierChange(key, obj, 'Activate removed'); }
      const n = parseNumber(inputText, { min: 1, max: 100000 });
      if (n == null) return { ok: false, msg: 'Invalid number. Send like: 50.' };
      obj.act_pct = n;
      if (obj.trail_pct == null) return commitTierChange(key, obj, `Activate set to +${n}%. Now add a Trail value (tap + Trail).`);
      return commitTierChange(key, obj, `Activate set to +${n}%`);
    }
    if (row.field === 'trail_pct') {
      if (action === 'remove') { delete obj.trail_pct; return commitTierChange(key, obj, 'Trail removed'); }
      const n = parseNumber(inputText, { min: -100, max: 0 });
      if (n == null) return { ok: false, msg: 'Trail must be NEGATIVE (e.g. -20). It is how far price can drop from peak before selling.' };
      obj.trail_pct = n;
      if (obj.act_pct == null) return commitTierChange(key, obj, `Trail set to ${n}%. Now add an Activate value (tap + Activate).`);
      obj.sell_pct = obj.sell_pct ?? DEFAULTS.trailing_sell_pct_default;
      return commitTierChange(key, obj, `Trail set to ${n}% (sell ${obj.sell_pct}%)`);
    }
  }

  if (key === 'dev_sell_trigger') {
    if (row.field === 'mode') {
      if (action === 'remove') { delete obj.mode; return commitTierChange(key, obj, 'Mode removed'); }
      const v = String(inputText || '').trim().toLowerCase();
      let mode;
      if (v === 'any' || v === 'any_amount') mode = 'any_amount';
      else if (v === 'whole' || v === 'whole_amount') mode = 'whole_amount';
      else return { ok: false, msg: 'Send "any" or "whole".' };
      obj.mode = mode;
      return commitTierChange(key, obj, `Mode set to ${mode}`);
    }
    if (row.field === 'sell_pct') {
      if (action === 'remove') { delete obj.sell_pct; return commitTierChange(key, obj, 'Sell % removed'); }
      const n = parseNumber(inputText, { min: 1, max: 100 });
      if (n == null) return { ok: false, msg: 'Sell % must be 1-100.' };
      obj.sell_pct = n;
      return commitTierChange(key, obj, `Sell ${n}% of position`);
    }
  }

  if (key === 'time_sell_plan') {
    if (row.kind === 'timeTier') {
      obj.tiers = Array.isArray(obj.tiers) ? [...obj.tiers] : [];
      const idx = row.tierIndex;
      if (action === 'remove') {
        obj.tiers.splice(idx, 1);
        return commitTierChange(key, obj, `Removed ${row.label}`);
      }
      const n = parseNumber(inputText, { min: 1, max: 86400 });
      if (n == null) return { ok: false, msg: 'Invalid number of seconds. Send like: 60.' };
      obj.tiers[idx] = { after_s: n, sell_pct: obj.tiers[idx]?.sell_pct ?? DEFAULTS.timeTier_sell_pct_default };
      return commitTierChange(key, obj, `${row.label}: ${n}s / sell ${obj.tiers[idx].sell_pct}%`);
    }
  }

  return { ok: false, msg: 'Unhandled action' };
}

function commitTierChange(key, obj, msg) {
  const json = serialise(obj);
  return { ok: true, obj, json, msg, summarise: summarise(key, obj) };
}

function parseNumber(text, { min = -Infinity, max = Infinity } = {}) {
  if (text == null) return null;
  const s = String(text).trim().replace(/^\+/, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// -----------------------------------------------------------------------------
// Auto-sell slot lookup helpers (used by telegramBot routing)
// -----------------------------------------------------------------------------

export function isAutoSellSlot(slotId) {
  for (const layout of Object.values(AUTO_SELL_LAYOUT)) {
    if (layout.rows.some((r) => r.id === slotId)) return true;
  }
  return false;
}

export function isAutoSellSetting(key) {
  return Object.prototype.hasOwnProperty.call(AUTO_SELL_LAYOUT, key);
}

export function getAutoSellKeyForSlot(settingKey, slotId) {
  // The setting key is already known (passed from the parent menu row tap).
  // We just need to confirm the slot belongs to this layout.
  const layout = AUTO_SELL_LAYOUT[settingKey];
  if (!layout) return null;
  const row = layout.rows.find((r) => r.id === slotId);
  return row ? settingKey : null;
}