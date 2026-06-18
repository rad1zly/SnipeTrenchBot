// src/settings.js
// =============================================================================
// Runtime-mutable settings (DB-backed, env fallback).
//
// Each setting has: key, type, default, env key (optional), validator, and
// formatter (for menu display). DB row wins; env wins; default wins.
//
// The menu UI in telegramBot.js / settingsMenu.js reads the catalog to build
// the keyboard and the edit prompts. The executor reads via the typed getters
// (getBool/getNumber/getString) at trade time so a change is live immediately.
// =============================================================================

import { settingsDb, positionsDb } from './db.js';

// -----------------------------------------------------------------------------
// Catalog — every mutable setting, in the order the menus display them.
// -----------------------------------------------------------------------------
//
//   key             : settings key in DB (string)
//   type            : 'bool' | 'number' | 'text' | 'time' (HH:MM UTC)
//   category        : 'trade' | 'filters' | 'token' | 'time' | 'advanced'
//   label           : short human name
//   env             : env key for fallback (e.g. 'SLIPPAGE_BPS')
//   default         : fallback default value (must be JSON-serializable)
//   validate        : (raw) => { ok, value, error? }   — value is normalized
//   format          : (value) => string for menu display
//   parseUserInput  : (text) => normalized value, or null if invalid
// -----------------------------------------------------------------------------

const CATALOG = [
  // ── Trade ──────────────────────────────────────────────────────────────
  {
    key: 'fixed_buy_sol', type: 'number', category: 'trade',
    label: 'Fixed Buy (SOL)',
    env: 'MAX_SOL_PER_TRADE', default: 0.01,
    min: 0.0001,        // no upper bound — user can set 0.001 or 1000 if they want
    parseUserInput: (t) => {
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'buy_limit_per_token', type: 'number', category: 'trade',
    label: 'Buy Limit per Token',
    default: 1,
    min: 1, max: 3,      // KEEP BOUNDED — this is a CHOICE (1, 2, or 3 buys per token), not a continuous range
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1 || n > 3) return null;
      return n;
    },
  },
  {
    key: 'slippage_bps', type: 'number', category: 'trade',
    label: 'Buy Slippage (bps)',
    env: 'SLIPPAGE_BPS', default: 500,
    min: 1,             // no upper bound — user can set 50 or 50000 if they want
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1) return null;
      return n;
    },
  },
  {
    key: 'pump_slippage_bps', type: 'number', category: 'trade',
    label: 'PUMP Slippage (bps)',
    default: 1500,
    min: 1,             // no upper bound
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1) return null;
      return n;
    },
  },
  {
    key: 'buy_priority_fee_sol', type: 'number', category: 'trade',
    label: 'Buy Priority Fee (SOL)',
    default: 0.0,
    min: 0,             // no upper bound
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return 0;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'buy_tip_sol', type: 'number', category: 'trade',
    label: 'Buy Tip 🚀 (SOL)',
    default: 0.0,
    min: 0,             // no upper bound
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return 0;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'anti_mev', type: 'bool', category: 'trade',
    label: 'Anti-MEV Buy',
    default: false,
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
      if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
      return null;
    },
  },
  {
    // v0.1.1 setting. When OFF, the executor would (eventually) leave the
    // position OPEN after HOLD_MS instead of auto-selling. v0.5.3 keeps the
    // setting in the catalog for parity with the docs and for the safety
    // snapshot's autoSell field; the executor's buy→hold→sell flow always
    // sells. Default true = current behavior.
    key: 'auto_sell', type: 'bool', category: 'trade',
    label: 'Auto Sell',
    default: true,
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
      if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false;
      return null;
    },
  },
  {
    key: 'auto_retry', type: 'number', category: 'trade',
    label: 'Auto Retry (count)',
    default: 0,
    min: 0, max: 5,
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 0 || n > 5) return null;
      return n;
    },
  },

  // ── Filters ────────────────────────────────────────────────────────────
  {
    key: 'unrenounced_only', type: 'bool', category: 'filters',
    label: 'Unrenounced Only',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'unburned_only', type: 'bool', category: 'filters',
    label: 'Unburned Only',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'exclude_internal', type: 'bool', category: 'filters',
    label: 'Exclude Internal',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'exclude_external', type: 'bool', category: 'filters',
    label: 'Exclude External',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'min_mc_usd', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'filters',
    label: 'Min MC (USD)',
    default: null,  // null = unlimited. User can type any positive number.
    min: 0,        // no upper bound — user can set "0.001" or "1000000000" if they want
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'max_mc_usd', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'filters',
    label: 'Max MC (USD)',
    default: null,
    min: 0,        // no upper bound
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'min_token_age_min', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'filters',
    label: 'Min Token Age (s)',  // v0.8.0: unit changed to seconds
    default: null,
    min: 0,        // no upper bound
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'max_token_age_min', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'filters',
    label: 'Max Token Age (s)',  // v0.8.0: unit changed to seconds
    default: null,
    min: 0,        // no upper bound
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    // v0.8.0: min sell ratio. If the dev wallet sold less than this fraction
    // of their token holdings, the bot skips the copy-trade. Helps avoid
    // copy-trading partial sells (where the dev still has skin in the game).
    // Stored as a fraction in [0.1, 1.0] (e.g. 0.9 = 90%). Default 0.9
    // matches the typical "dev fully exits" intent. Set to 0.1 to copy every
    // sell, or 1.0 to require a 100% dump.
    key: 'min_sell_ratio', type: 'number', category: 'filters',
    label: 'Min Sell Ratio (0.1-1.0)',
    default: 0.9,
    min: 0.1,
    max: 1.0,
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', ''].includes(s)) return null;
      // Accept both 0.9 and 90 (interpreted as 90%)
      let n = parseFloat(t);
      if (Number.isNaN(n)) return null;
      if (n > 1) n = n / 100; // 90 → 0.9
      if (n < 0.1 || n > 1.0) return null;
      return n;
    },
  },

  // ── Token ──────────────────────────────────────────────────────────────
  {
    key: 'sol_spending_limit', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'token',
    label: 'SOL Spending Limit (daily)',
    default: null,
    min: 0,        // no upper bound — user can set "0.5" or "10000" if they want
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },

  // ── Time ───────────────────────────────────────────────────────────────
  {
    key: 'start_time', type: 'time', category: 'time',
    label: 'Start Time (UTC, HH:MM)',
    default: '00:00',
    parseUserInput: (t) => {
      const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    },
  },
  {
    key: 'end_time', type: 'time', category: 'time',
    label: 'End Time (UTC, HH:MM)',
    default: '23:59',
    parseUserInput: (t) => {
      const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    },
  },

  // ── Advanced ───────────────────────────────────────────────────────────
  {
    key: 'tag', type: 'text', category: 'advanced',
    label: 'Tag (label for this watcher)',
    default: '',
    maxLen: 32,
    parseUserInput: (t) => t.trim().slice(0, 32),
  },
  {
    key: 'hold_ms', type: 'number', category: 'advanced',
    label: 'Hold Time (ms)',
    env: 'HOLD_MS', default: 1000,
    min: 1,             // no upper bound — user can set 500 or 999999999 if they want
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1) return null;
      return n;
    },
  },
];

// Index by key for O(1) lookup
const BY_KEY = Object.fromEntries(CATALOG.map((s) => [s.key, s]));

function readEnvFor(setting) {
  if (!setting.env) return undefined;
  const raw = process.env[setting.env];
  if (raw == null || raw === '') return undefined;
  if (setting.type === 'bool') {
    return raw.toLowerCase() === 'true' || raw === '1';
  }
  if (setting.type === 'number') {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? undefined : n;
  }
  return raw;
}

function coerceByType(setting, value) {
  if (value == null) return setting.default ?? null;
  if (setting.type === 'bool') return Boolean(value);
  if (setting.type === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? (setting.default ?? null) : n;
  }
  return String(value);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function listCatalog() {
  return CATALOG.map((s) => ({ ...s }));
}

export function getCatalogEntry(key) {
  return BY_KEY[key] || null;
}

export function byCategory(cat) {
  return CATALOG.filter((s) => s.category === cat);
}

/**
 * Resolve the current effective value for a setting.
 * Priority: DB > env > default. Type is coerced to the catalog type.
 */
export function get(key) {
  const setting = BY_KEY[key];
  if (!setting) return null;
  const row = settingsDb.get(key);
  if (row && row.value != null) {
    // `null` in JSON → user explicitly cleared; fall through to env/default
    if (row.value !== null) return coerceByType(setting, row.value);
  }
  const envVal = readEnvFor(setting);
  if (envVal !== undefined) return coerceByType(setting, envVal);
  return coerceByType(setting, setting.default);
}

/** Typed convenience: get a bool with a fallback. */
export function getBool(key, fallback = false) {
  const v = get(key);
  if (v == null) return fallback;
  return Boolean(v);
}

/** Typed convenience: get a number with a fallback. */
export function getNumber(key, fallback = 0) {
  const v = get(key);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** Typed convenience: get a string with a fallback. */
export function getString(key, fallback = '') {
  const v = get(key);
  if (v == null) return fallback;
  return String(v);
}

/** Set a setting in the DB. value is whatever the catalog type accepts. */
export function set(key, value) {
  const setting = BY_KEY[key];
  if (!setting) throw new Error(`Unknown setting: ${key}`);
  if (value == null) {
    // null = "Not Limited" for some, or "default" for others. Store as null.
    settingsDb.set(key, null);
    return;
  }
  // For bool: accept true/false directly
  // For number: accept any finite number
  // For text/time: accept any string
  if (setting.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`Setting ${key} expects a number, got ${value}`);
    }
    if (setting.min != null && n < setting.min) {
      throw new Error(`Setting ${key} must be >= ${setting.min}, got ${n}`);
    }
    if (setting.max != null && n > setting.max) {
      throw new Error(`Setting ${key} must be <= ${setting.max}, got ${n}`);
    }
    settingsDb.set(key, n);
  } else if (setting.type === 'bool') {
    settingsDb.set(key, Boolean(value));
  } else {
    settingsDb.set(key, String(value));
  }
}

/** Reset a setting to its env/default. Removes the DB row. */
export function reset(key) {
  if (!BY_KEY[key]) return false;
  settingsDb.delete(key);
  return true;
}

/** Reset all settings. */
export function resetAll() {
  for (const s of CATALOG) settingsDb.delete(s.key);
}

// -----------------------------------------------------------------------------
// Display formatters
// -----------------------------------------------------------------------------

/** Format a setting's current value for menu display. */
export function formatValue(key) {
  const setting = BY_KEY[key];
  if (!setting) return '?';
  const v = get(key);

  if (setting.type === 'bool') {
    // TradeWiz-style: ✅ Yes (green) when ON, 🟠 No (orange) when OFF
    return v ? '✅ Yes' : '🟠 No';
  }
  if (setting.type === 'time') {
    return v || '00:00';
  }
  if (setting.type === 'number' && (v === null || v === 0)) {
    // For "limit" type numbers, 0 / null = "Not Limited"
    if (['min_mc_usd', 'max_mc_usd', 'min_token_age_min', 'max_token_age_min',
         'sol_spending_limit', 'buy_priority_fee_sol', 'buy_tip_sol'].includes(key)) {
      return 'Not Limited';
    }
  }
  // v0.8.0: token age displayed in seconds (with m:ss for >=60s)
  if (setting.type === 'number' && (key === 'min_token_age_min' || key === 'max_token_age_min')) {
    if (v < 60) return `${v}s`;
    const m = Math.floor(v / 60);
    const s = v % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (setting.type === 'number' && setting.key === 'slippage_bps') {
    return `${v} bps (${(v / 100).toFixed(1)}%)`;
  }
  if (setting.type === 'number' && setting.key === 'pump_slippage_bps') {
    return `${v} bps (${(v / 100).toFixed(1)}%)`;
  }
  if (setting.type === 'number' && setting.key.endsWith('_sol')) {
    return `${v} SOL`;
  }
  if (setting.type === 'number' && setting.key === 'hold_ms') {
    return `${v} ms (${(v / 1000).toFixed(1)}s)`;
  }
  if (setting.type === 'number' && setting.key === 'min_sell_ratio') {
    // Sell ratio is a fraction in [0.1, 1.0]. Display as a percentage so the
    // menu is readable ("90% min sell" rather than "0.9 min sell ratio").
    return v == null ? 'Off' : `${(v * 100).toFixed(0)}%`;
  }
  if (setting.type === 'text' && (v == null || v === '')) {
    return '—';
  }
  return String(v);
}

/** Format a "source" tag: shows whether value comes from DB, env, or default. */
export function formatSource(key) {
  const setting = BY_KEY[key];
  if (!setting) return '';
  const row = settingsDb.get(key);
  if (row && row.value != null) return '🟢 DB';
  if (setting.env && process.env[setting.env]) return '🟡 env';
  return '⚪ default';
}

/** For toggling a bool via the menu. Returns the new value. */
export function toggle(key) {
  const setting = BY_KEY[key];
  if (!setting) throw new Error(`Unknown setting: ${key}`);
  if (setting.type !== 'bool') {
    throw new Error(`Setting ${key} is not a bool — use set() instead`);
  }
  const newValue = !getBool(key);
  set(key, newValue);
  return newValue;
}

// -----------------------------------------------------------------------------
// Time-window check
// -----------------------------------------------------------------------------

/**
 * Returns true if the current UTC time is within the active trading window.
 * Handles wrap-around: e.g. start=22:00 end=06:00 means 22:00-23:59 + 00:00-06:00.
 */
export function isInTimeWindow() {
  const start = getString('start_time', '00:00');
  const end = getString('end_time', '23:59');
  if (start === '00:00' && end === '23:59') return true; // full active

  const now = new Date();
  const utc = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  if (start <= end) {
    return utc >= start && utc <= end;
  }
  // wrap-around: e.g. 22:00 → 06:00
  return utc >= start || utc <= end;
}

/**
 * Total SOL spent on entries (open + closed) since the start of the UTC day.
 * Used by the daily-spend-cap safety check.
 */
export function spentSolToday() {
  const since = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();
  return positionsDb.spentSince(since);
}
