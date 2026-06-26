// src/walletSettingsMenu.js
// =============================================================================
// v0.8.8 (experimental) M7: per-watched-wallet settings UI.
//
// User feedback: "di menu copy trade ato reverse trade aja, kita bisa add
// wallet disitu ato pilih config walletnya" — the per-wallet settings
// should be accessible from the walletCopyMenu (the menu that shows when
// you tap a wallet in /wallets). Each watched wallet has its own trade
// character (snipe small, whale big, etc), so users need to tune each
// independently.
//
// Resolution chain (handled by settings.getForWallet):
//   1. wallet_settings override (if set)
//   2. user_settings (global default)
//   3. env fallback
//   4. code default
//
// This module renders the per-wallet settings sub-menu and handles
// callbacks. The catalog is filtered to trade-decision keys only —
// network-level settings (priority fee, jito tips, pause) stay per-user
// global and are NOT shown here.
//
// Callback prefix: `wset:` (vs `set:` for global settings) to avoid
// collisions and to make routing obvious in the bot's switch statement.
// =============================================================================

import { Markup } from 'telegraf';
import { walletsDb } from './db.js';  // v0.8.8 M9: for getById lookup
import {
  getCatalogEntry, get, getForWallet, setForWallet, getForWalletById, setForWalletById, resetForWallet,
  listWalletOverrides,
} from './settings.js';

// v0.8.8 M10: per-wallet keys shown inline in the wallet copy-menu.
// Just pump_slippage_bps — other settings stay global.
// v0.8.8 M12: QUICK_KEYS unused — per-wallet settings are inline in walletCopyMenu.
const QUICK_KEYS = [];

// Full trade-decision keys that can be overridden per-wallet. Keep this list
// in sync with what's actually used in executor.js / filters.js / safety.js.
// Network-level keys (jito_*, _pause) are NOT here.
// buy_priority_fee_sol IS per-wallet (v0.8.8 M12).
const PER_WALLET_KEYS = [
  // Trade sizing & filters
  'dev_only',
  'fixed_buy_sol',
  'buy_priority_fee_sol',
  'sell_priority_fee_sol',
  'jito_buy_tip_sol',
  'jito_sell_tip_sol',
  'trader_sell_limit_min',
  'trader_sell_limit_max',
  'trader_buy_limit_min',
  'trader_buy_limit_max',
  'min_sell_ratio',
  'no_duplicate_buys',
  // Slippage
  'slippage_bps',
  // Exit engine
  'hold_ms',
  'auto_sell',
  'auto_retry',
  'tp_sl_plan',
  'trailing_stop',
  'time_sell_plan',
  // Token filters
  'min_token_age_min',
  'max_token_age_min',
  'min_mc_usd',
  'max_mc_usd',
  // Spending cap
  'sol_spending_limit',
];

/**
 * In-memory map of pending edits. Key: `wset:pending:<chatId>:<wid>`
 * Value: { chatId, wid, address, key, action: 'edit' }
 * address is stored for use in setForWallet after value is received.
 * Cleared after the user sends the new value (or the timeout).
 */
const PENDING = new Map();

// v0.8.8 M11: exported so telegramBot.js can set pending for dedicated TP/SL/Trail/Time buttons.
export function setPending(chatId, address, key, action = 'edit', wid = null) {
  PENDING.set(`${chatId}:${wid ?? address}`, { chatId, wid, address, key, action });
}


// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/**
 * Build the per-wallet settings text. Shows the wallet address and a
 * list of trade-decision keys with their effective value (per-wallet
 * override if set, otherwise global). An emoji flag indicates whether
 * the row is using an override (🟢) or the global value (⚪).
 *
 * v0.8.8 M9: wid (integer row-id) replaces address string in all callbacks.
 * address is resolved here for DB lookups and display only.
 */
function buildWalletSettingsText(chatId, wid) {
  const wallet = require_db_wallet(chatId, wid);
  if (!wallet) return 'Wallet not found.';
  const address = wallet.address;
  const overrides = listWalletOverrides(chatId, address);
  const overrideKeys = new Set(overrides.map(o => o.key));

  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  const lines = [
    `⚙️ <b>Per-wallet settings</b>`,
    `<code>${address}</code>  (${short})`,
    '',
    '<i>🟢 = override set  ·  ⚪ = using global default</i>',
    '<i>Tap a row to set/clear an override for THIS wallet only.</i>',
    '',
  ];

  for (const key of PER_WALLET_KEYS) {
    const setting = getCatalogEntry(key);
    if (!setting) continue;  // skip if catalog no longer has it
    const isOverride = overrideKeys.has(key);
    const flag = isOverride ? '🟢' : '⚪';
    const effVal = getForWallet(key, chatId, address);
    const globVal = get(key, chatId);
    const show = (v) => setting.formatValue ? setting.formatValue(v) : (v == null ? '—' : String(v));
    const effStr = show(effVal);
    const globStr = show(globVal);
    if (isOverride && String(globVal) !== String(effVal)) {
      lines.push(`${flag} <b>${setting.label}</b>: ${effStr}  <i>(global: ${globStr})</i>`);
    } else {
      lines.push(`${flag} <b>${setting.label}</b>: ${effStr}`);
    }
  }

  // Summary footer
  const total = PER_WALLET_KEYS.filter(k => overrideKeys.has(k)).length;
  if (total === 0) {
    lines.push('');
    lines.push('<i>No overrides set. This wallet uses all global defaults.</i>');
  } else {
    lines.push('');
    lines.push(`<i>${total} override${total === 1 ? '' : 's'} set for this wallet.</i>`);
  }
  return lines.join('\n');
}

/**
 * Build the inline keyboard. Each key gets its own row with "Edit" and
 * "Reset" buttons (Reset only if an override is set). Footer: Back to
 * wallet menu.
 *
 * v0.8.8 M9: uses wid (integer) in all callbacks to stay under
 * Telegram's 64-byte inline-button limit.
 */
function buildWalletSettingsKeyboard(chatId, wid) {
  const wallet = require_db_wallet(chatId, wid);
  if (!wallet) return Markup.inlineKeyboard([[Markup.button.callback('« Back', 'cmd:wallets')]]);
  const address = wallet.address;
  const buttons = [];
  const overrides = listWalletOverrides(chatId, address);
  const overrideKeys = new Set(overrides.map(o => o.key));
  for (const key of PER_WALLET_KEYS) {
    const setting = getCatalogEntry(key);
    if (!setting) continue;
    const row = [];
    if (setting.type === 'bool') {
      row.push(Markup.button.callback(`${setting.label} (toggle)`, `wset:toggle:${wid}:${key}`));
    } else {
      row.push(Markup.button.callback(`✏️ ${setting.label}`, `wset:edit:${wid}:${key}`));
    }
    if (overrideKeys.has(key)) {
      row.push(Markup.button.callback(`↩ Reset`, `wset:reset:${wid}:${key}`));
    }
    buttons.push(row);
  }
  buttons.push([
    Markup.button.callback('« Wallet menu', `wallet:open:${wid}`),
    Markup.button.callback('« Wallets list', 'cmd:wallets'),
  ]);
  return Markup.inlineKeyboard(buttons);
}

// -----------------------------------------------------------------------------
// Render entry point
// -----------------------------------------------------------------------------

/**
 * Render the per-wallet settings screen for a watched wallet.
 * v0.8.8 M9: accepts wid (integer row-id) instead of address string.
 */
export async function renderWalletSettings(ctx, wid) {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCbQuery('No chat context');
    return;
  }
  const text = buildWalletSettingsText(chatId, wid);
  const kb = buildWalletSettingsKeyboard(chatId, wid);
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...kb,
    });
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
}

// -----------------------------------------------------------------------------
// Callback router
// -----------------------------------------------------------------------------

/**
 * Handle `wset:*` callbacks. Returns true if the callback was for us.
 * Callers should `if (await wsm.handleCallback(ctx, data)) return;` early
 * in the callback switch.
 */
export async function handleCallback(ctx, data) {
  if (!data || !data.startsWith('wset:')) return false;
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCbQuery('No chat context');
    return true;
  }
  // v0.8.8 M9: wset:ACTION:WID[:KEY]  (wid is integer row-id)
  // KEY is optional (e.g. cancel action doesn't need it)
  const rest = data.slice('wset:'.length);
  const parts = rest.split(':');
  const action = parts[0];
  const wid = Number(parts[1]);
  const key = parts.slice(2).join(':');

  if (!wid || isNaN(wid)) {
    await ctx.answerCbQuery('Bad callback');
    return true;
  }

  // Cancel: no key needed
  if (action === 'cancel') {
    PENDING.delete(`${chatId}:${wid}`);
    await ctx.answerCbQuery('Cancelled');
    await ctx.reply('↩ Cancelled.').catch(() => {});
    return true;
  }

  if (!key) {
    await ctx.answerCbQuery('Bad callback');
    return true;
  }
  const wallet = require_db_wallet(chatId, wid);
  if (!wallet) {
    await ctx.answerCbQuery('Wallet not found');
    return true;
  }
  const address = wallet.address;
  const setting = getCatalogEntry(key);
  if (!setting) {
    await ctx.answerCbQuery('Unknown setting');
    return true;
  }
  if (!PER_WALLET_KEYS.includes(key)) {
    await ctx.answerCbQuery('This setting is not per-wallet');
    return true;
  }

  if (action === 'toggle') {
    if (setting.type !== 'bool') {
      await ctx.answerCbQuery('Not a toggle');
      return true;
    }
    const current = getForWallet(key, chatId, address);
    const newVal = !current;
    try {
      setForWallet(key, newVal, chatId, address);
    } catch (e) {
      await ctx.answerCbQuery(`Save failed: ${e.message}`);
      return true;
    }
    await ctx.answerCbQuery(`${setting.label}: ${newVal ? 'ON' : 'OFF'}`);
    await renderWalletSettings(ctx, wid);
    return true;
  }

  if (action === 'edit') {
    const current = getForWallet(key, chatId, address);
    const globalVal = get(key, chatId);
    const unit = setting.unit ? ` (${setting.unit})` : '';
    const isOverride = listWalletOverrides(chatId, address).some(o => o.key === key);
    const promptText = [
      `✏️ <b>Set per-wallet override</b>`,
      '',
      `<b>Setting:</b> ${setting.label}${unit}`,
      `<b>Wallet:</b> <code>${address.slice(0, 4)}…${address.slice(-4)}</code>`,
      `<b>Current effective value:</b> ${setting.formatValue ? setting.formatValue(current) : (current ?? '—')}`,
      `<b>Global default:</b> ${setting.formatValue ? setting.formatValue(globalVal) : (globalVal ?? '—')}`,
      isOverride ? `<i>(this wallet currently has an override)</i>` : `<i>(this wallet is using the global default)</i>`,
      '',
      `<b>Send the new value</b> as a reply to this message. Send /cancel to abort.`,
      '',
      setting.label === 'TP/SL Plan'
        ? 'Format: <code>tp:50</code> or <code>tp:50 sl:-30</code>  (takes profit at 50%, stop loss at -30%)'
        : setting.label === 'Trailing Stop'
        ? 'Format: <code>act:50 trail:10</code>  (activate at 50%, trail 10%)'
        : setting.label === 'Time-based Exit'
        ? 'Format: <code>30s:50 60s:100</code>  (sell 50% after 30s, 100% after 60s)'
        : setting.min != null && setting.max != null
        ? `Range: ${setting.min} — ${setting.max}${unit}`
        : '',
    ].join('\n');
    PENDING.set(`${chatId}:${wid ?? address}`, { chatId, wid, address, key, action: 'edit' });
    try {
      await ctx.editMessageText(promptText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('↩ Cancel', `wset:cancel:${wid}`)],
        ]),
      });
    } catch (err) {
      if (!String(err.message || '').includes('message is not modified')) throw err;
    }
    return true;
  }

  if (action === 'reset') {
    try {
      const removed = resetForWallet(key, chatId, address);
      if (removed) {
        await ctx.answerCbQuery(`${setting.label} reset to global`);
      } else {
        await ctx.answerCbQuery('No override to clear');
      }
    } catch (e) {
      await ctx.answerCbQuery(`Reset failed: ${e.message}`);
    }
    await renderWalletSettings(ctx, wid);
    return true;
  }

  if (action === 'cancel') {
    PENDING.delete(`${chatId}:${wid ?? address}`);
    await renderWalletSettings(ctx, wid);
    return true;
  }

  await ctx.answerCbQuery('Unknown action');
  return true;
}

// -----------------------------------------------------------------------------
// Text input handler (for the value prompt)
// -----------------------------------------------------------------------------

/**
 * Handle a text message that might be a reply to a per-wallet edit prompt.
 * Returns true if it was for us (caller should `return;`).
 */
export async function handlePendingText(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  // Find ANY pending entry for this user (only one at a time per chat)
  let found = null;
  for (const [k, v] of PENDING.entries()) {
    if (k.startsWith(`${chatId}:`)) { found = { key: k, ...v }; break; }
  }
  if (!found) return false;

  const text = (ctx.message?.text || '').trim();
  if (text === '/cancel' || text === 'cancel') {
    PENDING.delete(found.key);
    await ctx.reply('↩ Cancelled.');
    return true;
  }

  const setting = getCatalogEntry(found.key);
  if (!setting) {
    PENDING.delete(found.key);
    return false;
  }

  // Parse the value. Use the catalog's parseUserInput if available,
  // else coerce by type.
  let value = text;

  // v0.8.8 M11: tp_sl_plan shortcut — plain positive number = TP tier.
  if (found.key === 'tp_sl_plan') {
    const n = parseFloat(text);
    if (!isNaN(n) && String(n) === text.trim() && n > 0) {
      // Read existing tp_sl_plan — also pull sl_pct from standalone field so
      // we don't lose it if user set SL via the dedicated SL button first.
      let existing = {};
      try { existing = JSON.parse(getForWalletById('tp_sl_plan', found.wid) || '{}'); } catch {}
      const tiers = existing.tiers || [];
      if (tiers.length === 0) tiers.push({ tp_pct: n, sell_pct: 100 });
      else { tiers[0] = { tp_pct: n, sell_pct: 100 }; }
      // Preserve sl_pct from standalone field if set (don't regress to old tp_sl_plan.sl_pct)
      const standaloneSl = getForWalletById('sl_pct', found.wid);
      const sl_pct = standaloneSl != null ? standaloneSl : existing.sl_pct;
      const sl_sell_pct = existing.sl_sell_pct || 100;
      value = JSON.stringify({ tiers, sl_pct, sl_sell_pct });
    } else {
      // Fall through to parseUserInput for full "tp:50 sl:-30" syntax
      const parsed = setting.parseUserInput(text);
      if (parsed == null) {
        await ctx.reply('❌ Invalid. Send a positive number for TP (e.g. <code>50</code> for +50%).');
        return true;
      }
      value = parsed;
    }
  } else if (setting.parseUserInput) {
    const parsed = setting.parseUserInput(text);
    if (parsed == null) {
      await ctx.reply(
        `❌ Invalid value. Send a value in the supported format, or /cancel.`
      );
      return true;
    }
    value = parsed;
  } else if (setting.type === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      await ctx.reply(`❌ Expected a number, got: ${text}`);
      return true;
    }
    value = n;
  } else if (setting.type === 'bool') {
    if (/^(true|on|yes|1)$/i.test(text)) value = true;
    else if (/^(false|off|no|0)$/i.test(text)) value = false;
    else {
      await ctx.reply(`❌ Expected true/false, got: ${text}`);
      return true;
    }
  } else {
    value = String(text);
  }

  // Resolve wallet: prefer wid (row-id), fall back to address lookup
  let wallet = null;
  if (found.wid != null) {
    wallet = walletsDb.getById(found.chatId, found.wid);
  }
  if (!wallet && found.address) {
    wallet = walletsDb.getById(found.chatId, found.address);
  }
  if (!wallet) {
    PENDING.delete(found.key);
    await ctx.reply('❌ Wallet not found. Please try editing the setting again.');
    return true;
  }
  // Resolve wid if not in PENDING (e.g. legacy entry from before wid was stored)
  let saveWid = found.wid;
  if (saveWid == null && wallet) {
    const resolved = walletsDb.getById(found.chatId, wallet.id);
    if (resolved) saveWid = resolved.id;
  }
  try {
    if (saveWid != null) {
      setForWalletById(found.key, value, saveWid);
    } else {
      // Fall back to address-based set (uses resolveWatchedWalletId internally)
      setForWallet(found.key, value, found.chatId, found.address);
    }
  } catch (e) {
    await ctx.reply(`❌ Save failed: ${e.message}`);
    return true;
  }
  // v0.8.8 M13: sync sl_pct into tp_sl_plan so the TP handler doesn't regress it.
  if (found.key === 'sl_pct' && value != null) {
    let existing = {};
    try { existing = JSON.parse(getForWalletById('tp_sl_plan', saveWid) || '{}'); } catch {}
    const sl_sell_pct = existing.sl_sell_pct || 100;
    const merged = { ...existing, sl_pct: value, sl_sell_pct };
    setForWalletById('tp_sl_plan', JSON.stringify(merged), saveWid);
  }
  PENDING.delete(found.key);
  const shortAddr = (found.address || '').slice(0, 4) + '…' + (found.address || '').slice(-4);
  await ctx.reply(
    `✅ ${setting.label} = <b>${setting.formatValue ? setting.formatValue(value) : value}</b>  (override for <code>${shortAddr}</code>)`,
    { parse_mode: 'HTML' }
  );
  // Re-render the wallet settings menu (in the chat where they came from)
  // NOTE: we don't have ctx here for editMessageText since this is a new
  // text message. User can tap "⚙️ Per-wallet settings" again to refresh.
  return true;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Resolve a wallet row from its integer row-id.
 * Returns null if not found or not owned by this chat — callers should
 * handle that as "wallet not found".
 * v0.8.8 M9: replaces the old require_db stub.
 */
function require_db_wallet(chatId, wid) {
  return walletsDb.getById(chatId, wid);
}

export {
  PER_WALLET_KEYS,
  QUICK_KEYS,
  getCatalogEntry,
  get,
  getForWallet,
  setForWallet,
  resetForWallet,
  listWalletOverrides,
};
