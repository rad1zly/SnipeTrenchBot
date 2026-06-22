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

import { userSettingsDb, positionsDb } from './db.js';

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
    key: 'fixed_buy_sol', type: 'number', category: 'trade', mode: 'both',
    label: 'Fixed Buy (SOL)',
    env: 'MAX_SOL_PER_TRADE', default: 0.01,
    min: 0.0001,        // no upper bound — user can set 0.001 or 1000 if they want
    parseUserInput: (t) => {
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  // v0.8.8 (experimental) M3.1b: copy_mode + copy_ratio were moved from
  // the global settings catalog to per-wallet (watched_wallets) config,
  // per user request "harusnya per wallet yg di target ada menu nya ini
  // mau di reverse copy atau copy trade biasa". The settings rows are
  // intentionally NOT defined here so they don't appear in /settings.
  // The /wallets menu lists each wallet with its current mode + ratio
  // and a button to change them.
  {
    key: 'buy_limit_per_token', type: 'number', category: 'trade', mode: 'both',
    label: 'Max Buys per Token',
    default: 1,
    min: 1, max: 3,      // KEEP BOUNDED — this is a CHOICE (1, 2, or 3 buys per token), not a continuous range
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1 || n > 3) return null;
      return n;
    },
  },
  {
    key: 'slippage_bps', type: 'number', category: 'trade', mode: 'both',
    label: 'Buy Slippage',
    unit: '%',          // M1.18: display as percent (1-100), stored as basis points internally
    env: 'SLIPPAGE_BPS', default: 500,
    min: 1,             // 1% = 100 bps. UI range 1%-100%. Internal storage unbounded.
    inputMax: 100,      // UI-only: user enters percent 1-100.
    parseUserInput: (t) => {
      const n = Number(String(t).replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(n) || n < 1 || n > 100) return null;
      return Math.round(n * 100); // percent → bps
    },
    formatValue: (v) => v == null ? '—' : `${(v / 100).toFixed(1)}%`,
  },
  {
    key: 'pump_slippage_bps', type: 'number', category: 'trade', mode: 'both',
    label: 'PUMP Buy Slippage',
    unit: '%',          // M1.18: display as percent
    default: 100,       // 100 bps = 1%. v0.8.7.14: tightened from 1500 bps (15%) → 100 bps (1%).
    min: 1,
    inputMax: 100,
    parseUserInput: (t) => {
      const n = Number(String(t).replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(n) || n < 1 || n > 100) return null;
      return Math.round(n * 100);
    },
    formatValue: (v) => v == null ? '—' : `${(v / 100).toFixed(1)}%`,
  },
  {
    key: 'pump_sell_slippage_bps', type: 'number', category: 'trade', mode: 'both',
    label: 'PUMP Sell Slippage',
    unit: '%',          // M1.18: display as percent
    default: 3000,      // 3000 bps = 30%. v0.8.7.11: widened from 1500 bps (15%) for fast-moving SELLs.
    min: 1,
    inputMax: 100,
    parseUserInput: (t) => {
      const n = Number(String(t).replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(n) || n < 1 || n > 100) return null;
      return Math.round(n * 100);
    },
  },
  {
    key: 'buy_priority_fee_sol', type: 'number', category: 'trade', mode: 'both',
    label: 'Buy Priority Fee',
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
  // Jito tip entries REMOVED in v0.8.8 (experimental) M1.20. Jito tip is now
  // a fixed admin config (env: JITO_BUY_TIP_SOL / JITO_SELL_TIP_SOL) in
  // config.js — not a per-user setting. Reference bot ships with a fixed
  // tip amount, so users don't need to tune it.
  {
    // v0.8.8 (experimental): Jito tip for SELL. Default 0 (no tip).
    key: 'jito_sell_tip_sol', type: 'number', category: 'trade', mode: 'both',
    label: 'Jito Sell Tip 🚀',
    hidden: true, // M1.20: moved to config (admin env). Kept here for back-compat reads; not in menu.
    default: 0.0,
    min: 0,
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return 0;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'anti_mev', type: 'bool', category: 'trade', mode: 'both',
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
    key: 'auto_sell', type: 'bool', category: 'trade', mode: 'both',
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
    key: 'auto_retry', type: 'number', category: 'trade', mode: 'both',
    label: 'Auto Retry',
    default: 0,
    min: 0, max: 5,
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 0 || n > 5) return null;
      return n;
    },
  },
  // ── v0.8.8 (experimental): Auto-Sell Plan (TP/SL/Trailing/DevSell/Time) ────
  // These settings drive the position-exit engine. They are stored as JSON
  // strings in user_settings (type 'text' with JSON parsing). Default is null
  // (= feature disabled). Setting a value like `{"enabled":true,...}` activates
  // the feature. See parseUserInput for schema validation.
  {
    key: 'tp_sl_plan', type: 'text', nullable: true, category: 'trade', mode: 'both',
    label: 'TP / SL Plan',
    default: null,  // null = disabled. Format: {"enabled":true,"tiers":[{"tp_pct":50,"sell_pct":50},...],"sl_pct":-30,"sl_sell_pct":100}
    parseUserInput: (t) => {
      const s = t.trim();
      if (['none', 'off', '0', ''].includes(s.toLowerCase())) return null;
      try {
        const obj = JSON.parse(s);
        if (typeof obj !== 'object' || obj === null) return null;
        if (obj.tiers && !Array.isArray(obj.tiers)) return null;
        if (obj.tiers) {
          for (const tier of obj.tiers) {
            if (typeof tier.tp_pct !== 'number' || typeof tier.sell_pct !== 'number') return null;
            if (tier.tp_pct <= 0 || tier.sell_pct <= 0 || tier.sell_pct > 100) return null;
          }
        }
        if (obj.sl_pct !== undefined && (typeof obj.sl_pct !== 'number' || obj.sl_pct >= 0)) return null;
        if (obj.sl_sell_pct !== undefined && (typeof obj.sl_sell_pct !== 'number' || obj.sl_sell_pct <= 0 || obj.sl_sell_pct > 100)) return null;
        return JSON.stringify(obj);
      } catch (e) { return null; }
    },
  },
  {
    key: 'trailing_stop', type: 'text', nullable: true, category: 'trade', mode: 'both',
    label: 'Trailing Stop',
    default: null,  // null = disabled. Format: {"enabled":true,"act_pct":20,"trail_pct":10,"sell_pct":100}
    parseUserInput: (t) => {
      const s = t.trim();
      if (['none', 'off', '0', ''].includes(s.toLowerCase())) return null;
      try {
        const obj = JSON.parse(s);
        if (typeof obj !== 'object' || obj === null) return null;
        if (typeof obj.act_pct !== 'number' || obj.act_pct <= 0) return null;
        if (typeof obj.trail_pct !== 'number' || obj.trail_pct <= 0) return null;
        if (typeof obj.sell_pct !== 'number' || obj.sell_pct <= 0 || obj.sell_pct > 100) return null;
        return JSON.stringify(obj);
      } catch (e) { return null; }
    },
  },
  {
    key: 'dev_sell_trigger', type: 'text', nullable: true, category: 'trade', mode: 'both',
    label: 'Dev Sell Trigger',
    hidden: true, // M1.18: removed from menu — user has Ratio menu that does this. Catalog kept for legacy/back-compat.
    default: null,  // null = disabled. Format: {"enabled":true,"mode":"any_amount"|"whole_amount","sell_pct":100}
    parseUserInput: (t) => {
      const s = t.trim();
      if (['none', 'off', '0', ''].includes(s.toLowerCase())) return null;
      try {
        const obj = JSON.parse(s);
        if (typeof obj !== 'object' || obj === null) return null;
        if (obj.mode && !['any_amount', 'whole_amount'].includes(obj.mode)) return null;
        if (obj.sell_pct !== undefined && (typeof obj.sell_pct !== 'number' || obj.sell_pct <= 0 || obj.sell_pct > 100)) return null;
        return JSON.stringify(obj);
      } catch (e) { return null; }
    },
  },
  {
    key: 'time_sell_plan', type: 'text', nullable: true, category: 'trade', mode: 'both',
    label: 'Time-based Exit',
    default: null,  // null = disabled. Format: {"enabled":true,"tiers":[{"after_s":30,"sell_pct":50},{"after_s":60,"sell_pct":100}]}
    parseUserInput: (t) => {
      const s = t.trim();
      if (['none', 'off', '0', ''].includes(s.toLowerCase())) return null;
      try {
        const obj = JSON.parse(s);
        if (typeof obj !== 'object' || obj === null) return null;
        if (obj.tiers && !Array.isArray(obj.tiers)) return null;
        if (obj.tiers) {
          for (const tier of obj.tiers) {
            if (typeof tier.after_s !== 'number' || tier.after_s <= 0) return null;
            if (typeof tier.sell_pct !== 'number' || tier.sell_pct <= 0 || tier.sell_pct > 100) return null;
          }
        }
        return JSON.stringify(obj);
      } catch (e) { return null; }
    },
  },
  {
    key: 'sl_pct', type: 'number', nullable: true, category: 'trade', mode: 'both',
    label: 'Stop Loss % (negative)',
    hidden: true,  // v0.8.8 (experimental): SL is now part of TP/SL Plan.
    default: null,  // null = disabled. E.g. -30 = sell all at -30% from entry.
    min: -100, max: -1,
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'off', '0', ''].includes(s)) return null;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n >= 0 || n < -100) return null;
      return n;
    },
  },

  // ── Filters ────────────────────────────────────────────────────────────
  {
    key: 'unrenounced_only', type: 'bool', category: 'filters', mode: 'both',
    label: 'Unrenounced Only',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'unburned_only', type: 'bool', category: 'filters', mode: 'both',
    label: 'Unburned Only',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'exclude_internal', type: 'bool', category: 'filters', mode: 'both',
    label: 'Skip pump.fun',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'exclude_external', type: 'bool', category: 'filters', mode: 'both',
    label: 'Skip Raydium / others',
    default: false,
    parseUserInput: (t) => /^(1|true|yes|on|y)$/i.test(t.trim()),
  },
  {
    key: 'min_mc_usd', type: 'number', nullable: true,  // v0.8.0: '0'/'none' sets to null (disabled)
    category: 'filters', mode: 'both',
    label: 'Min MC',
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
    category: 'filters', mode: 'both',
    label: 'Max MC',
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
    category: 'filters', mode: 'both',
    label: 'Min Token Age',  // v0.8.0: unit changed to seconds
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
    category: 'filters', mode: 'both',
    label: 'Max Token Age',  // v0.8.0: unit changed to seconds
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
    key: 'min_sell_ratio', type: 'number', category: 'filters', mode: 'both',
    label: 'Min Sell %',
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
    category: 'token', mode: 'both',
    label: 'SOL Spending Limit',
    default: null,
    min: 0,        // no upper bound — user can set "0.5" or "10000" if they want
    parseUserInput: (t) => {
      const s = t.trim().toLowerCase();
      if (['none', 'unlimited', 'off', '0', ''].includes(s)) return null;
      const n = parseFloat(t);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
    formatValue: (v) => v == null ? 'Not Limited' : `${formatSolAmount(v)} / day`,
  },

  // ── Time ───────────────────────────────────────────────────────────────
  {
    key: 'start_time', type: 'time', category: 'time', mode: 'both',
    label: 'Start Time',
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
    key: 'end_time', type: 'time', category: 'time', mode: 'both',
    label: 'End Time',
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
    key: 'tag', type: 'text', category: 'advanced', mode: 'both',
    label: 'Tag (label for this watcher)',
    default: '',
    maxLen: 32,
    parseUserInput: (t) => t.trim().slice(0, 32),
  },
  {
    key: 'hold_ms', type: 'number', category: 'advanced', mode: 'both',
    label: 'Hold Time',
    unit: 'ms',         // M1.19: input in ms (engine uses ms). Display shows s/m via formatValue.
    env: 'HOLD_MS', default: 1000,
    min: 1,             // no upper bound — user can set 500 or 999999999 if they want
    parseUserInput: (t) => {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < 1) return null;
      return n;
    },
  },
  // ---------------------------------------------------------------------------
  // v0.8.8 (experimental) M3.9: MIRROR-ONLY settings.
  // Shown only in the Copy Trade menu (NOT Reverse Copy). These come from
  // the TradeWiz reference bot screenshot (tg 01:02 user: "ada beberapa
  // fitur yang berbeda disitu, jadi lebih baik fitur copy trade sm reverse
  // copy trade menunya dipisah").
  //
  // Reference bot Copy Trade-only features:
  //   - Buy Ratio (% of target's buy)            — global default for size
  //   - Copy Sell (mirror target's exits)        — when target SELLS, also sell
  //   - Trader Buy Limit (min-max range)         — only copy if target buys X-Y SOL
  //   - No Duplicate Buys from Target            — anti-spam
  //   - Buy Times Reset after Sold               — reset counter on close
  //   - Sell Proportionally                      — sell % = target's sell %
  //   - Sell All When Trader Transfer Tokens     — auto-exit on transfer
  //   - Only copy Dev-Create                     — filter: only creator-created tokens
  //   - Min Token Liquidity (USD)                — filter: min liquidity
  //   - Anti-PVP Protection                      — filter: skip if same addr buys multiple times
  //   - Buy Dip                                  — custom signal
  //   - Turbo Mode                               — "simplified settings for faster setup"
  // ---------------------------------------------------------------------------
  {
    // Default copy ratio (%). Used as fallback when a watched wallet doesn't
    // have its own copy_ratio set on watched_wallets.copy_ratio. Effective
    // ratio in mirror mode = wallet.copy_ratio ?? settings.copy_ratio.
    key: 'copy_ratio', type: 'number', category: 'trade', mode: 'mirror',
    label: 'Copy Ratio',
    unit: '%', default: 100, min: 1, max: 100,
    parseUserInput: (t) => {
      const n = Number(String(t).replace(/[^\d.\-]/g, ''));
      if (!Number.isFinite(n) || n < 1 || n > 100) return null;
      return n;
    },
    formatValue: (v) => v == null ? '100%' : `${v}%`,
  },
  {
    // v0.8.8 M3.9: when target wallet SELLS, also sell our position. Only
    // effective in Copy Trade (mirror) mode. In Reverse Copy this is
    // meaningless — reverse mode already fires on SELL_DETECTED as BUY.
    key: 'copy_sell', type: 'bool', category: 'trade', mode: 'mirror',
    label: 'Copy Sell',
    default: true,
  },
  {
    // v0.8.8 M3.9: only fire if target spent X-Y SOL on the buy. 0/0
    // means "any amount" (no filter). min > max = invalid.
    key: 'trader_buy_limit_min', type: 'number', category: 'filters',
    mode: 'mirror', nullable: true,
    label: 'Trader Buy Limit (min)',
    unit: 'SOL', default: null,
    min: 0,
    parseUserInput: (t) => {
      const s = String(t).trim();
      if (s === '' || s === '0' || s.toLowerCase() === 'none') return null;
      const n = parseFloat(s);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'trader_buy_limit_max', type: 'number', category: 'filters',
    mode: 'mirror', nullable: true,
    label: 'Trader Buy Limit (max)',
    unit: 'SOL', default: null,
    min: 0,
    parseUserInput: (t) => {
      const s = String(t).trim();
      if (s === '' || s === '0' || s.toLowerCase() === 'none') return null;
      const n = parseFloat(s);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    // v0.8.8 (experimental) M5: reverse-mode sell filter. Symmetric to
    // trader_buy_limit_min/max. Only fire counter-buy if the dev wallet
    // sold X-Y SOL on the SELL_DETECTED event. Default null/0 = no filter.
    //   - min: skip dust sells (priority fee refunds, ATA close residuals)
    //   - max: skip huge dumps (dev liquidating 100% — late, too risky)
    //   - both 0/null: every sell triggers (current behavior, backward compat)
    key: 'trader_sell_limit_min', type: 'number', category: 'filters',
    mode: 'reverse', nullable: true,
    label: 'Trader Sell Limit (min)',
    unit: 'SOL', default: null,
    min: 0,
    parseUserInput: (t) => {
      const s = String(t).trim();
      if (s === '' || s === '0' || s.toLowerCase() === 'none') return null;
      const n = parseFloat(s);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    key: 'trader_sell_limit_max', type: 'number', category: 'filters',
    mode: 'reverse', nullable: true,
    label: 'Trader Sell Limit (max)',
    unit: 'SOL', default: null,
    min: 0,
    parseUserInput: (t) => {
      const s = String(t).trim();
      if (s === '' || s === '0' || s.toLowerCase() === 'none') return null;
      const n = parseFloat(s);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
  },
  {
    // v0.8.8 M3.9: anti-spam toggle — don't fire if we already bought
    // this token from this wallet in the last N seconds.
    key: 'no_duplicate_buys', type: 'bool', category: 'filters', mode: 'mirror',
    label: 'No Duplicate Buys from Target',
    default: true,
  },
  {
    // v0.8.8 M3.9: after we close a position, reset the buy counter so
    // we can buy this token again. Default off (we count forever).
    key: 'buy_times_reset_after_sold', type: 'bool', category: 'filters', mode: 'mirror',
    label: 'Buy Times Reset after Sold',
    default: false,
  },
  {
    // v0.8.8 M3.9: when target sells, sell the same % of our position
    // (proportional mirror). Default off (sell 100%).
    key: 'sell_proportionally', type: 'bool', category: 'trade', mode: 'mirror',
    label: 'Sell Proportionally',
    default: false,
  },
  {
    // v0.8.8 M3.9: auto-exit if target wallet transfers (not sells)
    // tokens out of their wallet. Distinguishes sell vs transfer by
    // checking the destination: pool = sell, external = transfer.
    key: 'sell_all_on_trader_transfer', type: 'bool', category: 'trade', mode: 'mirror',
    label: 'Sell All on Trader Transfer',
    default: false,
  },
  {
    // v0.8.8 M3.9: only fire on tokens CREATED by the target wallet
    // (creator = feePayer on the token's first tx). Filters out tokens
    // the target just bought into.
    key: 'only_copy_dev_create', type: 'bool', category: 'filters', mode: 'mirror',
    label: 'Only Copy Dev-Create',
    default: false,
  },
  {
    // v0.8.8 M3.9: filter — minimum token liquidity in USD. null = off.
    key: 'min_token_liquidity_usd', type: 'number', category: 'filters',
    mode: 'mirror', nullable: true,
    label: 'Min Token Liquidity',
    unit: 'USD', default: null, min: 0,
    parseUserInput: (t) => {
      const s = String(t).trim();
      if (s === '' || s === '0' || s.toLowerCase() === 'none') return null;
      const n = parseFloat(s.replace(/[^\d.\-]/g, ''));
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    },
    formatValue: (v) => v == null ? 'Off' : `$${v.toLocaleString('en-US')}`,
  },
  {
    // v0.8.8 M3.9: anti-PVP — skip tokens where the same address
    // bought multiple times in a short window (cluster signal).
    key: 'anti_pvp', type: 'bool', category: 'filters', mode: 'mirror',
    label: 'Anti-PVP Protection',
    default: false,
  },
  {
    // v0.8.8 M3.9: Buy Dip — a custom signal. When target wallet buys
    // and the token has dipped -X% from ATH, also buy. Implementation
    // deferred (requires ATH tracking). For now: a placeholder bool that
    // does nothing — exists so the UI matches the reference bot.
    key: 'buy_dip', type: 'bool', category: 'filters', mode: 'mirror',
    label: 'Buy Dip',
    default: false,
    hidden: true,    // not implemented yet — hide from menu
  },
  {
    // v0.8.8 M3.9: Turbo Mode — "simplified settings for faster setup"
    // (TradeWiz's literal copy). Functionally: enables recommended
    // defaults (auto_retry=1, no_duplicate_buys=true, etc) and hides
    // advanced settings. Currently a stub.
    key: 'turbo_mode', type: 'bool', category: 'advanced', mode: 'mirror',
    label: 'Turbo Mode',
    default: false,
    hidden: true,    // not implemented yet — hide from menu
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

export function byCategory(cat, mode = null) {
  // v0.8.8 (experimental) M3.9: optional `mode` filter — 'mirror' or
  // 'reverse' or null/'both'. When set, only settings whose `mode` is
  // 'both' or matches the requested mode are returned. Used by
  // settingsMenu.renderFlat(ctx, mode) to show different settings in
  // the Copy Trade menu vs Reverse Copy menu.
  return CATALOG.filter((s) =>
    s.category === cat &&
    !s.hidden &&
    (mode == null || s.mode === 'both' || s.mode === mode)
  );
}

/**
 * Resolve the current effective value for a setting.
 * Priority: DB (per-user) > env > default. Type is coerced to the catalog type.
 *
 * v0.8.7.15: chatId is REQUIRED. Each subscriber has their own setting row.
 * Old global `settings` table is deprecated; we read from user_settings only.
 */
export function get(key, chatId) {
  const setting = BY_KEY[key];
  if (!setting) return null;
  if (chatId == null) {
    // v0.8.7.15: per-user isolation is the default. Passing no chatId used
    // to mean "read the global setting" — that's exactly the leak we just
    // fixed. Refuse loudly rather than silently fall back to global.
    throw new Error(
      `settings.get('${key}'): chatId is required (per-user isolation since v0.8.7.15). ` +
      `Pass ctx.chat.id from Telegram handlers, or event.chatId from executor.`
    );
  }
  const row = userSettingsDb.get(chatId, key);
  if (row && row.value != null) {
    // `null` in JSON → user explicitly cleared; fall through to env/default
    if (row.value !== null) return coerceByType(setting, row.value);
  }
  const envVal = readEnvFor(setting);
  if (envVal !== undefined) return coerceByType(setting, envVal);
  return coerceByType(setting, setting.default);
}

/** Typed convenience: get a bool with a fallback. */
export function getBool(key, chatId, fallback = false) {
  if (chatId == null) throw new Error(`settings.getBool('${key}'): chatId is required`);
  const v = get(key, chatId);
  if (v == null) return fallback;
  return Boolean(v);
}

/** Typed convenience: get a number with a fallback. */
export function getNumber(key, chatId, fallback = 0) {
  if (chatId == null) throw new Error(`settings.getNumber('${key}'): chatId is required`);
  const v = get(key, chatId);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

/** Typed convenience: get a string with a fallback. */
export function getString(key, chatId, fallback = '') {
  if (chatId == null) throw new Error(`settings.getString('${key}'): chatId is required`);
  const v = get(key, chatId);
  if (v == null) return fallback;
  return String(v);
}

/**
 * Set a setting in the DB for one user. value is whatever the catalog type accepts.
 *
 * v0.8.7.15: chatId is REQUIRED. Each user's settings live in their own row.
 */
export function set(key, value, chatId) {
  const setting = BY_KEY[key];
  if (!setting) throw new Error(`Unknown setting: ${key}`);
  if (chatId == null) {
    throw new Error(
      `settings.set('${key}', ...): chatId is required (per-user isolation since v0.8.7.15).`
    );
  }
  if (value == null) {
    // null = "Not Limited" for some, or "default" for others. Store as null.
    userSettingsDb.set(chatId, key, null);
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
    userSettingsDb.set(chatId, key, n);
  } else if (setting.type === 'bool') {
    userSettingsDb.set(chatId, key, Boolean(value));
  } else {
    userSettingsDb.set(chatId, key, String(value));
  }
}

/** Reset a setting to its env/default for one user. Removes the DB row. */
export function reset(key, chatId) {
  if (!BY_KEY[key]) return false;
  if (chatId == null) throw new Error(`settings.reset('${key}'): chatId is required`);
  return userSettingsDb.delete(chatId, key) > 0;
}

/** Reset ALL settings for one user (each user resets their own). */
export function resetAll(chatId) {
  if (chatId == null) throw new Error('settings.resetAll: chatId is required');
  let n = 0;
  for (const s of CATALOG) n += userSettingsDb.delete(chatId, s.key);
  return n;
}

// -----------------------------------------------------------------------------
// Display formatters
// -----------------------------------------------------------------------------

/**
 * Format a SOL amount with up to 6 decimals, stripping trailing zeros so
 * "0.001 SOL" doesn't show as "0.001000 SOL". Values >= 1 keep 4 decimals
 * (e.g. 1.5 SOL), values < 1 keep 6 (e.g. 0.0001 SOL).
 */
function formatSolAmount(v) {
  if (v == null) return '—';
  if (v === 0) return '0 SOL';
  if (v >= 1) {
    return `${parseFloat(v.toFixed(4))} SOL`;
  }
  // Strip trailing zeros after 6 decimal places.
  return `${parseFloat(v.toFixed(6))} SOL`;
}

/**
 * Format milliseconds as a human-readable duration. Examples:
 *   1000 -> "1s"
 *   1500 -> "1.5s"
 *   60000 -> "1m"
 *   90000 -> "1m 30s"
 */
function formatSeconds(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return Number.isInteger(totalSec) ? `${totalSec}s` : `${parseFloat(totalSec.toFixed(1))}s`;
  }
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Format a setting's current value for menu display. */
export function formatValue(key, chatId) {
  if (chatId == null) throw new Error(`settings.formatValue('${key}'): chatId is required`);
  const setting = BY_KEY[key];
  if (!setting) return '?';
  const v = get(key, chatId);

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
         'sol_spending_limit', 'buy_priority_fee_sol', 'buy_tip_sol', 'jito_buy_tip_sol', 'jito_sell_tip_sol'].includes(key)) {
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
  // v0.8.8 (experimental) M1.18: per-setting formatValue takes priority so
  // slippage bps values are shown as percent in the UI while stored as bps
  // internally. Falls back to default formatting below.
  if (typeof setting.formatValue === 'function') {
    return setting.formatValue(v);
  }
  if (setting.type === 'number' && (setting.key === 'slippage_bps' || setting.key === 'pump_slippage_bps' || setting.key === 'pump_sell_slippage_bps')) {
    return `${(v / 100).toFixed(1)}%`;
  }
  if (setting.type === 'number' && setting.key.endsWith('_sol')) {
    return formatSolAmount(v);
  }
  if (setting.type === 'number' && setting.key === 'hold_ms') {
    // M1.19: hold time displays as seconds, not raw ms.
    return formatSeconds(v);
  }
  if (setting.type === 'number' && setting.key === 'auto_retry') {
    return v === 0 ? 'Off' : `${v} ${v === 1 ? 'time' : 'times'}`;
  }
  if (setting.type === 'number' && setting.key === 'buy_limit_per_token') {
    return `${v} ${v === 1 ? 'buy' : 'buys'}`;
  }
  if (setting.type === 'number' && (setting.key === 'min_mc_usd' || setting.key === 'max_mc_usd')) {
    // M1.19: format USD with thousands separator.
    return v === 0 ? 'Any' : `$${v.toLocaleString('en-US')}`;
  }
  if (setting.type === 'number' && setting.key === 'min_sell_ratio') {
    // Sell ratio is a fraction in [0.1, 1.0]. Display as a percentage so the
    // menu is readable ("90% min sell" rather than "0.9 min sell ratio").
    return v == null ? 'Off' : `${(v * 100).toFixed(0)}%`;
  }
  if (setting.type === 'text' && (v == null || v === '')) {
    return '—';
  }
  // v0.8.8 (experimental): pretty-print auto-sell JSON so the button label
  // shows "TP1 +50% SL -30%" instead of a raw JSON blob. Without this the
  // /settings menu had ugly truncated JSON like
  // 'TP/SL Plan = {"tiers":[{"tp_pct":50,"sell_pct":50}],"sl_pct":-30,...'
  if (setting.type === 'text' && AUTO_SELL_KEYS.has(key) && v) {
    return summariseAutoSell(key, v);
  }
  return String(v);
}

/** Stable list of auto-sell setting keys (kept here to avoid an import cycle). */
const AUTO_SELL_KEYS = new Set([
  'tp_sl_plan', 'trailing_stop', 'dev_sell_trigger', 'time_sell_plan',
]);

/**
 * Render an auto-sell JSON value as a one-line summary.
 * Format: 'TP1 +50% TP2 +100% SL -30%'  (separated by single spaces).
 * Falls back to '—' if the JSON can't be parsed.
 */
function summariseAutoSell(key, rawJson) {
  let obj;
  try { obj = JSON.parse(rawJson); } catch { return '—'; }
  const fmtPct = (n) => (n > 0 ? `+${n}%` : `${n}%`);
  if (key === 'tp_sl_plan') {
    const parts = [];
    if (Array.isArray(obj.tiers)) {
      obj.tiers.forEach((t, i) => {
        if (t && t.tp_pct != null) parts.push(`TP${i + 1} ${fmtPct(t.tp_pct)}`);
      });
    }
    if (obj.sl_pct != null) parts.push(`SL ${fmtPct(obj.sl_pct)}`);
    return parts.join(' ') || '—';
  }
  if (key === 'trailing_stop') {
    const parts = [];
    if (obj.act_pct != null) parts.push(`act ${fmtPct(obj.act_pct)}`);
    if (obj.trail_pct != null) parts.push(`trail ${fmtPct(obj.trail_pct)}`);
    return parts.join(' ') || '—';
  }
  if (key === 'dev_sell_trigger') {
    const parts = [];
    if (obj.mode) parts.push(obj.mode);
    if (obj.sell_pct != null) parts.push(`sell ${obj.sell_pct}%`);
    return parts.join(' ') || '—';
  }
  if (key === 'time_sell_plan') {
    if (!Array.isArray(obj.tiers) || obj.tiers.length === 0) return '—';
    return obj.tiers.map((t) => `${t.after_s}s`).join(' ');
  }
  return '—';
}

/**
 * Format a "source" tag: shows whether value comes from per-user DB, env, or default.
 * v0.8.7.15: reads user_settings, not the deprecated global settings table.
 */
export function formatSource(key, chatId) {
  if (chatId == null) throw new Error(`settings.formatSource('${key}'): chatId is required`);
  const setting = BY_KEY[key];
  if (!setting) return '';
  const row = userSettingsDb.get(chatId, key);
  if (row && row.value != null) return '🟢 DB';
  if (setting.env && process.env[setting.env]) return '🟡 env';
  return '⚪ default';
}

/** For toggling a bool via the menu. Returns the new value. */
export function toggle(key, chatId) {
  if (chatId == null) throw new Error(`settings.toggle('${key}'): chatId is required`);
  const setting = BY_KEY[key];
  if (!setting) throw new Error(`Unknown setting: ${key}`);
  if (setting.type !== 'bool') {
    throw new Error(`Setting ${key} is not a bool — use set() instead`);
  }
  const newValue = !getBool(key, chatId);
  set(key, newValue, chatId);
  return newValue;
}

// -----------------------------------------------------------------------------
// Time-window check
// -----------------------------------------------------------------------------

/**
 * Returns true if the current UTC time is within the active trading window.
 * Handles wrap-around: e.g. start=22:00 end=06:00 means 22:00-23:59 + 00:00-06:00.
 *
 * v0.8.7.15: per-user. Each subscriber has their own active-hours window.
 */
export function isInTimeWindow(chatId) {
  if (chatId == null) throw new Error('settings.isInTimeWindow: chatId is required');
  const start = getString('start_time', chatId, '00:00');
  const end = getString('end_time', chatId, '23:59');
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
 *
 * v0.8.7.15: per-user. Each subscriber has their own daily-spend tally
 * (their own positions table rows). The aggregate is computed across all
 * positions with chat_id = this user.
 */
export function spentSolToday(chatId) {
  if (chatId == null) throw new Error('settings.spentSolToday: chatId is required (per-user isolation since v0.8.7.15)');
  const since = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();
  return positionsDb.spentSince(since, chatId);
}
