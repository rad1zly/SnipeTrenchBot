// src/telegramBot.js
// =============================================================================
// Telegram bot interface. Telegraf-based. Handles user commands and wires
// them to the database / safety module / notifier.
//
// Multi-user: anyone who sends /start becomes a subscriber. Notifier broadcasts
// to all subscribers. No owner-only auth — any Telegram user can run any
// =============================================================================
// TradeWiz-style menu structure (v0.5.2 — flat single-screen)
//
//   /start (or /menu) → mainMenu() → big PAUSE/START button + 2x3 grid:
//
//     [⏸ PAUSE / ▶️ START]
//     [🎯 Copy Trade]   [📊 Status]
//     [💼 Wallets (N)]  [🛟 Safety]
//     [💼 Positions]    [🔑 Wallet]
//     [❓ Help]          [🔄 Refresh]
//
//   🎯 Copy Trade → flat single-screen settings menu (settingsMenu.js).
//                   All 22 settings on one scrollable screen, with paired
//                   Max/Min in 2-column layout. Tap a bool to toggle, tap a
//                   number/text to open a force-reply prompt. ← Back /
//                   ↻ Refresh / + Save footer.
//   💼 Wallets  → list of tracked wallets + [➕ Add Wallet] button (accepts
//                 bulk: newline or comma-separated, with optional label
//                 after each address).
//   🔑 Wallet   → the bot's OWN trading key (encrypted at rest, message
//                 auto-deleted from chat on receive). Set / Replace /
//                 Remove via inline keyboard. /wallet alias.
//
// All callbacks are in-place edits (no new message per tap).
// =============================================================================

const BOT_COMMANDS = [
  { command: 'start',       description: 'Subscribe + show main menu' },
  { command: 'menu',        description: 'Show main menu' },
  { command: 'copytrade',   description: 'Copy Trade settings (flat TradeWiz-style menu)' },
  { command: 'wallets',     description: 'List tracked wallets' },
  { command: 'addwallet',   description: 'Add wallet(s) — /addwallet <addr1>,<addr2>,<addr3> [label]' },
  { command: 'removewallet',description: 'Remove wallet — /removewallet <addr>' },
  { command: 'wallet',      description: 'Set / replace / remove the bot trading wallet' },
  { command: 'status',      description: 'Bot + executor + safety snapshot' },
  { command: 'stats',       description: 'Win rate, PnL, best/worst trades' },
  { command: 'balance',     description: 'Wallet SOL + SPL token balances' },
  { command: 'positions',   description: 'List open positions' },
  { command: 'closepos',    description: 'Force-close an open position — /closepos <id> or /closepos all' },
  { command: 'recent',      description: 'Last N closed trades — /recent [n]' },
  { command: 'safety',      description: 'Show safety config' },
  { command: 'pause',       description: 'Pause trading' },
  { command: 'resume',      description: 'Resume trading' },
  { command: 'stop',        description: 'Unsubscribe from broadcasts' },
  { command: 'help',        description: 'List all commands' },
];
// =============================================================================

import { Telegraf, Markup } from 'telegraf';
import config from './config.js';
import { walletsDb, positionsDb, subscribersDb } from './db.js';
import { pause, resume, isPaused, snapshot as safetySnapshot } from './safety.js';
import { status as executorStatus, evictKeypair } from './executor.js';
import { walletManager, fetchBalanceSnapshot } from './walletManager.js';
import notifier from './notifier.js';
import * as sm from './settingsMenu.js';
import * as settings from './settings.js';
import * as wsm from './walletSettingsMenu.js';  // v0.8.8 M7: per-wallet settings UI
import * as wm from './walletMenu.js';

let bots = []; // M1.5: array of Telegraf instances (one per TELEGRAM_BOT_TOKEN)
let onPause = null; // callback set by index.js so we can stop the monitor if needed
let onResume = null;

function shortAddr(a) {
  if (!a) return '?';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// v0.8.8 (experimental) M2.12: helper to safely parse a signals.data_json
// string. Returns null on invalid input so the caller can use `|| {}`.
function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isValidSolanaAddress(addr) {
  return typeof addr === 'string' && addr.length >= 32 && addr.length <= 44;
}

/**
 * Parse bulk-address text (from /addwallet or the inline ➕ Add Wallet flow)
 * and add valid addresses to the watchlist. Supports three input shapes:
 *
 *   1. Single line:  "<addr1> label1"
 *   2. Comma-separated: "<addr1>,<addr2>,<addr3>"
 *   3. Newline-separated:
 *        <addr1> label1
 *        <addr2> label2
 *        <addr3>
 *
 * Returns { added, skipped } where:
 *   added  = [{ addr, label, wasNew }]   — successfully added
 *   skipped = [{ input, reason }]        — invalid input
 */
function bulkAddWalletsFromText(raw, chatId) {
  // Normalize: replace commas with newlines, then split on newline. Trim
  // each line. Drop empty lines.
  const lines = raw
    .replace(/[ \t]+/g, ' ')
    .split(/[,\n]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const added = [];
  const skipped = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const addr = parts[0];
    const label = parts.slice(1).join(' ') || null;
    if (!addr || !isValidSolanaAddress(addr)) {
      skipped.push({ input: line, reason: 'invalid Solana address' });
      continue;
    }
    try {
      // v0.6.1: chatId scopes the watchlist per user. INSERT OR IGNORE
      // respects UNIQUE(chat_id, address) so the same address can be added
      // by multiple users independently.
      const result = walletsDb.add({ chatId, address: addr, label });
      const wasNew = !!(result && result.changes > 0);
      added.push({ addr, label, wasNew });
    } catch (err) {
      skipped.push({ input: line, reason: err.message || 'add failed' });
    }
  }
  return { added, skipped };
}

/**
 * Format a single Telegram summary message for the result of a bulk add.
 * Avoids spamming N messages for N addresses.
 */
function bulkAddResultMessage(added, skipped) {
  const lines = [];
  const realNew = added.filter((a) => a.wasNew);
  if (realNew.length > 0) {
    lines.push(`✅ <b>Added ${realNew.length} wallet${realNew.length === 1 ? '' : 's'}:</b>`);
    for (const a of realNew) {
      lines.push(`  • <code>${shortAddr(a.addr)}</code>${a.label ? ` — ${a.label}` : ''}`);
    }
  }
  const dupes = added.filter((a) => !a.wasNew);
  if (dupes.length > 0) {
    lines.push(`\n⚠️ <b>${dupes.length} already in watchlist:</b>`);
    for (const a of dupes) {
      lines.push(`  • <code>${shortAddr(a.addr)}</code>${a.label ? ` — ${a.label}` : ''}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(`\n❌ <b>Skipped ${skipped.length} (invalid):</b>`);
    for (const s of skipped.slice(0, 5)) {  // cap at 5 to keep message short
      lines.push(`  • <code>${s.input}</code> — ${s.reason}`);
    }
    if (skipped.length > 5) {
      lines.push(`  … and ${skipped.length - 5} more`);
    }
  }
  if (realNew.length === 0 && dupes.length === 0 && skipped.length === 0) {
    lines.push('❌ No addresses found in the message.');
  }
  return lines.join('\n');
}

// =============================================================================
// Inline keyboard menus (TradeWiz-style button navigation)
// =============================================================================
// Menu callbacks use the `menu:` and `cmd:` prefixes. `menu:` navigates to
// a sub-screen. `cmd:` runs the same logic as a /command and shows the
// result inline. Tapping a button edits the message in place — Telegram
// doesn't get a wall of new messages.

// v0.8.8 (experimental): buildMainText is now async so it can fetch the
// live SOL balance + top-3 SPL token balances from RPC. The whole
// header is the BALANCE — user requested "balance harusnya di menu paling
// awal lgsg ditampilin sih" (tg 20:00). Fetches are cached for
// BALANCE_TTL_MS (30s) inside walletManager, so refreshing the menu
// via the 🔄 button doesn't hammer the RPC.
async function buildMainText(chatId) {
  const e = executorStatus(chatId);
  // v0.8.7.15: pass chatId so /status shows THIS USER's settings + pause state,
  // not a global aggregate. Per-user isolation.
  const s = safetySnapshot(chatId);
  const w = walletManager.getStatus(chatId);
  // v0.6.1: per-user counts. Total copies & wallets are scoped to the
  // calling user; subscriber count stays global (system-level stat).
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
  const myCopies  = chatId != null ? walletsDb.totalCopies(chatId) : 0;

  // v0.8.8: live balance block. If wallet is set, fetch SOL + top-3 SPL
  // tokens via fetchBalanceSnapshot (parallel, cached 30s). If not set,
  // show a friendly "no wallet" hint with a tap-to-set call to action.
  // v0.8.8 (tg 20:00 user feedback): "balance harusnya di menu paling
  // awal lgsg ditampilin sih" — balance is now the first block in the
  // main menu, before Mode and other stats.
  // v0.8.8 (tg 21:39 user feedback): "jgn cuma balance sol tp convert
  // ke usd jg" — show USD value next to SOL (CoinGecko, 60s cache).
  let balBlock = '';
  if (w.set) {
    const snap = await fetchBalanceSnapshot(w.address, { limit: 3, minUi: 0 });
    const solNum = snap.sol?.sol || 0;
    const solStr = snap.sol?.error
      ? `<i>err: ${snap.sol.error}</i>`
      : `${solNum.toFixed(4)} SOL`;
    // USD conversion: only show if CoinGecko returned a number. On
    // network/API error we hide the USD rather than show stale or
    // wrong data. Format: $1,234.56 (locale en-US for thousands sep).
    const usdStr = (snap.solUsd != null && Number.isFinite(snap.solUsd))
      ? ` <i>($${snap.solUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</i>`
      : '';
    // fetchTokenBalances returns mint + uiAmount (no symbol/name unless
    // /balance explicitly fetches metadata). For the main menu we just
    // show a short mint prefix + uiAmount — /balance has the full
    // version with metadata.
    const tokLines = (snap.tokens?.tokens || []).map((t) => {
      const ui = t.uiAmount != null ? t.uiAmount : 0;
      const uiStr = ui >= 1
        ? ui.toLocaleString('en-US', { maximumFractionDigits: 2 })
        : ui.toFixed(4);
      return `    <code>${t.mint.slice(0, 6)}…</code>: ${uiStr}`;
    });
    const tokStr = tokLines.length > 0 ? tokLines.join('\n') : '    <i>(no SPL tokens)</i>';
    balBlock = [
      `<b>💰 ${solStr}${usdStr}</b>  (${w.last4 ? `…${w.last4}` : shortAddr(w.address)})`,
      tokStr,
    ].join('\n');
  } else {
    balBlock = '💰 <i>no wallet</i>  — tap 🔑 Wallet below to set one.';
  }

  const lines = [
    '<b>🤖 SnipeTrenchBot</b>',
    '',
    balBlock,
    '',
    `Mode:      ${config.DRY_RUN ? '<b>DRY_RUN</b>' : '<b>⚠️ LIVE</b>'}`,
    `Wallets: ${myWallets}  |  Copies: ${myCopies}  |  Positions: ${s.openPositionCount}  |  Subs: ${subscribersDb.count()}`,
  ];
  if (isPaused(chatId)) lines.push('', '⏸ <b>PAUSED</b>');
  if (!w.set) lines.push('', '⚠️ <b>No trading wallet</b> — tap 🔑 Wallet to set one.');
  lines.push('', 'Tap a button below.');
  return lines.join('\n');
}

function mainMenu(chatId) {
  const running = !isPaused(chatId);
  // v0.6.1: button label uses the calling user's wallet count, not the
  // global table size. Falls back to 0 when chatId is unknown (e.g. legacy
  // callers).
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
  // TradeWiz-style: big prominent start/stop button on top, then 2-col grid.
  // 🎯 Copy Trade replaces the old "⚙️ Settings" — it now opens the flat
  // single-screen settings menu (TradeWiz parity). 🔑 Wallet stays prominent
  return Markup.inlineKeyboard([
    [Markup.button.callback(running ? '⏸ Pause Trading' : '▶️ Resume Trading', 'cmd:toggle_pause')],
    // v0.8.8 (experimental) M3.9: split single Copy Trade into two —
    // 🪞 Copy Trade (mirror) and 🔁 Reverse Copy (counter). Per user
    // feedback (tg 01:01): "ada beberapa fitur yang berbeda disitu,
    // jadi lebih baik fitur copy trade sm reverse copy trade menunya
    // dipisah". Each menu shows settings filtered by `mode` in the
    // catalog. Per-wallet copy_mode + copy_ratio (M3.1b) live in
    // /wallets, not here.
    [
      Markup.button.callback('🪞 Copy Trade',    'cmd:copytrade_mirror'),
      Markup.button.callback('🔁 Reverse Copy',  'cmd:copytrade_reverse'),
    ],
    [
      Markup.button.callback('📊 Status',    'cmd:status'),
      Markup.button.callback('🔄 Refresh',   'menu:main'),
    ],
    [
      Markup.button.callback(`💼 Wallets (${myWallets})`, 'cmd:wallets'),
      Markup.button.callback('🛟 Safety',    'cmd:safety'),
    ],
    [
      Markup.button.callback('💼 Positions', 'cmd:positions'),
      Markup.button.callback('🔑 Wallet',    'menu:wallet'),
    ],
    [
      Markup.button.callback('📈 Stats',     'cmd:stats'),
      Markup.button.callback('💰 Balance',   'cmd:balance'),
    ],
    [
      Markup.button.callback('❓ Help',      'cmd:help'),
    ],
  ]);
}

// Inline keyboard for the Wallets screen. Tap "➕ Add Wallet" → bot enters
// pending-add mode (waits for next text message = wallet address).
const walletsMenu = (chatId) => {
  // v0.8.8 (experimental) M3.1b + M6.1: list each wallet with a "config"
  // button that opens a per-wallet sub-menu for copy mode. The sub-menu
  // itself is rendered by walletCopyMenu() and dispatched via
  // 'wallet:copy:<address>'. M6.1 removed the ratio from UI (hardcoded 100).
  const rows = [];
  if (chatId != null) {
    const list = walletsDb.list(chatId);
    for (const w of list) {
      const mode = w.copy_mode || 'reverse';
      const icon = mode === 'mirror' ? '🟢' : mode === 'reverse' ? '🟠' : '⚪';
      const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
      const label = w.label ? `${w.label} (${short})` : short;
      rows.push([Markup.button.callback(`${icon} ${label} · ${mode}`, `wallet:copy:${w.id}`)]);
    }
  }
  rows.push([Markup.button.callback('➕ Add Wallet', 'cmd:wallet_add')]);
  rows.push([Markup.button.callback('« Back to Main', 'menu:main')]);
  return Markup.inlineKeyboard(rows);
};

// Helper: format TP/SL JSON value for display on a single button label.
// fmtTpSl needs access to wsm to read standalone sl_pct — called from walletCopyMenu
// which already has wsm in scope. Pass slRaw as second arg so we read it directly.
function fmtTpSl(raw, slRaw) {
  if (!raw && slRaw == null) return '—';
  let obj;
  try { obj = JSON.parse(raw || '{}'); } catch { obj = {}; }
  const fmt = (n) => (n > 0 ? `+${n}%` : `${n}%`);
  const parts = [];
  if (obj.tiers?.length) obj.tiers.forEach(t => { if (t?.tp_pct != null) parts.push(`TP ${fmt(t.tp_pct)}`); });
  // Prefer standalone sl_pct over tp_sl_plan.sl_pct (they may differ during migration)
  const slVal = slRaw ?? obj.sl_pct;
  if (slVal != null) parts.push(`SL ${fmt(slVal)}`);
  return parts.join(' | ') || '—';
}
function fmtTP(raw) {
  if (!raw) return '—';
  let obj;
  try { obj = JSON.parse(raw); } catch { return '—'; }
  if (!obj?.tiers?.length) return '—';
  return `+${obj.tiers[0].tp_pct}%`;
}
function fmtSL(raw) {
  if (!raw) return '—';
  let obj;
  try { obj = JSON.parse(raw); } catch { return '—'; }
  if (obj?.sl_pct == null) return '—';
  return `${obj.sl_pct}%`;
}
function fmtTrailing(raw) {
  if (!raw) return '—';
  let obj;
  try { obj = JSON.parse(raw); } catch { return '—'; }
  if (!obj || typeof obj !== 'object') return '—';
  const fmt = (n) => (n > 0 ? `+${n}%` : `${n}%`);
  const parts = [];
  if (obj.act_pct != null) parts.push(`act ${fmt(obj.act_pct)}`);
  if (obj.trail_pct != null) parts.push(`trail ${fmt(obj.trail_pct)}`);
  return parts.join(' | ') || '—';
}
function fmtTime(raw) {
  if (!raw) return '—';
  let obj;
  try { obj = JSON.parse(raw); } catch { return '—'; }
  if (!obj?.tiers?.length) return '—';
  return obj.tiers.map(t => `${t.after_s}s:${t.sell_pct}%`).join(' ');
}

function walletCopyMenu(chatId, wid) {
  // v0.8.8 M12: per-wallet menu.
  // Mirror → Buy Min/Max. Reverse → Sell Min/Max. Dedicated TP/SL/Trail/Time buttons.
  const wallet = walletsDb.getById(chatId, wid);
  if (!wallet) {
    return Markup.inlineKeyboard([[Markup.button.callback('« Back', 'cmd:wallets')]]);
  }
  const address = wallet.address;
  const w = walletsDb.getCopyConfig({ chatId, address });
  const mode = w?.copy_mode || 'reverse';
  const overrides = wsm.listWalletOverrides(chatId, address);
  const overrideKeys = new Set(overrides.map(o => o.key));
  const flag = (key) => overrideKeys.has(key) ? '🟢' : '⚪';

  const tpRaw = wsm.getForWallet('tp_sl_plan',     chatId, address);
  const slRaw = wsm.getForWallet('sl_pct',             chatId, address);
  const tsRaw = wsm.getForWallet('trailing_stop',  chatId, address);
  const tmRaw = wsm.getForWallet('time_sell_plan', chatId, address);

  const slipRaw = wsm.getForWallet('slippage_bps', chatId, address);
  const slipFmt = slipRaw != null ? `${(slipRaw / 100).toFixed(1)}%` : '—';

  const rows = [];

  // ── Row 1: Copy mode
  rows.push([
    Markup.button.callback(`${mode === 'reverse' ? '🟠' : '⚪'} Reverse`, `wallet:mode:${wid}:reverse`),
    Markup.button.callback(`${mode === 'mirror'  ? '🟢' : '⚪'} Mirror`,  `wallet:mode:${wid}:mirror`),
    Markup.button.callback(`${mode === 'off'     ? '⚫' : '⚪'} Off`,     `wallet:mode:${wid}:off`),
  ]);

  // ── Row 1b: Dev Only toggle
  const devOnly = wsm.getForWallet('dev_only', chatId, address) === true;
  rows.push([
    Markup.button.callback(`${devOnly ? '🔵' : '⚪'} Dev Only: ${devOnly ? 'ON' : 'OFF'}`, `wset:toggle:${wid}:dev_only`),
  ]);

  // ── Row 2: TP / SL
  rows.push([
    Markup.button.callback(`📈 TP: ${fmtTpSl(tpRaw, slRaw)}`, `wallet:tp:${wid}`),
    Markup.button.callback(`📉 SL: ${slRaw != null ? slRaw + '%' : '—'}`, `wallet:sl:${wid}`),
  ]);

  // ── Row 3: Trailing / Time
  rows.push([
    Markup.button.callback(`🔄 Trail: ${fmtTrailing(tsRaw)}`, `wallet:trail:${wid}`),
    Markup.button.callback(`⏱ Time: ${fmtTime(tmRaw)}`,     `wallet:time:${wid}`),
  ]);

  // ── Row 4: Limit filters — label changes per mode
  if (mode === 'mirror') {
    rows.push([
      Markup.button.callback(`${flag('trader_buy_limit_min')} Buy Min: ${wsm.getForWallet('trader_buy_limit_min', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:trader_buy_limit_min`),
      Markup.button.callback(`${flag('trader_buy_limit_max')} Buy Max: ${wsm.getForWallet('trader_buy_limit_max', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:trader_buy_limit_max`),
    ]);
  } else if (mode === 'reverse') {
    rows.push([
      Markup.button.callback(`${flag('trader_sell_limit_min')} Sell Min: ${wsm.getForWallet('trader_sell_limit_min', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:trader_sell_limit_min`),
      Markup.button.callback(`${flag('trader_sell_limit_max')} Sell Max: ${wsm.getForWallet('trader_sell_limit_max', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:trader_sell_limit_max`),
    ]);
  }

  // ── Row 5: Fixed buy + Priority fee + Sell fee
  rows.push([
    Markup.button.callback(`${flag('fixed_buy_sol')} Buy SOL: ${wsm.getForWallet('fixed_buy_sol', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:fixed_buy_sol`),
    Markup.button.callback(`${flag('buy_priority_fee_sol')} Prio Fee: ${wsm.getForWallet('buy_priority_fee_sol', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:buy_priority_fee_sol`),
    Markup.button.callback(`${flag('sell_priority_fee_sol')} Sell Fee: ${wsm.getForWallet('sell_priority_fee_sol', chatId, address) ?? '—'} SOL`, `wset:edit:${wid}:sell_priority_fee_sol`),
  ]);

  // ── Row 5b: Slippage (buy + sell)
  const sellSlipRaw = wsm.getForWallet('pump_sell_slippage_bps', chatId, address);
  const sellSlipFmt = sellSlipRaw != null ? `${(sellSlipRaw / 100).toFixed(1)}%` : '—';
  rows.push([
    Markup.button.callback(`${flag('slippage_bps')} Slip: ${slipFmt}`, `wset:edit:${wid}:slippage_bps`),
    Markup.button.callback(`${flag('pump_sell_slippage_bps')} SellSlip: ${sellSlipFmt}`, `wset:edit:${wid}:pump_sell_slippage_bps`),
  ]);

  // ── Row 6: MC filters
  rows.push([
    Markup.button.callback(`${flag('min_mc_usd')} Min MC: ${(wsm.getCatalogEntry('min_mc_usd')?.formatValue?.(wsm.getForWallet('min_mc_usd', chatId, address)) ?? '—')}`, `wset:edit:${wid}:min_mc_usd`),
    Markup.button.callback(`${flag('max_mc_usd')} Max MC: ${(wsm.getCatalogEntry('max_mc_usd')?.formatValue?.(wsm.getForWallet('max_mc_usd', chatId, address)) ?? '—')}`, `wset:edit:${wid}:max_mc_usd`),
  ]);

  // ── Row 6b: Age + Hold
  const holdRaw = wsm.getForWallet('hold_ms', chatId, address);
  const holdEntry = wsm.getCatalogEntry('hold_ms');
  const holdFmt = holdEntry?.formatValue ? holdEntry.formatValue(holdRaw) : (holdRaw ?? '—');
  rows.push([
    Markup.button.callback(`${flag('min_token_age_min')} Min Age: ${wsm.getForWallet('min_token_age_min', chatId, address) ?? '—'}m`, `wset:edit:${wid}:min_token_age_min`),
    Markup.button.callback(`${flag('hold_ms')} Hold: ${holdFmt}`, `wset:edit:${wid}:hold_ms`),
  ]);

  // ── Row 7: Max Token Age
  rows.push([
    Markup.button.callback(`${flag('max_token_age_min')} Max Age: ${wsm.getForWallet('max_token_age_min', chatId, address) ?? '—'}m`, `wset:edit:${wid}:max_token_age_min`),
  ]);

  // ── Row 8: No dup
  rows.push([
    Markup.button.callback(`${flag('no_duplicate_buys')} No Dup: ${wsm.getForWallet('no_duplicate_buys', chatId, address) ? '✓' : '—'}`, `wset:edit:${wid}:no_duplicate_buys`),
  ]);

  // ── Row 9: Back
  rows.push([Markup.button.callback('« Back to Wallets', 'cmd:wallets')]);

  return Markup.inlineKeyboard(rows);
}

// v0.8.8 M9: wallet picker shown when user taps "Copy Trade" or "Reverse"
// in the main menu — they choose WHICH wallet to configure before seeing
// the per-wallet copy + settings menu.
function buildWalletPickerText(mode, chatId) {
  const list = walletsDb.list(chatId);
  const modeIcon = mode === 'mirror' ? '🪞' : mode === 'reverse' ? '🔁' : '⚙️';
  const modeLabel = mode === 'mirror' ? 'Mirror' : mode === 'reverse' ? 'Reverse Copy' : 'Copy Trade';
  const lines = [
    `${modeIcon} <b>${modeLabel} — select wallet</b>`,
    '',
    '<i>Tap a wallet below to configure its copy mode & settings.</i>',
    '',
  ];
  if (list.length === 0) {
    lines.push('⚠️ <b>No wallets added yet.</b>');
    lines.push('Use /addwallet or tap "➕ Add" below.');
  } else {
    for (const w of list) {
      const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
      const label = w.label ? ` (${w.label})` : '';
      lines.push(`• <code>${short}</code>${label}`);
    }
  }
  return lines.join('\n');
}

function walletPickerKeyboard(mode, chatId) {
  const list = walletsDb.list(chatId);
  const buttons = [];
  for (const w of list) {
    const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
    const label = w.label ? ` ${w.label}` : '';
    const copyMode = walletsDb.getCopyConfig({ chatId, address: w.address });
    const icon = (copyMode?.copy_mode || 'reverse') === 'mirror' ? '🟢' :
                 (copyMode?.copy_mode || 'reverse') === 'reverse' ? '🟠' : '⚫';
    buttons.push([Markup.button.callback(
      `${icon} ${short}${label}`,
      `wallet:pick:${mode}:${w.id}`
    )]);
  }
  buttons.push([Markup.button.callback('➕ Add new wallet', 'cmd:wallet_add')]);
  const backBtn = mode === 'mirror' ? 'cmd:copytrade_mirror' :
                  mode === 'reverse' ? 'cmd:copytrade_reverse' : 'menu:main';
  buttons.push([Markup.button.callback('« Back', backBtn)]);
  return Markup.inlineKeyboard(buttons);
}

function walletCopyText(chatId, wid) {
  // v0.8.8 M11: minimal — just wallet short address + mode explainer.
  const wallet = walletsDb.getById(chatId, wid);
  if (!wallet) return 'Wallet not found.';
  const address = wallet.address;
  const w = walletsDb.getCopyConfig({ chatId, address });
  if (!w) return 'Wallet not found.';
  const mode = w.copy_mode || 'reverse';
  const devOnly = settings.getForWallet('dev_only', chatId, address) === true;
  const devOnlyTag = devOnly ? ' | 🔵 Dev Only ON' : '';
  const explain = {
    reverse: `🟠 <b>Reverse</b> — buy when this dev SELLS (front-run exit).${devOnlyTag}`,
    mirror:  `🟢 <b>Mirror</b> — buy when this dev BUYS (your SOL size).${devOnlyTag}`,
    off:     '⚪ <b>Off</b> — track signals but don\u2019t auto-trade this wallet.',
  };
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  return [
    `🎯 <b>Wallet:</b> <code>${short}</code>`,
    '',
    explain[mode],
  ].join('\n');
}

function settingsMenu() {
  // v0.5.2: this is now a flat single-screen view. Kept as a thin alias
  // around settingsMenu.js so any stale callback_data in old messages
  // still routes correctly. New code uses cmd:copytrade.
  return null;
}

function commandBackMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('« Back to Main', 'menu:main')],
  ]);
}

async function renderScreen(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...keyboard,
    });
  } catch (err) {
    // "message is not modified" is fine — user tapped the same screen twice
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
}

// Reusable text builders — used by both the menu buttons (editMessageText)
// and the legacy /commands (so /status text matches the "📊 Status" button).

function buildStatusText(chatId) {
  const s = safetySnapshot(chatId);
  const e = executorStatus(chatId);
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
  const w = s.winStats;
  const winrateStr = w.totalClosed === 0
    ? '—'
    : `${w.winRate.toFixed(1)}% (${w.wins}W/${w.losses}L${w.breakeven ? `/${w.breakeven}E` : ''})`;
  const pnlStr = w.totalClosed === 0
    ? '—'
    : `${w.totalPnlSol >= 0 ? '+' : ''}${w.totalPnlSol.toFixed(4)} SOL`;
  return [
    '<b>📊 Status</b>',
    '',
    `Mode:           ${s.mode}`,
    `Manual pause:   ${s.manualPaused ? 'yes' : 'no'}`,
    `Watched:        ${myWallets} wallet(s)`,
    `Subscribers:    ${subscribersDb.count()}`,
    `Open positions: ${s.openPositionCount}`,
    `Closed today:   ${s.closedTodayCount} (PnL ${s.pnlTodaySol.toFixed(4)} SOL)`,
    '',
    '<b>Your trading wallet</b>',
    `Address:        <code>${e.botWallet}</code>`,
    '',
    '<b>RPC / Jupiter</b>',
    `RPC:            ${e.rpc}`,
    `Jupiter:        ${e.jupiterUrl}`,
    '',
    '<b>Win/Loss (your watchlist)</b>',
    `Trades closed:  ${w.totalClosed}`,
    `Win rate:       ${winrateStr}`,
    `Total PnL:      ${pnlStr}`,
    '',
    '<b>Safety</b>',
    `Max SOL/trade:  ${s.maxSolPerTrade}`,
    `Slippage:       ${s.slippageBps} bps`,
    `Hold:           ${s.holdMs} ms`,
    `Daily loss cap: ${s.dailyLossCapSol} SOL`,
    '',
    '<i>Tip: /balance → wallet SOL &amp; SPL tokens · /stats → detailed W/L breakdown</i>',
  ].join('\n');
}

// ---------------------------------------------------------------------
// v0.8.0: /stats — detailed win/loss tracking (per-user + global)
// ---------------------------------------------------------------------
function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
}
function fmtSol(x) {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x >= 0 ? '+' : ''}${x.toFixed(4)} SOL`;
}
function fmtHold(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
function shortMint(m) {
  if (!m) return '?';
  return `${m.slice(0, 4)}\u2026${m.slice(-4)}`;
}

function buildStatsText(chatId) {
  const w = positionsDb.winStats(chatId);
  const g = positionsDb.winStats(null);
  // v0.8.8 (experimental) M3.5 + M3.1b: copy mode + ratio are now
  // PER-WALLET (stored in watched_wallets). Show each wallet's mode
  // + ratio inline so the user can see at a glance which signal
  // type triggers trades for each watched wallet.
  const walletList = walletsDb.list(chatId);
  const section = (label, s) => {
    if (s.totalClosed === 0) {
      return `\n<b>${label}</b>\n  no closed trades yet`;
    }
    return [
      `\n<b>${label}</b>`,
      `  closed:    ${s.totalClosed}  (${s.wins}W / ${s.losses}L${s.breakeven ? ` / ${s.breakeven}E` : ''})`,
      `  win rate:  ${s.winRate != null ? s.winRate.toFixed(1) + '%' : '—'}`,
      `  PnL:       ${fmtSol(s.totalPnlSol)}  (${fmtPct(s.totalPnlPercent)})`,
      `  avg PnL:   ${fmtPct(s.avgPnlPercent)}`,
      `  avg hold:  ${fmtHold(s.avgHoldMs)}`,
      ...(s.best.length
        ? ['  best:  ' + s.best.slice(0, 3).map((b) => `<code>${shortMint(b.mint)}</code> ${fmtSol(b.pnlSol)}`).join('  ')]
        : []),
      ...(s.worst.length
        ? ['  worst: ' + s.worst.slice(0, 3).map((b) => `<code>${shortMint(b.mint)}</code> ${fmtSol(b.pnlSol)}`).join('  ')]
        : []),
    ].join('\n');
  };
  const modeIcon = (m) => m === 'mirror' ? '🟢' : m === 'reverse' ? '🟠' : '⚪';
  const modeLabel = (m) => m === 'mirror' ? 'Mirror' : m === 'reverse' ? 'Reverse' : 'Off';
  // v0.8.8 (experimental) M6.1: ratio removed from UI (hardcoded 100).
  const walletLines = walletList.length === 0
    ? '  (no watched wallets — use /addwallet or /wallets)'
    : walletList.map((w) => {
        const mode = w.copy_mode || 'reverse';
        const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
        return `  ${modeIcon(mode)} <code>${short}</code> · <b>${modeLabel(mode)}</b>`;
      });
  return [
    '<b>📈 Stats</b>',
    `\n<b>Per-wallet copy config (${walletList.length}):</b>`,
    walletLines.join('\n'),
    section('Your watchlist', w),
    section('Global (all users)', g),
    '',
    '<i>Use /recent 10 to see the last 10 closed trades in detail.</i>',
    '<i>Tap a wallet in /wallets to change its copy mode.</i>',
  ].join('\n');
}

function buildWalletsText(chatId) {
  // v0.6.1: per-user list. Users can only see their own wallets.
  // v0.8.8 (experimental) M3.1b: each wallet now shows its copy mode
  // and ratio, and tapping the wallet shows a per-wallet config menu.
  const list = walletsDb.list(chatId);
  if (list.length === 0) {
    return '💼 <b>Wallets</b>\n\nEmpty. Tap <b>➕ Add Wallet</b> below, or send <code>/addwallet &lt;address&gt; [label]</code>.';
  }
  const totalCopies = walletsDb.totalCopies(chatId);
  const modeIcon = (m) => m === 'mirror' ? '🟢' : m === 'reverse' ? '🟠' : '⚪';
  const modeLabel = (m) => m === 'mirror' ? 'Mirror' : m === 'reverse' ? 'Reverse' : 'Off';
  const lines = list.map((w) => {
    const lastCopy = w.last_copy_at > 0
      ? `\n  copies: <b>${w.copy_count}</b> · last: ${new Date(w.last_copy_at).toISOString().slice(0, 16).replace('T', ' ')}Z`
      : `\n  copies: <b>${w.copy_count}</b>`;
    const mode = w.copy_mode || 'reverse';
    return `• <code>${w.address}</code>${w.label ? ` — ${w.label}` : ''}\n  ${modeIcon(mode)} ${modeLabel(mode)}` +
      `\n  added ${new Date(w.added_at).toISOString().slice(0, 10)}` + lastCopy;
  });
  return (
    `💼 <b>Wallets (${list.length}):</b>\n` +
    `<i>Total copies: <b>${totalCopies}</b></i>\n\n` +
    `${lines.join('\n')}\n\n` +
    `<i>Tap a wallet button below to change its copy mode.</i>`
  );
}

function buildPositionsText(chatId) {
  // v0.8.7.15: per-user. Each subscriber sees their own open positions,
  // not a global aggregate.
  // v0.8.8 (experimental) M2.10: live value, peak gain %, fired tiers,
  // sold_pct progress bar, and a tap-to-close hint when a position is
  // held with no plan (manual close required).
  const open = positionsDb.openAll(chatId);
  if (open.length === 0) return '💼 <b>Open positions</b>\n\nNone right now.';
  const lines = open.map((p) => {
    const entry = p.entry_sol || 0;
    const current = p.current_sol_value ?? entry;
    const peak = p.peak_sol_value ?? entry;
    const gainPct = entry > 0 ? ((current - entry) / entry) * 100 : 0;
    const peakPct = entry > 0 ? ((peak - entry) / entry) * 100 : 0;
    const soldPct = p.sold_pct ?? 0;
    const fired = parseFiredTiers(p.tp_sl_fired);
    const hasPlan = p.auto_sell_plan_snapshot && p.auto_sell_plan_snapshot !== 'null';
    const planNote = hasPlan
      ? `Plan: <i>${summarisePlan(p.auto_sell_plan_snapshot)}</i>`
      : '<i>No plan — manual close</i>';

    // Mini bar: 10 chars of filled/empty
    const totalBars = 10;
    const filled = Math.min(totalBars, Math.round((soldPct / 100) * totalBars));
    const bar = '▓'.repeat(filled) + '░'.repeat(totalBars - filled);

    return [
      `<b>• <code>${p.mint.slice(0, 8)}…${p.mint.slice(-4)}</code></b>`,
      `  dev: ${shortAddr(p.dev_wallet)}`,
      `  opened: ${new Date(p.entry_time).toISOString().slice(11, 19)}Z`,
      `  spent: <code>${entry} SOL</code> → now: <code>${current} SOL</code>`,
      `  P&L: <b>${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(1)}%</b>  |  peak: <b>+${peakPct.toFixed(1)}%</b>`,
      `  sold: [${bar}] ${soldPct.toFixed(0)}%`,
      `  fired: ${fired.length > 0 ? fired.map((t) => `<code>${t}</code>`).join(' ') : '<i>none</i>'}`,
      `  ${planNote}`,
    ].join('\n');
  });
  return [
    `<b>💼 Open positions (${open.length}):</b>`,
    '',
    lines.join('\n\n'),
    '',
    hasAnyPlanOpen(open)
      ? '<i>Exit engine polling 1s — TP/SL/Trailing/Time tiers will fire automatically.</i>'
      : '<i>Positions with no plan require /closepos to sell manually.</i>',
  ].join('\n');
}

function parseFiredTiers(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function summarisePlan(raw) {
  if (!raw) return 'none';
  let plan;
  try { plan = JSON.parse(raw); } catch { return 'none'; }
  if (!plan || typeof plan !== 'object') return 'none';
  const parts = [];
  if (typeof plan.tp1 === 'number') parts.push(`TP1 +${plan.tp1}%`);
  if (typeof plan.tp2 === 'number') parts.push(`TP2 +${plan.tp2}%`);
  if (typeof plan.tp3 === 'number') parts.push(`TP3 +${plan.tp3}%`);
  if (typeof plan.sl === 'number') parts.push(`SL ${plan.sl}%`);
  if (typeof plan.trail === 'number') parts.push(`Trail ${plan.trail}%`);
  if (typeof plan.t1 === 'number') parts.push(`T1 ${plan.t1}s`);
  if (typeof plan.t2 === 'number') parts.push(`T2 ${plan.t2}s`);
  if (typeof plan.t3 === 'number') parts.push(`T3 ${plan.t3}s`);
  return parts.length > 0 ? parts.join(' · ') : 'none';
}

function hasAnyPlanOpen(positions) {
  return positions.some((p) => p.auto_sell_plan_snapshot && p.auto_sell_plan_snapshot !== 'null');
}

function buildSafetyText(chatId) {
  // v0.8.7.15: per-user. Each subscriber sees their own caps, pause state,
  // and settings — not a global aggregate.
  const s = safetySnapshot(chatId);
  return [
    '<b>🛟 Safety config</b>',
    '',
    `Mode:           ${s.mode}`,
    `Max SOL/trade:  ${s.maxSolPerTrade}`,
    `Slippage:       ${s.slippageBps} bps (${(s.slippageBps / 100).toFixed(1)}%)`,
    `Hold:           ${s.holdMs} ms`,
    `Daily loss cap: ${s.dailyLossCapSol} SOL`,
    `Pause active:   ${s.manualPaused ? 'yes' : 'no'}`,
  ].join('\n');
}

function buildHelpText() {
  return [
    '<b>❓ Help</b>',
    '',
    '<b>Wallets:</b>',
    '/addwallet &lt;addr&gt; [label] — add',
    '/removewallet &lt;addr&gt; — remove',
    '/wallets — show all',
    '',
    '<b>Settings (TradeWiz-style):</b>',
    '/settings — open settings menu',
    '(5 sub-menus: Trade / Filters / Token / Time / Advanced)',
    '',
    '<b>Control:</b>',
    '/pause — pause trading',
    '/resume — resume',
    '/status — safety + executor snapshot',
    '/safety — safety config',
    '',
    '<b>Trades:</b>',
    '/positions — open positions',
    '/recent [n] — last N closed',
    '',
    '<b>Multi-user:</b>',
    '/start — subscribe (auto on first message)',
    '/stop — unsubscribe from broadcasts',
    '/subscribers — list all subscribers',
    '',
    '<b>Menu:</b> /menu — same as /start (button UI)',
    '<b>Tip:</b> type / in chat to see the autocomplete list.',
  ].join('\n');
}

/**
 * Auto-subscribe middleware: every incoming message auto-adds the sender to
 * the subscribers table. This replaces the old owner-only auth model.
 */
function subscribeMiddleware(ctx, next) {
  if (ctx.chat?.id != null) {
    subscribersDb.add({
      chatId: ctx.chat.id,
      username: ctx.from?.username || null,
      firstName: ctx.from?.first_name || null,
    });
  }
  return next();
}

// v0.8.8 (experimental) M1.5: launch one Telegraf instance per token.
// The list comes from config.TELEGRAM_BOT_TOKEN_LIST (reads TELEGRAM_BOT_TOKENS
// first, then falls back to TELEGRAM_BOT_TOKEN for back-compat).
export function startTelegramBot({ onPause: pauseCb, onResume: resumeCb } = {}) {
  onPause = pauseCb;
  onResume = resumeCb;
  const tokenList = config.TELEGRAM_BOT_TOKEN_LIST;
  if (!tokenList || tokenList.length === 0) {
    throw new Error('No TELEGRAM_BOT_TOKEN(S) configured — cannot start bot');
  }
  const startedBots = [];
  for (const token of tokenList) {
    const inst = startSingleBot(token, { onPause: pauseCb, onResume: resumeCb });
    if (inst) startedBots.push(inst);
  }
  if (startedBots.length > 0) {
    notifier.attachBot(startedBots[0]);
    bots.push(...startedBots);
  }
  return bots;
}

/**
 * Internal: build and launch one Telegraf instance for a single token.
 * The body below is the legacy single-bot startTelegramBot logic with
 * `bot` renamed to `inst`. The wrapper above calls this once per token.
 */
function startSingleBot(token, { onPause: pauseCb, onResume: resumeCb } = {}) {
  let inst = null;
  onPause = pauseCb;
  onResume = resumeCb;
  if (!token) {
    throw new Error('Empty bot token — cannot start bot instance');
  }
  inst = new Telegraf(token);
  // CRITICAL: attach the inst to the notifier BEFORE attempting launch.
  // inst.launch() opens a long-poll for incoming updates, but inst.telegram.sendMessage
  // uses the Bot API directly and works fine without an active long-poll. If we
  // wait for launch to succeed, the 409-retry loop on a stale long-poll slot
  // leaves the notifier's inst reference null for the entire retry window (up to
  // 13 min), and every trade notification is silently dropped during that time.
  notifier.attachBot(inst);
  inst.use(subscribeMiddleware);

  // Pending "add wallet" state: chatId → { startedAt }
  // (User tapped "➕ Add Wallet" and the inst is waiting for a text reply.)
  const pendingAddWallet = new Map();
  const ADD_WALLET_TTL_MS = 5 * 60 * 1000; // 5 min

  // v0.8.8 (experimental) M6.1: pendingWalletRatio removed (ratio hardcoded 100).

  function isPendingAdd(chatId) {
    const p = pendingAddWallet.get(chatId);
    if (!p) return null;
    if (Date.now() - p.startedAt > ADD_WALLET_TTL_MS) {
      pendingAddWallet.delete(chatId);
      return null;
    }
    return p;
  }

  // ---- /start ----
  // v0.8.8: buildMainText is now async (fetches live SOL + SPL balance),
  // so the command handler is async too.
  inst.start(async (ctx) => {
    // subscribeMiddleware already added sender to subscribers table.
    // Show the main menu inline.
    const text = await buildMainText(ctx.chat.id);
    await ctx.replyWithHTML(text, mainMenu(ctx.chat.id));
  });

  // ---- /ping (debug: verify notifier can reach this chat) ----
  inst.command('ping', async (ctx) => {
    await notifier.ping(ctx.chat.id);
  });

  // ---- /menu (shortcut: re-show the main menu) ----
  inst.command('menu', async (ctx) => {
    const text = await buildMainText(ctx.chat.id);
    await ctx.replyWithHTML(text, mainMenu(ctx.chat.id));
  });

  // ---- callback_query handler (inline button taps) ----
  // Routes `menu:*` (navigate) and `cmd:*` (run command) callbacks to the
  // right screen. Edits the message in place so the chat doesn't fill up
  // with one new message per tap.
  inst.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    try {
      if (data === 'menu:main') {
        // v0.8.8: buildMainText is async (live balance fetch). await it
        // before passing to renderScreen so the Promise isn't stringified
        // into [object Promise] in the menu body.
        const text = await buildMainText(ctx.chat.id);
        await renderScreen(ctx, text, mainMenu(ctx.chat.id));
      } else if (data === 'cmd:copytrade_mirror') {
        // v0.8.8 M9: show wallet picker first — user picks which wallet
        // to configure for Mirror mode. When only 1 wallet, skip picker.
        const list = walletsDb.list(ctx.chat.id);
        if (list.length === 0) {
          await ctx.answerCbQuery('No wallets — add one first');
          await ctx.replyWithHTML(
            '⚠️ <b>No wallets to configure.</b>\nAdd a wallet first:\n' +
            '• /addwallet — paste a Solana address\n' +
            '• or tap "➕ Add new wallet" below.',
            Markup.inlineKeyboard([[Markup.button.callback('➕ Add new wallet', 'cmd:wallet_add')]])
          );
          return;
        }
        if (list.length === 1) {
          // Skip picker — go straight to that wallet's copy menu
          await ctx.answerCbQuery().catch(() => {});
          walletsDb.setCopyConfig({ chatId: ctx.chat.id, address: list[0].address, copyMode: 'mirror' });
          try {
            await ctx.replyWithHTML(walletCopyText(ctx.chat.id, list[0].id), walletCopyMenu(ctx.chat.id, list[0].id));
          } catch (e) {
            console.error('[telegramBot] copytrade_mirror reply error:', e.message);
          }
          return;
        }
        await ctx.answerCbQuery().catch(() => {});
        try {
          await ctx.replyWithHTML(buildWalletPickerText('mirror', ctx.chat.id), walletPickerKeyboard('mirror', ctx.chat.id));
        } catch (e) {
          console.error('[telegramBot] copytrade_mirror picker reply error:', e.message);
        }
      } else if (data === 'cmd:copytrade_reverse') {
        // v0.8.8 M9: show wallet picker first — user picks which wallet
        // to configure for Reverse mode. When only 1 wallet, skip picker.
        const list = walletsDb.list(ctx.chat.id);
        if (list.length === 0) {
          await ctx.answerCbQuery('No wallets — add one first');
          await ctx.replyWithHTML(
            '⚠️ <b>No wallets to configure.</b>\nAdd a wallet first:\n' +
            '• /addwallet — paste a Solana address\n' +
            '• or tap "➕ Add new wallet" below.',
            Markup.inlineKeyboard([[Markup.button.callback('➕ Add new wallet', 'cmd:wallet_add')]])
          );
          return;
        }
        if (list.length === 1) {
          // Skip picker — go straight to that wallet's copy menu
          await ctx.answerCbQuery().catch(() => {});
          walletsDb.setCopyConfig({ chatId: ctx.chat.id, address: list[0].address, copyMode: 'reverse' });
          try {
            await ctx.replyWithHTML(walletCopyText(ctx.chat.id, list[0].id), walletCopyMenu(ctx.chat.id, list[0].id));
          } catch (e) {
            console.error('[telegramBot] copytrade_reverse reply error:', e.message);
          }
          return;
        }
        await ctx.answerCbQuery().catch(() => {});
        try {
          await ctx.replyWithHTML(buildWalletPickerText('reverse', ctx.chat.id), walletPickerKeyboard('reverse', ctx.chat.id));
        } catch (e) {
          console.error('[telegramBot] copytrade_reverse picker reply error:', e.message);
        }
      } else if (data === 'cmd:copytrade' || data === 'menu:settings') {
        // Back-compat: legacy single-menu button. v0.8.8 M3.9 split
        // this into cmd:copytrade_mirror and cmd:copytrade_reverse.
        // Kept as an alias for any old messages that still have the
        // button. Default to 'both' so all settings are shown.
        await sm.renderFlat(ctx, 'both');
      } else if (data === 'menu:wallet') {
        // Bot's own trading wallet (encrypted). Set / Replace / Remove.
        // MUST be checked BEFORE the generic menu: catch-all below, otherwise
        // the catch-all would interpret "wallet" as an unknown settings
        // category and silently re-render the main menu (user sees "nothing
        // happened" on tap). The actual handler is at the bottom of this
        // chain; we shadow it here for routing correctness.
        await wm.renderWalletMenu(ctx);
      } else if (data.startsWith('menu:')) {
        // Catch-all for any other menu:* callbacks. In v0.5.2+ the only
        // valid menu:* callbacks are menu:main, menu:wallet, menu:settings
        // (alias for cmd:copytrade). Anything else falls back to the flat
        // Copy Trade menu. (Previously we routed menu:trade/filters/...
        // to category sub-menus; those are gone now.)
        const rest = data.slice('menu:'.length);
        if (rest === 'wallet' || rest === 'main') {
          // handled above
        } else {
          // v0.8.8 (experimental) M3.9: keep the active mode on
          // back-compat fall-through. Default to 'both' if not set.
          await sm.renderFlat(ctx, 'both');
        }
      } else if (data.startsWith('set:')) {
        // set:toggle:KEY  or  set:edit:KEY
        const parts = data.split(':');
        const action = parts[1];
        const key = parts.slice(2).join(':');
        await sm.handleSetCallback(ctx, action, key);
      } else if (data.startsWith('autosell:add:')) {
        // autosell:add:KEY:SLOT
        const parts = data.split(':');
        // parts = ['autosell', 'add', KEY, SLOT]
        const key = parts[2];
        const slot = parts.slice(3).join(':');
        await sm.handleAutoSellAdd(ctx, key, slot);
      } else if (data.startsWith('autosell:remove:')) {
        const parts = data.split(':');
        const key = parts[2];
        const slot = parts.slice(3).join(':');
        await sm.handleAutoSellRemove(ctx, key, slot);
      } else if (data.startsWith('autosell:disable:')) {
        const parts = data.split(':');
        const key = parts[2];
        await sm.handleAutoSellDisable(ctx, key);
      } else if (data === 'cmd:status') {
        await renderScreen(ctx, buildStatusText(ctx.chat.id), commandBackMenu());
      } else if (data === 'cmd:stats') {
        await renderScreen(ctx, buildStatsText(ctx.chat.id), commandBackMenu());
      } else if (data === 'cmd:balance') {
        // /balance is async (RPC). Re-route through the command handler
        // so the same loading-then-edit flow is used.
        await ctx.answerCbQuery();
        // Re-issue as a text command by simulating /balance via a fresh
        // call. Cheaper to just inline: send a "loading" message and edit.
        const wm0 = walletManager.getStatus(ctx.chat.id);
        if (!wm0.set) {
          await ctx.reply(
            '🔑 <b>No trading wallet set</b>\n\nUse /start → 🔑 Wallet → 🆕 Generate or 📥 Import to add one first.',
            { parse_mode: 'HTML' }
          );
          return;
        }
        const loading = await ctx.reply(`⏳ Fetching balances for <code>${wm0.address}</code>…`, { parse_mode: 'HTML' });
        try {
          const snap = await fetchBalanceSnapshot(wm0.address, { limit: 10 });
          const sol = snap.sol;
          const tokens = snap.tokens;
          const lines = [
            '<b>💰 Wallet balance</b>',
            '',
            `Address:  <code>${wm0.address}</code>`,
            '',
            '<b>SOL</b>',
            `  Balance:  ${sol.sol.toFixed(6)} SOL  (${sol.lamports.toLocaleString()} lamports)`,
            sol.error ? `  <i>RPC error: ${sol.error}</i>` : '',
            sol.cached ? '  <i>(cached &lt; 30s ago)</i>' : '',
            '',
            '<b>Top SPL tokens</b>',
          ];
          if (tokens.error) lines.push(`  <i>RPC error: ${tokens.error}</i>`);
          else if (tokens.tokens.length === 0) lines.push('  <i>none</i>');
          else for (const t of tokens.tokens) lines.push(`  • <code>${t.shortMint}</code>  ${t.uiAmountString || String(t.uiAmount)}`);
          lines.push('', `<i>Refreshed: ${new Date(snap.fetchedAt).toISOString().slice(11, 19)}Z</i>`);
          await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, lines.filter(Boolean).join('\n'), { parse_mode: 'HTML' });
        } catch (e) {
          await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, undefined, `❌ Failed: ${e.message || e}`);
        }
      } else if (data === 'cmd:wallets' || data === 'cmd:watchlist') {
        await renderScreen(ctx, buildWalletsText(ctx.chat.id), walletsMenu(ctx.chat.id));
      } else if (data.startsWith('wallet:copy:')) {
        // v0.8.8 M9: wid in callback (was address — too long for Telegram limit).
        const wid = Number(data.slice('wallet:copy:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        await ctx.answerCbQuery();
        await ctx.replyWithHTML(walletCopyText(ctx.chat.id, wid), walletCopyMenu(ctx.chat.id, wid));
      } else if (data.startsWith('wallet:open:')) {
        // v0.8.8 M9: wid in callback.
        const wid = Number(data.slice('wallet:open:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        await ctx.answerCbQuery();
        await ctx.replyWithHTML(walletCopyText(ctx.chat.id, wid), walletCopyMenu(ctx.chat.id, wid));
      } else if (data.startsWith('wset:open:')) {
        // v0.8.8 M9: wid in callback.
        const wid = Number(data.slice('wset:open:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        await ctx.answerCbQuery();
        await wsm.renderWalletSettings(ctx, wid);
      } else if (data.startsWith('wset:')) {
        // v0.8.8 M9: all wset:* callbacks now carry wid; route to handler.
        const handled = await wsm.handleCallback(ctx, data);
        if (handled) return;
      } else if (data.startsWith('wallet:mode:')) {
        // v0.8.8 M9: format wallet:mode:<wid>:<mode>
        const rest = data.slice('wallet:mode:'.length);
        const lastColon = rest.lastIndexOf(':');
        if (lastColon < 0) { await ctx.answerCbQuery('Bad request'); return; }
        const wid = Number(rest.slice(0, lastColon));
        const mode = rest.slice(lastColon + 1);
        if (!wid || !['off', 'reverse', 'mirror'].includes(mode)) {
          await ctx.answerCbQuery('Bad request'); return;
        }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        walletsDb.setCopyConfig({ chatId: ctx.chat.id, address: wallet.address, copyMode: mode });
        await ctx.answerCbQuery(`Set to ${mode}`);
        await ctx.replyWithHTML(walletCopyText(ctx.chat.id, wid), walletCopyMenu(ctx.chat.id, wid));
      } else if (data.startsWith('wallet:pick:')) {
        // v0.8.8 M9: format wallet:pick:<mode>:<wid>
        const rest = data.slice('wallet:pick:'.length);
        const lastColon = rest.lastIndexOf(':');
        if (lastColon < 0) { await ctx.answerCbQuery('Bad request'); return; }
        const mode = rest.slice(0, lastColon);
        const wid = Number(rest.slice(lastColon + 1));
        if (!wid || !['mirror', 'reverse'].includes(mode)) {
          await ctx.answerCbQuery('Bad request'); return;
        }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found — re-add it'); return; }
        if (wallet.copy_mode !== mode) {
          walletsDb.setCopyConfig({ chatId: ctx.chat.id, address: wallet.address, copyMode: mode });
        }
        await ctx.answerCbQuery();
        await ctx.replyWithHTML(walletCopyText(ctx.chat.id, wid), walletCopyMenu(ctx.chat.id, wid));
      } else if (data.startsWith('wallet:tp:')) {
        // v0.8.8 M11: dedicated TP button → set tp_sl_plan TP tier
        const wid = Number(data.slice('wallet:tp:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        wsm.setPending(ctx.chat.id, wallet.address, 'tp_sl_plan', 'edit', wallet.id);
        await ctx.answerCbQuery();
        await ctx.reply(
          '📈 <b>Set Take Profit</b>\n\nSend the TP percentage (e.g. <code>50</code> for +50%).\nSells 100% at TP.',
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'e.g. 50' } }
        ).catch(() => {});
      } else if (data.startsWith('wallet:sl:')) {
        // v0.8.8 M11: dedicated SL button → set sl_pct directly (separate DB key)
        const wid = Number(data.slice('wallet:sl:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        wsm.setPending(ctx.chat.id, wallet.address, 'sl_pct', 'edit', wallet.id);
        await ctx.answerCbQuery();
        await ctx.reply(
          '📉 <b>Set Stop Loss</b>\n\nSend the SL percentage as a negative number (e.g. <code>-30</code> for -30%).',
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'e.g. -30' } }
        ).catch(() => {});
      } else if (data.startsWith('wallet:trail:')) {
        const wid = Number(data.slice('wallet:trail:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        wsm.setPending(ctx.chat.id, wallet.address, 'trailing_stop', 'edit', wallet.id);
        await ctx.answerCbQuery();
        await ctx.reply(
          '🔄 <b>Set Trailing Stop</b>\n\nSend in format: <code>act:50 trail:10</code>\n(activate at +50%, trail 10% below peak).',
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'act:50 trail:10' } }
        ).catch(() => {});
      } else if (data.startsWith('wallet:time:')) {
        const wid = Number(data.slice('wallet:time:'.length));
        if (!wid) { await ctx.answerCbQuery('Bad wallet id'); return; }
        const wallet = walletsDb.getById(ctx.chat.id, wid);
        if (!wallet) { await ctx.answerCbQuery('Wallet not found'); return; }
        wsm.setPending(ctx.chat.id, wallet.address, 'time_sell_plan', 'edit', wallet.id);
        await ctx.answerCbQuery();
        await ctx.reply(
          '⏱ <b>Set Time-based Exit</b>\n\nSend in format: <code>30s:50 60s:100</code>\n(sell 50% after 30s, 100% after 60s).',
          { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true, input_field_placeholder: '30s:50 60s:100' } }
        ).catch(() => {});
      } else if (data === 'cmd:wallet_add') {
        // Enter pending-add mode. Next text message from this chat will be
        // parsed as: <address> [label]. 5-minute TTL.
        pendingAddWallet.set(ctx.chat.id, { startedAt: Date.now() });
        await ctx.answerCbQuery();
        await ctx.reply(
          '➕ <b>Add Wallet</b>\n\n' +
          'Send the Solana address (and optional label) as a reply.\n' +
          'Example: <code>7xKXtg...G3pump whale1</code>\n\n' +
          'Or /cancel to abort.',
          {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true, selective: true },
          }
        );
      } else if (data === 'cmd:positions') {
        await renderScreen(ctx, buildPositionsText(ctx.chat.id), commandBackMenu());
      } else if (data === 'cmd:safety') {
        await renderScreen(ctx, buildSafetyText(ctx.chat.id), commandBackMenu());
      } else if (data === 'cmd:help') {
        await renderScreen(ctx, buildHelpText(), commandBackMenu());
      } else if (data === 'cmd:toggle_pause') {
        // v0.8.7.15: per-user pause. Only this chat_id is toggled; other
        // subscribers' bots are unaffected.
        if (isPaused(ctx.chat.id)) {
          resume(ctx.chat.id);
          onResume?.();
        } else {
          pause(ctx.chat.id);
          onPause?.();
        }
        const text = await buildMainText(ctx.chat.id);
        await renderScreen(ctx, text, mainMenu(ctx.chat.id));
      } else if (data === 'cmd:set_wallet') {
        // Enter pending-import mode. Next text message in this DM is consumed
        // as the private key (see handlePendingWalletText).
        await wm.promptSetWallet(ctx);
      } else if (data === 'cmd:generate_wallet') {
        // 🆕 Generate: create a fresh keypair for this user.
        await wm.promptGenerateWallet(ctx);
      } else if (data === 'cmd:do_generate_wallet') {
        // User confirmed. Generate + encrypt + store.
        await wm.doGenerateWallet(ctx);
      } else if (data === 'cmd:export_wallet') {
        // 🔐 Export: send this user's private key as a single auto-deleted
        // message. NEVER broadcast, NEVER logged.
        await wm.promptExportWallet(ctx);
      } else if (data === 'cmd:remove_wallet') {
        // Show confirm dialog (don't delete yet).
        await wm.confirmRemoveWallet(ctx);
      } else if (data === 'cmd:do_remove_wallet') {
        // User confirmed. Wipe from DB.
        await wm.doRemoveWallet(ctx);
      } else {
        // Unknown callback — likely stale from an old message. Just refresh.
        const text = await buildMainText(ctx.chat.id);
        await renderScreen(ctx, text, mainMenu(ctx.chat.id));
      }
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('[telegramBot] callback error:', err.message || err);
      await ctx.answerCbQuery('Error').catch(() => {});
    }
  });

  // ---- /stop (unsubscribe) ----
  inst.command('stop', (ctx) => {
    if (ctx.chat?.id == null) return;
    const removed = subscribersDb.remove(ctx.chat.id);
    if (removed) {
      ctx.reply('🔕 Unsubscribed. You will no longer receive broadcast notifications.\n\nSend /start again to re-subscribe.');
    } else {
      ctx.reply("You weren't subscribed.");
    }
  });

  // ---- /help ----
  inst.help((ctx) => {
    ctx.reply(
      [
        '<b>Commands:</b>',
        '/menu — show main menu (button UI)',
        '/settings — TradeWiz-style settings (Trade / Filters / Token / Time / Advanced)',
        '/wallets — show tracked wallets',
        '/addwallet <code>&lt;address&gt;</code> [label] — add a watched wallet',
        '/removewallet <code>&lt;address&gt;</code> — remove a watched wallet',
        '/wallet — set / replace / remove the inst\'s trading key (encrypted at rest)',
        '/pause — pause trading',
        '/resume — resume',
        '/status — safety + executor snapshot',
        '/safety — safety config',
        '/positions — open positions',
        '/recent [n] — last N closed trades (default 10)',
        '/stop — unsubscribe from broadcasts',
        '',
        '<b>What I do:</b>',
        '1. Watch each of <i>your</i> wallets for token-creation transactions',
        '2. Watch each wallet for sell transactions of those tokens',
        '3. When a sell is detected, buy via Jupiter (using the inst wallet)',
        `4. Hold ${config.HOLD_MS}ms, then sell`,
        '5. Log PnL and notify <i>you</i> (the wallet owner)',
        '',
        '<b>Multi-user:</b> anyone can /start. Watchlists and trade alerts are private — you only see your own wallets, and only you get notified about your trades. /stop to unsubscribe.',
        '<b>Security:</b> /wallet stores the inst key AES-256-GCM encrypted and auto-deletes the key message.',
        '<b>Tip:</b> type / in chat to see the autocomplete command list.',
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  // ---- /addwallet (bulk: comma or newline separated) ----
  // Usage: /addwallet <addr1>
  //        /addwallet <addr1>,<addr2>,<addr3>
  //        /addwallet <addr1>
  //                <addr2> label2
  //                <addr3> label3
  // The optional label is the first non-address token after the address on
  // the same line. Each address is validated with isValidSolanaAddress.
  inst.command('addwallet', (ctx) => {
    const raw = ctx.message.text.replace(/^\/addwallet\s*/, '').trim();
    if (!raw) {
      return ctx.reply(
        'Usage:\n' +
        '  /addwallet <addr1>,<addr2>,<addr3>\n' +
        '  /addwallet <addr1> [label1]\n' +
        '        <addr2> [label2]\n' +
        '        <addr3> [label3]',
        { parse_mode: 'HTML' }
      );
    }
    // v0.6.1: scope to caller's chat_id (per-user watchlist).
    const { added, skipped } = bulkAddWalletsFromText(raw, ctx.chat.id);
    return ctx.reply(bulkAddResultMessage(added, skipped), { parse_mode: 'HTML' });
  });

  // ---- /removewallet ----
  inst.command('removewallet', (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const addr = parts[1];
    if (!addr) return ctx.reply('Usage: /removewallet <address>');
    // v0.6.1: only remove if this user owns it.
    const removed = walletsDb.remove({ chatId: ctx.chat.id, address: addr });
    if (removed) ctx.reply(`🗑️ Removed <code>${addr}</code>.`, { parse_mode: 'HTML' });
    else ctx.reply(`<code>${addr}</code> was not in your watchlist.`, { parse_mode: 'HTML' });
  });

  // ---- /listwallets (legacy alias) ----
  inst.command('listwallets', (ctx) => {
    ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu(ctx.chat.id));
  });

  // ---- /wallets (alias for the menu screen) ----
  inst.command('wallets', (ctx) => {
    ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu(ctx.chat.id));
  });

  // ---- /wallet (inst's own trading key — set / replace / remove) ----
  inst.command('wallet', (ctx) => {
    // Send as a new message (not edit). /wallet is a fresh command, not a
    // tap on an existing button.
    ctx.replyWithHTML(wm.buildWalletText(), wm.walletMenu());
  });

  // ---- /copytrade (alias: /settings) — flat single-screen settings menu ----
  inst.command(['copytrade', 'settings'], async (ctx) => {
    // Send as a new message (not edit). /copytrade is a fresh command.
    // v0.8.7.15: pass chatId so the menu shows THIS USER's values.
    try {
      await ctx.replyWithHTML(sm.buildFlatText(ctx.chat.id), sm.buildFlatKeyboard());
    } catch (e) {
      // Fallback if the text is empty for any reason
      await ctx.reply('❌ Could not render settings menu. Try /menu → 🎯 Copy Trade.');
    }
  });

  // ---- /pause ----
  inst.command('pause', (ctx) => {
    // v0.8.7.15: per-user pause. Only this chat_id is paused; other
    // subscribers' bots keep trading independently.
    pause(ctx.chat.id);
    onPause?.();
    ctx.reply('⏸  Trading paused for your account. New signals will be logged but not traded.');
  });

  // ---- /resume ----
  inst.command('resume', (ctx) => {
    resume(ctx.chat.id);
    onResume?.();
    ctx.reply('▶️  Trading resumed for your account.');
  });

  // ---- /status ----
  inst.command('status', (ctx) => {
    ctx.reply(buildStatusText(ctx.chat.id), { parse_mode: 'HTML' });
  });

  // ---- /stats — v0.8.0: detailed win/loss tracking ----
  // v0.8.8 (experimental) M3.5: also include copy_mode + copy_ratio so
  // users can see at a glance which signal type is triggering trades.
  inst.command('stats', (ctx) => {
    ctx.reply(buildStatsText(ctx.chat.id), { parse_mode: 'HTML' });
  });
  // v0.8.8 M3.5: /copystats is just an alias to /stats. The reference
  // bot the user is cloning uses `/copystats` so we add it for parity.
  inst.command('copystats', (ctx) => {
    ctx.reply(buildStatsText(ctx.chat.id), { parse_mode: 'HTML' });
  });

  // ---- /balance — v0.8.0: wallet SOL + SPL token balances ----
  inst.command('balance', async (ctx) => {
    const wm0 = walletManager.getStatus(ctx.chat.id);
    if (!wm0.set) {
      return ctx.reply(
        '🔑 <b>No trading wallet set</b>\n\n' +
        'Use /start → 🔑 Wallet → 🆕 Generate or 📥 Import to add one first.',
        { parse_mode: 'HTML' }
      );
    }
    // Send a "loading" reply that we will edit once the RPC returns.
    const loading = await ctx.reply(
      `⏳ Fetching balances for <code>${wm0.address}</code>…`,
      { parse_mode: 'HTML' }
    );
    try {
      const snap = await fetchBalanceSnapshot(wm0.address, { limit: 10 });
      const sol = snap.sol;
      const tokens = snap.tokens;
      const lines = [
        '<b>💰 Wallet balance</b>',
        '',
        `Address:  <code>${wm0.address}</code>`,
        '',
        '<b>SOL</b>',
        `  Balance:  ${sol.sol.toFixed(6)} SOL  (${sol.lamports.toLocaleString()} lamports)`,
        sol.error ? `  <i>RPC error: ${sol.error}</i>` : '',
        sol.cached ? '  <i>(cached &lt; 30s ago)</i>' : '',
        '',
        '<b>Top SPL tokens</b>',
      ];
      if (tokens.error) {
        lines.push(`  <i>RPC error: ${tokens.error}</i>`);
      } else if (tokens.tokens.length === 0) {
        lines.push('  <i>none</i>');
      } else {
        for (const t of tokens.tokens) {
          const ui = t.uiAmountString || String(t.uiAmount);
          lines.push(`  • <code>${t.shortMint}</code>  ${ui}`);
        }
      }
      lines.push('', `<i>Refreshed: ${new Date(snap.fetchedAt).toISOString().slice(11, 19)}Z</i>`);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        undefined,
        lines.filter(Boolean).join('\n'),
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loading.message_id,
        undefined,
        `❌ Failed to fetch balance: ${e.message || e}`,
      );
    }
  });

  // ---- /positions ----
  inst.command('positions', (ctx) => {
    // v0.8.7.15: per-user. Each subscriber sees their own open positions.
    // v0.8.8 (experimental) M2.10: use the rich buildPositionsText that
    // shows live value, peak gain %, fired tiers, sold_pct bar.
    return ctx.reply(buildPositionsText(ctx.chat.id), { parse_mode: 'HTML' });
  });

  // ---- /closepos ----
  // v0.8.8 (experimental) M2.11: manually force-close an open position.
  // Useful when a position has no plan (so the exit engine isn't polling)
  // or when the user wants to bail at a custom moment. Usage:
  //   /closepos <id>      — close a specific position by DB id
  //   /closepos all       — close every open position for this user
  inst.command('closepos', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const arg = parts[1] || '';
    const userOpen = positionsDb.openAll(ctx.chat.id);
    if (userOpen.length === 0) {
      return ctx.reply('ℹ️ No open positions to close.');
    }
    let targets;
    if (arg === 'all') {
      targets = userOpen;
    } else {
      const id = parseInt(arg, 10);
      if (Number.isNaN(id)) {
        return ctx.reply('Usage: <code>/closepos &lt;id&gt;</code> or <code>/closepos all</code>', { parse_mode: 'HTML' });
      }
      const pos = userOpen.find((p) => p.id === id);
      if (!pos) {
        return ctx.reply(`❌ Position #${id} not found in your open list. Use /positions to see your ids.`);
      }
      targets = [pos];
    }
    await ctx.reply(`⏳ Force-closing ${targets.length} position(s)…`);
    const { executeSell } = await import('./executor.js');
    const { stopExitLoop } = await import('./exitEngine.js');
    const results = [];
    for (const p of targets) {
      try {
        // Stop the exit loop first (if any) so it doesn't double-fire.
        stopExitLoop(p.id);
        const sellResult = await executeSell({
          positionId: p.id,
          mint: p.mint,
          chatId: ctx.chat.id,
          tokenRawAmount: p.entry_tokens ?? 0,
          tierName: 'manual',
        });
        positionsDb.close(p.id, {
          exitSig: sellResult.signature,
          exitSol: sellResult.solReceived,
          pnlSol: sellResult.solReceived - p.entry_sol,
        });
        results.push(`✅ #${p.id} <code>${p.mint.slice(0, 8)}…</code> closed: ${sellResult.solReceived.toFixed(6)} SOL`);
      } catch (e) {
        positionsDb.fail(p.id, `manual close: ${e.message}`);
        results.push(`❌ #${p.id} <code>${p.mint.slice(0, 8)}…</code> failed: ${e.message.slice(0, 100)}`);
      }
    }
    await ctx.reply(results.join('\n'), { parse_mode: 'HTML' });
  });

  // ---- /recent ----
  // v0.8.8 (experimental) M2.12: also show TIER_FIRED / POSITION_CLOSED
  // entries from the signals table (the audit trail). This gives users
  // a chronological view of every event on their positions: open, tier
  // fires, closes.
  inst.command('recent', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const n = Math.max(1, Math.min(50, parseInt(parts[1], 10) || 10));
    // v0.8.7.15: per-user. Each subscriber sees their own trade history.
    const closedList = positionsDb.recent(n, ctx.chat.id);
    // Look up TIER_FIRED + POSITION_CLOSED for any of this user's positions.
    const { signalsDb } = await import('./db.js');
    const openList = positionsDb.openAll(ctx.chat.id);
    const myMints = new Set([
      ...closedList.map((p) => p.mint),
      ...openList.map((p) => p.mint),
    ]);
    const tierFires = myMints.size > 0
      ? signalsDb.recent(n * 4, null).filter((s) => myMints.has(s.mint) && (s.type === 'TIER_FIRED' || s.type === 'POSITION_CLOSED'))
      : [];
    const tierLines = tierFires.slice(0, n).map((s) => {
      const data = safeJson(s.data_json) || {};
      const icon = s.type === 'POSITION_CLOSED' ? '✅' : '🎯';
      return `${icon} <code>${s.mint.slice(0, 8)}…</code> <b>${s.type}</b>${data.tier ? ` (${data.tier})` : ''}\n  ${new Date(s.timestamp).toISOString().slice(11, 19)}Z`;
    });
    const posLines = closedList.map((p) => {
      const pnlStr = p.pnl_sol != null ? `${p.pnl_sol >= 0 ? '+' : ''}${p.pnl_sol.toFixed(4)} SOL` : '—';
      const status = p.status === 'CLOSED' ? '✅' : p.status === 'FAILED' ? '❌' : '⏳';
      return `${status} <code>${p.mint.slice(0, 8)}…</code>\n  ${pnlStr}  (${new Date(p.entry_time).toISOString().slice(11, 19)}Z)`;
    });
    const totalLines = tierLines.length + posLines.length;
    if (totalLines === 0) return ctx.reply('No closed positions yet.');
    const sections = [];
    if (tierLines.length > 0) sections.push(`<b>🎯 Tier fires (${tierLines.length}):</b>\n\n${tierLines.join('\n')}`);
    if (posLines.length > 0) sections.push(`<b>📦 Position closes (${posLines.length}):</b>\n\n${posLines.join('\n')}`);
    ctx.reply(sections.join('\n\n'), { parse_mode: 'HTML' });
  });

  // ---- /safety ----
  inst.command('safety', (ctx) => {
    // v0.8.7.15: per-user. Show THIS USER's caps/pause, not global aggregate.
    const s = safetySnapshot(ctx.chat.id);
    ctx.reply(
      [
        '<b>Safety config</b>',
        `Mode:           ${s.mode}`,
        `Max SOL/trade:  ${s.maxSolPerTrade}`,
        `Slippage:       ${s.slippageBps} bps (${(s.slippageBps / 100).toFixed(1)}%)`,
        `Hold:           ${s.holdMs} ms`,
        `Daily loss cap: ${s.dailyLossCapSol} SOL`,
        `Pause active:   ${s.manualPaused ? 'yes' : 'no'}`,
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  // ---- /subscribers removed in v0.6.1 (privacy: don't expose other users' chat_ids) ----

  // ---- unknown command / free text ----
  inst.on('text', async (ctx) => {
    // Order matters here. First the settings edit flow, then "add wallet"
    // (watched wallet address), then "set trading wallet" (private key).
    // Each handler is gated by its own pending-map and returns true to
    // signal the message was consumed.
    if (await sm.handlePendingText(ctx)) return;
    if (await wsm.handlePendingText(ctx)) return;  // v0.8.8 M7: per-wallet value prompt
    if (await wm.handlePendingWalletText(ctx)) return;

    // Second check: is this user in pending-add-wallet mode? If yes, parse
    // the message as BULK input — comma or newline separated addresses,
    // each optionally followed by a label. Report a single summary.
    const chatId = ctx.chat?.id;
    if (chatId != null && isPendingAdd(chatId)) {
      const text = (ctx.message?.text || '').trim();
      if (text === '/cancel' || text === 'cancel') {
        pendingAddWallet.delete(chatId);
        return ctx.reply('❌ Cancelled.');
      }
      const { added, skipped } = bulkAddWalletsFromText(text, chatId);
      pendingAddWallet.delete(chatId);
      await ctx.reply(bulkAddResultMessage(added, skipped), { parse_mode: 'HTML' });
      // Re-show the wallets list with the new entries
      try {
        await ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu(ctx.chat.id));
      } catch (e) { /* ignore — message was best-effort */ }
      return;
    }

    if (ctx.message.text.startsWith('/')) {
      ctx.reply('Unknown command. Try /help.');
    }
  });

  // ---- error handler ----
  inst.catch((err) => {
    console.error('[telegramBot] error:', err);
  });

  // 409-retry wrapper: Telegraf's polling throws on "Conflict: terminated by
  // other getUpdates request" if a stale long-poll is still held (typical
  // after a hard crash of a previous instance, OR concurrent CLI getUpdates
  // calls from a developer). Telegram holds the slot for up to ~5 min. We
  // catch the 409, wait progressively longer, and re-launch.
  const launchWith409Retry = async (attempt = 1) => {
    try {
      await inst.launch({ dropPendingUpdates: false });
      notifier.attachBot(inst);

      // Register the command list so when a user types "/" in the chat,
      // Telegram shows the autocomplete list with descriptions.
      // (Scope: default — applies to all private chats with this inst.)
      try {
        await inst.telegram.setMyCommands(BOT_COMMANDS);
        console.log(`[telegramBot] setMyCommands: registered ${BOT_COMMANDS.length} commands.`);
      } catch (e) {
        console.warn('[telegramBot] setMyCommands failed (non-fatal):', e?.message || e);
      }

      console.log('[telegramBot] launched. Multi-user mode — no owner auth required.');
    } catch (err) {
      const is409 = err?.response?.error_code === 409 || /409/.test(String(err?.message));
      if (is409 && attempt <= 10) {
        // Progressive backoff: 15s, 30s, 45s, 60s, 75s, 90s, 105s, 120s, 135s, 150s
        // Total worst case: ~13 minutes. Plenty of time for Telegram to
        // release the stale long-poll slot.
        const wait = 15 * attempt;
        console.warn(
          `[telegramBot] getUpdates 409 (stale long-poll from a previous instance). ` +
            `retrying in ${wait}s (attempt ${attempt}/10)…`
        );
        await new Promise((r) => setTimeout(r, wait * 1000));
        return launchWith409Retry(attempt + 1);
      }
      throw err;
    }
  };
  // Fire and forget — we don't want index.js to block on this
  launchWith409Retry().catch((err) => {
    console.error('[telegramBot] launch failed permanently:', err);
    process.exit(1);
  });

  return inst;
}

export function stopTelegramBot() {
  for (const inst of bots) {
    try { inst.stop('shutdown'); } catch {}
  }
  bots.length = 0;
}
