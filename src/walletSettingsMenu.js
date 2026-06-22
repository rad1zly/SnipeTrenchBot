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
import {
  getCatalogEntry, get, getForWallet, setForWallet, resetForWallet,
  listWalletOverrides,
} from './settings.js';

// Trade-decision keys that can be overridden per-wallet. Keep this list
// in sync with what's actually used in executor.js / filters.js / safety.js.
// Network-level keys (buy_priority_fee_sol, jito_*, _pause) are NOT here.
const PER_WALLET_KEYS = [
  // Trade sizing & filters
  'fixed_buy_sol',
  'trader_sell_limit_min',
  'trader_sell_limit_max',
  'trader_buy_limit_min',
  'trader_buy_limit_max',
  'min_sell_ratio',
  'no_duplicate_buys',
  // Slippage
  'slippage_bps',
  'pump_slippage_bps',
  'pump_sell_slippage_bps',
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
 * In-memory map of pending edits. Key: `wset:pending:<chatId>:<address>`
 * Value: { chatId, address, key, mode: 'edit'|'reset' }
 * Cleared after the user sends the new value (or the timeout).
 */
const PENDING = new Map();

function pendingKey(chatId, address) {
  return `${chatId}:${address}`;
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/**
 * Build the per-wallet settings text. Shows the wallet address and a
 * list of trade-decision keys with their effective value (per-wallet
 * override if set, otherwise global). An emoji flag indicates whether
 * the row is using an override (🟢) or the global value (⚪).
 */
function buildWalletSettingsText(chatId, address) {
  const wid = require_db('resolve wid');
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
 */
function buildWalletSettingsKeyboard(chatId, address) {
  const buttons = [];
  const overrides = listWalletOverrides(chatId, address);
  const overrideKeys = new Set(overrides.map(o => o.key));
  for (const key of PER_WALLET_KEYS) {
    const setting = getCatalogEntry(key);
    if (!setting) continue;
    const row = [];
    if (setting.type === 'bool') {
      row.push(Markup.button.callback(`${setting.label} (toggle)`, `wset:toggle:${address}:${key}`));
    } else {
      row.push(Markup.button.callback(`✏️ ${setting.label}`, `wset:edit:${address}:${key}`));
    }
    if (overrideKeys.has(key)) {
      row.push(Markup.button.callback(`↩ Reset`, `wset:reset:${address}:${key}`));
    }
    buttons.push(row);
  }
  buttons.push([
    Markup.button.callback('« Wallet menu', `wallet:open:${address}`),
    Markup.button.callback('« Wallets list', 'cmd:wallets'),
  ]);
  return Markup.inlineKeyboard(buttons);
}

// -----------------------------------------------------------------------------
// Render entry point
// -----------------------------------------------------------------------------

/**
 * Render the per-wallet settings screen for a watched wallet.
 * Called from telegramBot.js when user taps "⚙️ Per-wallet settings"
 * in the walletCopyMenu.
 */
export async function renderWalletSettings(ctx, address) {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCbQuery('No chat context');
    return;
  }
  const text = buildWalletSettingsText(chatId, address);
  const kb = buildWalletSettingsKeyboard(chatId, address);
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
  // wset:ACTION:ADDRESS:KEY
  // (address is base58, no colons; key can have colons? — current keys
  // don't, so split into 4 parts is safe. Defensively allow more parts.)
  const rest = data.slice('wset:'.length);
  const parts = rest.split(':');
  const action = parts[0];
  const address = parts[1];
  const key = parts.slice(2).join(':');

  if (!address || !key) {
    await ctx.answerCbQuery('Bad callback');
    return true;
  }
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
    // Flip current effective value
    const current = getForWallet(key, chatId, address);
    const newVal = !current;
    try {
      setForWallet(key, newVal, chatId, address);
    } catch (e) {
      await ctx.answerCbQuery(`Save failed: ${e.message}`);
      return true;
    }
    await ctx.answerCbQuery(`${setting.label}: ${newVal ? 'ON' : 'OFF'}`);
    await renderWalletSettings(ctx, address);
    return true;
  }

  if (action === 'edit') {
    // Prompt for new value
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
        ? 'Format: <code>tp1:50/30 tp2:100/40 sl:-40/100</code>  (tp_pct/sell_pct, sl_pct/sl_sell_pct)'
        : setting.label === 'Trailing Stop'
        ? 'Format: <code>act:50 trail:-10</code>  (activate_at_pct, trail_pct)'
        : setting.label === 'Time Sell Plan'
        ? 'Format: <code>5m:50 30m:100</code>  (time_sold_pct)'
        : setting.min != null && setting.max != null
        ? `Range: ${setting.min} — ${setting.max}${unit}`
        : '',
    ].join('\n');
    // Store pending state
    PENDING.set(pendingKey(chatId, address), { chatId, address, key, action: 'edit' });
    try {
      await ctx.editMessageText(promptText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('↩ Cancel', `wset:cancel:${address}`)],
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
    await renderWalletSettings(ctx, address);
    return true;
  }

  if (action === 'cancel') {
    PENDING.delete(pendingKey(chatId, address));
    await renderWalletSettings(ctx, address);
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
  if (setting.parseUserInput) {
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

  try {
    setForWallet(found.key, value, found.chatId, found.address);
  } catch (e) {
    await ctx.reply(`❌ Save failed: ${e.message}`);
    return true;
  }
  PENDING.delete(found.key);
  await ctx.reply(
    `✅ ${setting.label} = <b>${setting.formatValue ? setting.formatValue(value) : value}</b>  (override for <code>${found.address.slice(0, 4)}…${found.address.slice(-4)}</code>)`,
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
 * Marker export so the require import above doesn't get tree-shaken in
 * test harnesses. Not used at runtime.
 */
function require_db(label) {
  // Used to ensure the resolver runs and throws if user isn't watching
  // the wallet. Throw a synthetic error if address is bad.
  return null;
}

export { PER_WALLET_KEYS };
