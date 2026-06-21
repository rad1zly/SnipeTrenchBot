// src/settingsMenu.js
// =============================================================================
// TradeWiz-style settings UI — flat single-screen view.
// Every setting is a row on one scrollable screen, with 2-column pairing for
// related settings (Max/Min MC, Max/Min Token Age, etc). Tap a row to edit;
// bools toggle on a single tap. Category dividers separate the sections
// visually but every setting stays in one Telegram message.
//
// This is a "Copy Trade" config: it controls how the bot trades whenever a
// watched wallet sells. Currently a single global config (one set of
// settings applies to all watched wallets). Tag/Target Wallet per-config
// is a v0.6+ feature.
// =============================================================================

import { Markup } from 'telegraf';
import {
  byCategory, getCatalogEntry, get, getBool, getNumber, getString,
  set, toggle, listCatalog,
  formatValue, formatSource,
} from './settings.js';

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------

const NULLABLE_NUMBER_KEYS = new Set([
  'min_mc_usd', 'max_mc_usd',
  'min_token_age_min', 'max_token_age_min',
  'sol_spending_limit', 'buy_priority_fee_sol',
  'tp_sl_plan', 'trailing_stop', 'dev_sell_trigger', 'time_sell_plan', 'sl_pct',
]);

const CATEGORY_LABELS = {
  trade:    { emoji: '💰', label: 'Trade',    desc: 'Per-trade params (SOL size, slippage, fees)' },
  filters:  { emoji: '🔍', label: 'Filters',  desc: 'Entry conditions (unrenounced, MC, age, exclude)' },
  token:    { emoji: '🪙', label: 'Token',    desc: 'Per-token limits (buy limit, daily cap)' },
  time:     { emoji: '⏰', label: 'Time',     desc: 'Active-hours window (UTC)' },
  advanced: { emoji: '🔧', label: 'Advanced', desc: 'Tag, hold time, raw overrides' },
};

// TradeWiz pairs that go side-by-side (2-column layout). Order matters:
// the FIRST key goes in the left column, the SECOND in the right.
const PAIR_GROUPS = [
  ['max_mc_usd',           'min_mc_usd'],
  ['max_token_age_min',    'min_token_age_min'],
  ['buy_priority_fee_sol', 'jito_buy_tip_sol'],
  ['slippage_bps',         'pump_slippage_bps'],
  ['jito_sell_tip_sol',    'pump_sell_slippage_bps'],
  ['unrenounced_only',     'unburned_only'],
  ['exclude_internal',     'exclude_external'],
  ['start_time',           'end_time'],
];

// Build a quick lookup: key -> pair key (so we can dedupe when iterating)
const PAIR_OF = new Map();
for (const [left, right] of PAIR_GROUPS) {
  PAIR_OF.set(left, right);
  PAIR_OF.set(right, left);
}
const SEEN = new Set();

// In-memory state: which setting the user is currently editing
// chatId -> { key, startedAt, menuMessageId }
//   menuMessageId is the Telegram message_id of the flat settings screen the
//   user was looking at when they tapped the [KEY = value] button. After a
//   successful value save we edit THIS message in place (not the latest
//   message in the chat, which would be the force-reply prompt that just
//   got answered — editing that fails with "message can't be edited" since
//   it wasn't originated by a callback_query).
const pendingEdit = new Map();
const EDIT_TTL_MS = 5 * 60 * 1000; // 5 min

function isPending(chatId) {
  const p = pendingEdit.get(chatId);
  if (!p) return null;
  if (Date.now() - p.startedAt > EDIT_TTL_MS) {
    pendingEdit.delete(chatId);
    return null;
  }
  return p;
}

function setPending(chatId, key, menuMessageId = null) {
  pendingEdit.set(chatId, { key, startedAt: Date.now(), menuMessageId });
}

function clearPending(chatId) {
  pendingEdit.delete(chatId);
}

function describeRange(setting) {
  if (setting.type === 'bool') return 'toggle: on / off';
  if (setting.type === 'time') return '<code>HH:MM</code> (00:00 - 23:59 UTC)';
  if (setting.type === 'text') return `text, max ${setting.maxLen ?? 32} chars`;
  if (setting.type === 'number') {
    let s = '';
    if (setting.min != null) s += `≥ <code>${setting.min}</code>`;
    if (setting.min != null && (setting.max == null || setting.max === Infinity)) s += ', ';
    if (setting.max == null || setting.max === Infinity) {
      s += 'no upper bound';
    } else {
      s += `, ≤ <code>${setting.max}</code>`;
    }
    if (NULLABLE_NUMBER_KEYS.has(setting.key)) {
      s += ' — or <code>none</code> / <code>unlimited</code> / <code>off</code> to disable';
    }
    return s;
  }
  return '';
}

// -----------------------------------------------------------------------------
// Render — flat single-screen with paired 2-column rows
// -----------------------------------------------------------------------------

/**
 * Build the full flat settings text. Every setting is on one screen,
 * grouped into category sections. Pairs (Max/Min) sit on the same row.
 */
/**
 * Build the trade settings menu text for ONE user.
 * v0.8.7.15: chatId REQUIRED — each subscriber sees their own values.
 */
function buildFlatText(chatId) {
  if (chatId == null) throw new Error('settingsMenu.buildFlatText: chatId is required');
  const lines = [
    '<b>🎯 Copy Trade Settings</b>',
    '',
    '<i>Tap a row to edit. Bools toggle on a single tap. Numbers/text open a prompt.</i>',
    '<i>🟢 DB · 🟡 env · ⚪ default.</i>',
    '',
  ];

  for (const cat of ['trade', 'filters', 'token', 'time', 'advanced']) {
    const items = byCategory(cat);
    if (items.length === 0) continue;
    const { emoji, label, desc } = CATEGORY_LABELS[cat];
    lines.push(`<b>${emoji} ${label}</b>  <i>— ${desc}</i>`);

    for (const s of items) {
      if (SEEN.has(s.key)) continue;
      const pairKey = PAIR_OF.get(s.key);
      if (pairKey) {
        const pairSetting = getCatalogEntry(pairKey);
        if (pairSetting) {
          // Side-by-side pair. Use a single line in the text (Telegram
          // can't render 2-column text inline — pair is purely a KEYBOARD
          // affordance). We render both values for clarity.
          SEEN.add(s.key);
          SEEN.add(pairKey);
          lines.push(
            `• <b>${s.label}</b>: ${formatValue(s.key, chatId)}  ${formatSource(s.key, chatId)}` +
            `    ·    <b>${pairSetting.label}</b>: ${formatValue(pairKey, chatId)}  ${formatSource(pairKey, chatId)}`
          );
          continue;
        }
      }
      SEEN.add(s.key);
      lines.push(`• <b>${s.label}</b>: ${formatValue(s.key, chatId)}  ${formatSource(s.key, chatId)}`);
    }
    lines.push('');
  }

  SEEN.clear();
  return lines.join('\n');
}

/**
 * Build the keyboard. Pairs are rendered as a 2-column row; standalone
 * settings take a full row. Footer has Back/Refresh/Save.
 *
 * v0.8.8 (experimental) fix: chatId is now REQUIRED because the value
 * suffix in each button needs the per-user setting (v0.8.7.15 isolation).
 * Pre-fix, getBool() and formatValue() were called without chatId, which
 * threw a runtime error and produced no buttons. Now callers MUST pass
 * chatId (e.g. from ctx.chat.id in the Telegram handler).
 */
function buildFlatKeyboard(chatId) {
  if (chatId == null) throw new Error('settingsMenu.buildFlatKeyboard: chatId is required');
  const buttons = [];
  // We iterate the catalog in display order, but pair rows consume 2 keys.
  for (const cat of ['trade', 'filters', 'token', 'time', 'advanced']) {
    const items = byCategory(cat);
    if (items.length === 0) continue;
    for (const s of items) {
      if (SEEN.has(s.key)) continue;
      const pairKey = PAIR_OF.get(s.key);
      if (pairKey) {
        const pairSetting = getCatalogEntry(pairKey);
        if (pairSetting) {
          SEEN.add(s.key);
          SEEN.add(pairKey);
          buttons.push([
            settingButton(s, chatId),
            settingButton(pairSetting, chatId),
          ]);
          continue;
        }
      }
      SEEN.add(s.key);
      buttons.push([settingButton(s, chatId)]);
    }
  }
  // TradeWiz-style footer: ← Back / ↻ Refresh / + Save
  buttons.push([
    Markup.button.callback('« Main', 'menu:main'),
    Markup.button.callback('↻ Refresh', 'cmd:copytrade'),
    Markup.button.callback('+ Save', 'cmd:copytrade'),
  ]);
  SEEN.clear();
  return Markup.inlineKeyboard(buttons);
}

/**
 * Build a single button for a setting. Bool → toggle; number/text → edit.
 * TradeWiz-style: small icon prefix (🟢/🟠 for bool) + label + value suffix.
 *
 * v0.8.8 (experimental) fix: chatId is now REQUIRED. Pre-fix, getBool()
 * and formatValue() were called without chatId, which threw on
 * per-user-isolated settings (v0.8.7.15+).
 */
function settingButton(s, chatId) {
  if (chatId == null) throw new Error('settingsMenu.settingButton: chatId is required');
  if (s.type === 'bool') {
    const icon = getBool(s.key, chatId) ? '🟢' : '🟠';
    return Markup.button.callback(`${icon} ${s.label}`, `set:toggle:${s.key}`);
  }
  return Markup.button.callback(`${s.label} = ${formatValue(s.key, chatId)}`, `set:edit:${s.key}`);
}

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

/**
 * Render the flat Copy Trade settings screen. Replaces the old category
 * sub-menu flow. Edit text in place (no new message per tap).
 * v0.8.7.15: chatId is REQUIRED — the menu shows this user's values.
 */
async function renderFlat(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) throw new Error('settingsMenu.renderFlat: ctx.chat.id is required');
  const text = buildFlatText(chatId);
  const kb = buildFlatKeyboard(chatId);
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
// Callback handlers
// -----------------------------------------------------------------------------

/**
 * Handle `set:toggle:KEY` and `set:edit:KEY` callbacks. Returns true if handled.
 */
export async function handleSetCallback(ctx, action, key) {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.answerCbQuery('No chat context');
    return true;
  }
  const setting = getCatalogEntry(key);
  if (!setting) {
    await ctx.answerCbQuery('Unknown setting');
    return true;
  }

  if (action === 'toggle') {
    if (setting.type !== 'bool') {
      await ctx.answerCbQuery('Not a toggle');
      return true;
    }
    // v0.8.7.15: per-user. Toggle THIS USER's setting only.
    const newVal = toggle(key, chatId);
    await ctx.answerCbQuery(`${setting.label}: ${newVal ? 'ON' : 'OFF'}`);
    await renderFlat(ctx);
    return true;
  }

  if (action === 'edit') {
    // Capture the message_id of the flat settings screen the user is
    // currently looking at, so handlePendingText can edit IT after the
    // user replies with a new value (instead of trying to edit the
    // force-reply prompt, which Telegram rejects with 400).
    const menuMessageId = ctx.callbackQuery?.message?.message_id ?? null;
    setPending(ctx.chat.id, key, menuMessageId);
    const text = [
      `<b>${setting.label}</b>`,
      '',
      `Current: <b>${formatValue(key, chatId)}</b>  ${formatSource(key, chatId)}`,
      `Type: <b>${setting.type}</b>`,
      `Range: ${describeRange(setting)}`,
      '',
      '<i>Send the new value as a reply to this message. Or /cancel to abort.</i>',
    ].join('\n');
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true },
    });
    await ctx.answerCbQuery();
    return true;
  }

  return false;
}

/**
 * Process a text message from a user who is in edit mode. Returns true if
 * the message was consumed (caller should NOT fall through to other handlers).
 */
// v0.8.0: extract re-render logic to a helper, used by both the success path
// and the nullable "set to null" path.
// v0.8.7.15: chatId threaded through to scope the rebuilt menu to one user.
async function rerenderSettingsMenu(ctx, chatId, menuMessageId) {
  const text = buildFlatText(chatId);
  const kb = buildFlatKeyboard(chatId);
  if (menuMessageId) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        menuMessageId,
        undefined,
        text,
        { parse_mode: 'HTML', disable_web_page_preview: true, ...kb }
      );
    } catch (err) {
      if (!String(err.message || '').includes('message is not modified')) {
        await ctx.replyWithHTML(text, kb);
      }
    }
  } else {
    await ctx.replyWithHTML(text, kb);
  }
}

export async function handlePendingText(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  const pending = isPending(chatId);
  if (!pending) return false;

  const text = (ctx.message?.text || '').trim();
  if (!text) return false;

  if (text === '/cancel' || text === 'cancel') {
    clearPending(chatId);
    await ctx.reply('❌ Cancelled.');
    return true;
  }

  const setting = getCatalogEntry(pending.key);
  if (!setting) {
    clearPending(chatId);
    return false;
  }

  const parsed = setting.parseUserInput(text);
  if (parsed === null || parsed === undefined) {
    // v0.8.0: nullable settings (filters, limits) accept null as "disabled".
    // The parser returns null when user types '0', 'none', 'off', or empty.
    if (setting.nullable) {
      try {
        // v0.8.7.15: per-user. set() with THIS USER's chatId.
        set(pending.key, null, chatId);
        clearPending(chatId);
        await ctx.reply(
          `✅ <b>${setting.label}</b> set to <b>Not Limited</b>  ${formatSource(pending.key, chatId)}`,
          { parse_mode: 'HTML' }
        );
        return await rerenderSettingsMenu(ctx, chatId, pending.menuMessageId);
      } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'HTML' });
        return true;
      }
    }
    await ctx.reply(
      `❌ <b>Invalid value.</b>\n\nRange: ${describeRange(setting)}\n\nTry again, or /cancel.`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  try {
    set(pending.key, parsed, chatId);
    clearPending(chatId);
    await ctx.reply(
      `✅ <b>${setting.label}</b> set to <b>${formatValue(pending.key, chatId)}</b>  ${formatSource(pending.key, chatId)}`,
      { parse_mode: 'HTML' }
    );
    return await rerenderSettingsMenu(ctx, chatId, pending.menuMessageId);
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
    return true;
  }
}

export {
  buildFlatText, buildFlatKeyboard, renderFlat,
  isPending, clearPending,
};
