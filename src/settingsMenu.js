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
import {
  AUTO_SELL_LAYOUT, isAutoSellSetting, parseStored, summarise,
  applyTierChange, isAutoSellSlot,
} from './autoSellPlan.js';

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
    // v0.8.8 (experimental) M1.12: auto-sell settings get a tier-by-tier
    // submenu instead of a raw JSON prompt. The user taps +TP1 / +TP2 /
    // +SL / +Trailing and gets a one-line "send a number" reply.
    if (setting.category === 'auto-sell' || isAutoSellSetting(key)) {
      await renderAutoSellSubmenu(ctx, key, chatId);
      await ctx.answerCbQuery();
      return true;
    }
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

  // v0.8.8 (experimental) M1.12: auto-sell tier-by-tier flow.
  if (pending.key.startsWith('__autosell:')) {
    const r = handleAutoSellPending(pending.key, text, chatId);
    if (!r) {
      clearPending(chatId);
      return false;
    }
    if (!r.ok) {
      // Bad input: keep the pending alive so the user can retry. Show the error.
      await ctx.reply(`❌ ${r.msg}\n\nReply again, or /cancel.`, { parse_mode: 'HTML' });
      return true;
    }
    set(r.key, r.json, chatId);
    clearPending(chatId);
    await ctx.reply(`✅ ${r.msg}\n\nCurrent: <code>${summarise(r.key, parseStored(r.json))}</code>`, { parse_mode: 'HTML' });
    // Re-render the submenu in place so the user sees the new row immediately.
    await renderAutoSellSubmenuEdit(ctx, r.key, chatId, pending.menuMessageId);
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

// -----------------------------------------------------------------------------
// v0.8.8 (experimental) M1.12: Auto-Sell tier-by-tier submenu
// -----------------------------------------------------------------------------
// When user taps a row that is an auto-sell setting, we render a separate
// submenu showing one row per tier (TP 1 / TP 2 / TP 3 / SL) with [+ add]
// buttons for empty slots. Tapping a row pushes it into pending-edit mode
// awaiting a single number. Tapping [×] removes it. Tapping [Disable] wipes
// the whole setting.

/** Render the submenu for an auto-sell setting (tp_sl_plan, trailing_stop, etc.). */
async function renderAutoSellSubmenu(ctx, key, chatId) {
  const layout = AUTO_SELL_LAYOUT[key];
  if (!layout) {
    await ctx.reply('Unknown auto-sell setting.');
    return;
  }
  const stored = parseStored(get(key, chatId));
  const lines = [
    `<b>${layout.label}</b>`,
    layout.header,
    '',
    `Current: <b>${summarise(key, stored)}</b>`,
    '',
  ];
  const buttons = [];
  for (const row of layout.rows) {
    const filled = isSlotFilled(key, row, stored);
    if (filled) {
      const valueLabel = slotValueLabel(key, row, stored);
      lines.push(`  • <b>${row.label}</b>: ${valueLabel}`);
      // Row buttons:
      //   [✏️ edit trigger %]   [💰 sell %]   [×]
      // The first always edits the *trigger* (% for tp/sl/trail/act/mode/after_s).
      // The second edits *sell_pct* for tiers that have one (tp tier, time tier, trailing, dev sell).
      const sellPctEditBtn = canEditSellPct(key, row)
        ? Markup.button.callback(`💰 ${row.kind === 'tier' ? 'sell' : 'sell'} %`, `autosell:add:${key}:${row.id}__sell`)
        : null;
      const row_buttons = [
        Markup.button.callback(`✏️ ${row.label}`, `autosell:add:${key}:${row.id}`),
      ];
      if (sellPctEditBtn) row_buttons.push(sellPctEditBtn);
      row_buttons.push(Markup.button.callback(`×`, `autosell:remove:${key}:${row.id}`));
      buttons.push(row_buttons);
    } else {
      lines.push(`  <i>${row.addLabel} — tap to set</i>`);
      buttons.push([
        Markup.button.callback(row.addLabel, `autosell:add:${key}:${row.id}`),
      ]);
    }
  }
  // Footer: Disable + Back
  buttons.push([Markup.button.callback('❌ Disable this whole setting', `autosell:disable:${key}`)]);
  buttons.push([Markup.button.callback('« Back to /settings', 'cmd:settings')]);

  await ctx.editMessageText(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

function isSlotFilled(key, row, stored) {
  if (key === 'tp_sl_plan') {
    if (row.kind === 'tier') return Array.isArray(stored.tiers) && stored.tiers[row.tierIndex]?.tp_pct != null;
    if (row.kind === 'singleton') return stored[row.field] != null;
  }
  if (key === 'trailing_stop') return stored[row.field] != null;
  if (key === 'dev_sell_trigger') return stored[row.field] != null;
  if (key === 'time_sell_plan') {
    if (row.kind === 'timeTier') return Array.isArray(stored.tiers) && stored.tiers[row.tierIndex]?.after_s != null;
  }
  return false;
}

/** Returns true if this row exposes an editable sell_pct alongside the trigger field. */
function canEditSellPct(key, row) {
  if (key === 'tp_sl_plan') {
    if (row.kind === 'tier') return true;       // TP tiers: tp_pct + sell_pct
    if (row.kind === 'singleton' && row.field === 'sl_pct') return true;  // SL: sl_pct + sl_sell_pct
  }
  if (key === 'trailing_stop') return true;     // act/trail + sell_pct (one shared)
  if (key === 'dev_sell_trigger') {
    return row.field === 'sell_pct';            // only the sell_pct row itself
  }
  if (key === 'time_sell_plan') {
    if (row.kind === 'timeTier') return true;   // after_s + sell_pct
  }
  return false;
}

function slotValueLabel(key, row, stored) {
  if (key === 'tp_sl_plan') {
    if (row.kind === 'tier') {
      const t = stored.tiers?.[row.tierIndex];
      if (!t) return '—';
      const tp = t.tp_pct > 0 ? `+${t.tp_pct}%` : `${t.tp_pct}%`;
      return `${tp} (sell ${t.sell_pct ?? 50}%)`;
    }
    if (row.field === 'sl_pct') {
      return `${stored.sl_pct}% (sell ${stored.sl_sell_pct ?? 100}%)`;
    }
  }
  if (key === 'trailing_stop') {
    const v = stored[row.field];
    if (v == null) return '—';
    if (row.field === 'act_pct') return `+${v}%`;
    if (row.field === 'trail_pct') return `${v}%`;
    return `${v}%`;
  }
  if (key === 'dev_sell_trigger') {
    if (row.field === 'mode') return stored.mode ?? '—';
    if (row.field === 'sell_pct') return `${stored.sell_pct ?? 100}%`;
  }
  if (key === 'time_sell_plan') {
    const t = stored.tiers?.[row.tierIndex];
    if (!t) return '—';
    return `${t.after_s}s (sell ${t.sell_pct ?? 100}%)`;
  }
  return '—';
}

/** Handle autosell:add:KEY:SLOT  → push user into pending-edit for that slot. */
export async function handleAutoSellAdd(ctx, key, slot) {
  const chatId = ctx.chat?.id;
  if (chatId == null) { await ctx.answerCbQuery('No chat context'); return true; }
  const layout = AUTO_SELL_LAYOUT[key];
  if (!layout) { await ctx.answerCbQuery('Unknown setting'); return true; }
  const row = layout.rows.find((r) => r.id === slot);
  if (!row) { await ctx.answerCbQuery('Unknown slot'); return true; }

  // The callback data encodes whether we're editing the trigger field or the
  // sell_pct. Suffix "__sell" → edit sell_pct; otherwise → edit trigger.
  const editingSellPct = slot.endsWith('__sell');
  const baseSlot = editingSellPct ? slot.slice(0, -'__sell'.length) : slot;
  const baseRow = layout.rows.find((r) => r.id === baseSlot) || row;
  // v0.8.8 (experimental): route through the existing pending-edit flow.
  // Pending key encodes (key, slot, field) so handlePendingText knows what to mutate.
  setPending(
    ctx.chat.id,
    `__autosell:${key}:${baseSlot}:${editingSellPct ? 'sell' : 'trigger'}`,
    ctx.callbackQuery?.message?.message_id ?? null
  );
  const prompt = buildSlotPrompt(key, baseRow, editingSellPct);
  await ctx.reply(prompt, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true },
  });
  await ctx.answerCbQuery();
  return true;
}

/** Handle autosell:remove:KEY:SLOT  → remove that slot, save, refresh submenu. */
export async function handleAutoSellRemove(ctx, key, slot) {
  const chatId = ctx.chat?.id;
  if (chatId == null) { await ctx.answerCbQuery('No chat context'); return true; }
  const stored = parseStored(get(key, chatId));
  const r = applyTierChange(key, slot, 'remove', '', stored);
  if (!r.ok) { await ctx.answerCbQuery(r.msg); return true; }
  set(key, r.json, chatId);
  await ctx.answerCbQuery('Removed');
  // Re-render the submenu on the SAME message that has the buttons.
  await renderAutoSellSubmenuEdit(ctx, key, chatId, ctx.callbackQuery?.message?.message_id ?? null);
  return true;
}

/** Handle autosell:disable:KEY  → wipe the setting. */
export async function handleAutoSellDisable(ctx, key) {
  const chatId = ctx.chat?.id;
  if (chatId == null) { await ctx.answerCbQuery('No chat context'); return true; }
  set(key, null, chatId);
  await ctx.answerCbQuery('Disabled');
  await ctx.reply(`✅ <b>${AUTO_SELL_LAYOUT[key]?.label || key}</b> cleared.`, { parse_mode: 'HTML' });
  return true;
}

async function renderAutoSellSubmenuEdit(ctx, key, chatId, menuMessageId) {
  const layout = AUTO_SELL_LAYOUT[key];
  if (!layout) return;
  const stored = parseStored(get(key, chatId));
  const lines = [
    `<b>${layout.label}</b>`,
    layout.header,
    '',
    `Current: <b>${summarise(key, stored)}</b>`,
    '',
  ];
  const buttons = [];
  for (const row of layout.rows) {
    const filled = isSlotFilled(key, row, stored);
    if (filled) {
      const valueLabel = slotValueLabel(key, row, stored);
      lines.push(`  • <b>${row.label}</b>: ${valueLabel}`);
      const sellPctEditBtn = canEditSellPct(key, row)
        ? Markup.button.callback(`💰 sell %`, `autosell:add:${key}:${row.id}__sell`)
        : null;
      const row_buttons = [
        Markup.button.callback(`✏️ ${row.label}`, `autosell:add:${key}:${row.id}`),
      ];
      if (sellPctEditBtn) row_buttons.push(sellPctEditBtn);
      row_buttons.push(Markup.button.callback(`×`, `autosell:remove:${key}:${row.id}`));
      buttons.push(row_buttons);
    } else {
      lines.push(`  <i>${row.addLabel} — tap to set</i>`);
      buttons.push([Markup.button.callback(row.addLabel, `autosell:add:${key}:${row.id}`)]);
    }
  }
  buttons.push([Markup.button.callback('❌ Disable this whole setting', `autosell:disable:${key}`)]);
  buttons.push([Markup.button.callback('« Back to /settings', 'cmd:settings')]);
  if (menuMessageId) {
    try {
      await ctx.telegram.editMessageText(chatId, menuMessageId, undefined, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
    } catch (err) {
      if (!String(err.message || '').includes('message is not modified')) throw err;
    }
  }
}

function buildSlotPrompt(key, row, editingSellPct = false) {
  // When editingSellPct=true, we want the prompt to ask for the sell percentage
  // for this tier/singleton, NOT the trigger %.
  if (editingSellPct) {
    if (key === 'tp_sl_plan' && row.kind === 'tier') {
      return [
        `<b>${row.label} — jual berapa % posisi saat trigger?</b>`,
        '',
        'Kirim ANGKA 1-100 (misal: 30 = jual 30% dari posisi kamu saat TP tercapai).',
        'Range: 1-100. /cancel untuk batal.',
      ].join('\n');
    }
    if (key === 'tp_sl_plan' && row.field === 'sl_pct') {
      return [
        '<b>SL — jual berapa % posisi saat SL triggered?</b>',
        '',
        'Kirim ANGKA 1-100 (default 100 = jual semua). /cancel untuk batal.',
      ].join('\n');
    }
    if (key === 'trailing_stop') {
      return [
        '<b>Trailing Stop — jual berapa % posisi saat trigger?</b>',
        '',
        'Kirim ANGKA 1-100 (default 100 = jual semua). /cancel untuk batal.',
      ].join('\n');
    }
    if (key === 'time_sell_plan' && row.kind === 'timeTier') {
      return [
        `<b>${row.label} — jual berapa % posisi setelah ${row.label}?</b>`,
        '',
        'Kirim ANGKA 1-100. /cancel untuk batal.',
      ].join('\n');
    }
  }
  if (key === 'tp_sl_plan') {
    if (row.kind === 'tier') {
      return [
        `<b>${row.label} — berapa % profit target?</b>`,
        '',
        'Kirim ANGKA POSITIF (misal: 50 untuk +50%, 100 untuk +100%).',
        'Sell % default 50% (artinya jual setengah posisi saat target tercapai).',
        'Atau /cancel untuk batal.',
      ].join('\n');
    }
    if (row.field === 'sl_pct') {
      return [
        '<b>SL — berapa % loss maksimal?</b>',
        '',
        'Kirim ANGKA NEGATIF (misal: -30 artinya jual semua jika harga turun 30% dari harga beli).',
        'Range: -100 s/d 0.',
        'Atau /cancel untuk batal.',
      ].join('\n');
    }
  }
  if (key === 'trailing_stop') {
    if (row.field === 'act_pct') {
      return '<b>Activate — pada +berapa % trailing mulai aktif?</b>\n\nKirim angka positif (misal: 50).';
    }
    if (row.field === 'trail_pct') {
      return '<b>Trail — berapa % drop dari peak yang jadi trigger jual?</b>\n\nKirim angka NEGATIF (misal: -20 artinya jual jika harga turun 20% dari puncak).';
    }
  }
  if (key === 'dev_sell_trigger') {
    if (row.field === 'mode') return '<b>Mode — kirim "any" atau "whole".</b>\n\nany = exit on any dev sell.\nwhole = exit only on full dump.';
    if (row.field === 'sell_pct') return '<b>Sell % — berapa % posisi kamu yang dijual saat dev sell?</b>\n\nKirim 1-100.';
  }
  if (key === 'time_sell_plan') {
    return '<b>After berapa DETIK posisi akan dijual?</b>\n\nKirim angka detik (misal: 60). Sell % default 100%.';
  }
  return `<b>${row.label}</b> — kirim nilai baru.`;
}

/** Hook into handlePendingText: if pending.key starts with __autosell:, parse via applyTierChange. */
export function handleAutoSellPending(pendingKey, inputText, chatId) {
  // pending.key format options:
  //   '__autosell:KEY:SLOT'         — edit the trigger field (legacy)
  //   '__autosell:KEY:SLOT:trigger' — edit trigger field
  //   '__autosell:KEY:SLOT:sell'    — edit sell_pct only
  const m = pendingKey.match(/^__autosell:([^:]+):([^:]+)(?::(trigger|sell))?$/);
  if (!m) return null;
  const key = m[1];
  const slot = m[2];
  const field = m[3] || 'trigger';   // default to trigger edit
  const action = field === 'sell' ? 'edit_sell' : 'add';
  const stored = parseStored(get(key, chatId));
  const r = applyTierChange(key, slot, action, inputText, stored);
  if (!r.ok) return { ok: false, msg: r.msg };
  return { ok: true, key, json: r.json, msg: r.msg };
}
