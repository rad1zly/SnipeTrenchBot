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
  AUTO_SELL_LAYOUT, isAutoSellSetting, parseStored, serialise, summarise,
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
  ['sell_priority_fee_sol'],
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

// v0.8.8 (experimental) M3.9: which mode the current flat menu is in.
// 'both' (default) shows every setting; 'mirror' hides reverse-only
// settings; 'reverse' hides mirror-only settings. Set by renderFlat()
// before calling buildFlatText/buildFlatKeyboard, read by them.
let activeMode = 'both';
function setActiveMode(mode) { activeMode = mode || 'both'; }
function getActiveMode() { return activeMode; }

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
    const unit = setting.unit ? ` ${setting.unit}` : '';
    // M1.18: inputMax is for UI display only (e.g. slippage_bps is stored as
    // bps internally but the user enters a percent 1-100). Falls back to max.
    const effMax = setting.inputMax != null ? setting.inputMax : setting.max;
    if (setting.min != null) s += `≥ <code>${setting.min}${unit}</code>`;
    if (setting.min != null && (effMax == null || effMax === Infinity)) s += ', ';
    if (effMax == null || effMax === Infinity) {
      s += 'no upper bound';
    } else {
      s += `, ≤ <code>${effMax}${unit}</code>`;
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
  const mode = getActiveMode();
  // v0.8.8 (experimental) M3.9: header + sub-title differ per mode.
  const header = mode === 'mirror'
    ? '<b>🪞 Copy Trade Settings</b>  <i>— mirror the target wallet</i>'
    : mode === 'reverse'
    ? '<b>🔁 Reverse Copy Settings</b>  <i>— counter-trade the target wallet</i>'
    : '<b>🎯 Copy Trade Settings</b>';
  const lines = [
    header,
    '',
    '<i>Tap a row to edit. Bools toggle on a single tap. Numbers/text open a prompt.</i>',
    '',
  ];

  for (const cat of ['trade', 'filters', 'token', 'time', 'advanced']) {
    const items = byCategory(cat, mode);
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
            `• <b>${s.label}</b>: ${formatValue(s.key, chatId)}` +
            `    ·    <b>${pairSetting.label}</b>: ${formatValue(pairKey, chatId)}`
          );
          continue;
        }
      }
      SEEN.add(s.key);
      lines.push(`• <b>${s.label}</b>: ${formatValue(s.key, chatId)}`);
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
  const mode = getActiveMode();
  const buttons = [];
  // We iterate the catalog in display order, but pair rows consume 2 keys.
  for (const cat of ['trade', 'filters', 'token', 'time', 'advanced']) {
    const items = byCategory(cat, mode);
    if (items.length === 0) continue;
    for (const s of items) {
      if (SEEN.has(s.key)) continue;
      const pairKey = PAIR_OF.get(s.key);
      if (pairKey) {
        const pairSetting = getCatalogEntry(pairKey);
        // M1.20: skip pairing if the partner is hidden (e.g. Jito tip is
        // now admin config; the per-user setting is hidden but the pairing
        // entry is still in PAIR_OF for back-compat).
        if (pairSetting && !pairSetting.hidden) {
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
async function renderFlat(ctx, mode) {
  // v0.8.8 (experimental) M3.9: optional `mode` param ('mirror' or
  // 'reverse') selects which subset of settings to show. The
  // single-menu (no mode) variant is kept for back-compat and shows
  // all settings (mode='both').
  setActiveMode(mode || 'both');
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
    // v0.8.8 (experimental) M3.9: re-render in the SAME mode we entered
    // in (mirror or reverse), not the default 'both'. Otherwise toggling
    // a setting from the Copy Trade menu would suddenly show ALL
    // settings including reverse-only ones.
    await renderFlat(ctx, getActiveMode());
    return true;
  }

  if (action === 'edit') {
    // v0.8.8 (experimental) M1.14: ONE-CLICK direct prompt for auto-sell.
    // User feedback: 'harus nya SL TP tu ku klik langsung minta SL sm TP nya
    // berapa' — tap row TP/SL Plan should go STRAIGHT to a prompt that asks
    // for TP 1 / TP 2 / TP 3 / SL all at once, NOT through a submenu.
    if (isAutoSellSetting(key)) {
      await renderAutoSellQuickPrompt(ctx, key, chatId);
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
// v0.8.8 (experimental) M3.9: activeMode is module-level (set by
// renderFlat); both buildFlatText and buildFlatKeyboard read it. So
// after a set:edit round-trip, the user lands back in the same mode
// they were in (mirror or reverse) — no mode argument needed here.
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
  if (pending.key.startsWith('__autosell_quick:')) {
    // v0.8.8 (experimental) M1.14: one-click quick prompt for auto-sell.
    const key = pending.key.slice('__autosell_quick:'.length);
    const stored = parseStored(get(key, chatId));
    const r = applyAutoSellQuick(key, text, stored);
    if (!r.ok) {
      await ctx.reply(`❌ ${r.msg}\n\nReply again, atau /cancel.`, { parse_mode: 'HTML' });
      return true;
    }
    set(key, r.json, chatId);
    clearPending(chatId);
    const summary = summarise(key, parseStored(r.json));
    await ctx.reply(`✅ ${r.msg}\n\nCurrent: <b>${summary}</b>`, { parse_mode: 'HTML' });
    // Re-render the main /settings in place so user sees updated summary.
    await rerenderSettingsMenu(ctx, chatId, pending.menuMessageId);
    return true;
  }

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

// -----------------------------------------------------------------------------
// v0.8.8 (experimental) M1.14: One-click direct prompt (skip submenu)
// -----------------------------------------------------------------------------
// User feedback: 'harus nya SL TP tu ku klik langsung minta SL sm TP nya
// berapa' — they want tap-row → straight to a "send me your values" prompt,
// not tap-row → submenu → tap-+-TP1 → input.
//
// We accept two input formats in the reply:
//   A) CSV 1-line:   "50, 100, 200, -30"
//      Order matches the field list (TP1, TP2, TP3, SL).
//   B) Key=Value:    "tp1=50\ntp2=100\nsl=-30"
//      Missing keys mean "leave unchanged". Empty fields mean "clear tier".
//
// For trailing_stop / dev_sell_trigger / time_sell_plan: similar but each
// setting has its own field set.

async function renderAutoSellQuickPrompt(ctx, key, chatId) {
  const layout = AUTO_SELL_LAYOUT[key];
  if (!layout) {
    await ctx.reply('Unknown auto-sell setting.');
    return;
  }
  const stored = parseStored(get(key, chatId));
  const summary = summarise(key, stored);

  const prompt = buildAutoSellPrompt(key, layout, summary);

  // Set pending so handlePendingText routes to applyAutoSellQuick
  setPending(ctx.chat.id, `__autosell_quick:${key}`, ctx.callbackQuery?.message?.message_id ?? null);

  await ctx.reply(prompt, {
    parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true },
  });
}

/**
 * Build a setting-specific prompt. Each auto-sell setting has its own
 * field set + semantics, so we render different instructions for each.
 * Goal: the user never sees the same generic "CSV..." template repeated
 * for every setting — Trailing Stop should look like Trailing Stop,
 * Time-based exit should look like Time-based exit, etc.
 */
function buildAutoSellPrompt(key, layout, summary) {
  const header = `<b>${layout.label}</b>\n\nCurrent: <b>${summary}</b>`;

  if (key === 'trailing_stop') {
    return [
      header,
      '',
      'Trailing Stop: jual <b>semua</b> position saat harga turun Trail% dari peak.',
      'Trailing mulai aktif setelah harga naik Activate% dari entry.',
      '',
      '<b>Activate % (wajib positif)</b>  — kapan trailing mulai aktif.',
      'Misal <code>20</code> = trailing start setelah harga +20% dari harga beli.',
      '',
      '<b>Trail % (wajib negatif)</b>  — berapa % drop dari peak yang trigger jual.',
      'Misal <code>-10</code> = jual saat harga turun 10% dari harga tertinggi.',
      '',
      'Format: <code>20, -10</code>',
      'Contoh:',
      '<code>20, -10</code>  → aktif di +20%, jual saat turun 10% dari peak',
      '<code>50, -20</code>  → aktif di +50%, jual saat turun 20% dari peak (lebih longgar)',
      '',
      '<b>Key=value (kalau mau set satu-satu):</b>',
      '<code>act=20</code>  → set Activate % saja',
      '<code>trail=-10</code>  → set Trail % saja',
      '<code>act=0 trail=0</code>  → disable trailing stop',
      '',
      '<i>Sell = 100% (jual semua). Default sell % tidak bisa diubah untuk trailing.</i>',
    ].join('\n');
  }

  if (key === 'time_sell_plan') {
    return [
      header,
      '',
      'Time-based exit: jual sebagian position setelah N detik dari entry.',
      'Bisa sampai 3 tier waktu (T1, T2, T3). Makin banyak tier = exit lebih halus.',
      '',
      'Format: jual pada T1 detik, T2 detik, T3 detik (comma-separated).',
      'Contoh:',
      '<code>30</code>  → jual 100% setelah 30 detik',
      '<code>30, 60</code>  → jual 50% pada 30s, 50% pada 60s',
      '<code>30, 60, 120</code>  → jual di 30s, 60s, 120s',
      '',
      '<b>Key=value (per tier):</b>',
      '<code>t1=30</code>  → set T1 = 30 detik',
      '<code>t1=30 t1_sell=50 t2=60</code>  → T1 di 30s sell 50%, T2 di 60s sell 100%',
      '',
      '<i>Skip key = tier tidak diubah. Hapus tier: tulis key=0 atau hapus baris.</i>',
    ].join('\n');
  }

  // Default: TP / SL Plan — multi-tier take-profit + stop-loss
  return [
    header,
    '',
    'TP / SL plan: jual position saat harga naik (TP) atau turun (SL).',
    'TP1/TP2/TP3 OPSIONAL — kamu bisa cuma TP1, atau TP1+TP2, atau TP1+TP2+TP3+SL.',
    '',
    '<b>Cara 1 — satu baris (CSV, paling simpel):</b>',
    'Angka POSITIF = TP (urut dari kecil ke besar). SATU angka NEGATIF = SL.',
    '<code>50, -30</code>  → TP1 +50% (sell 100% krn cuma 1 tier), SL -30% (sell 100%)',
    '<code>100, 200, -30</code>  → TP1 +100%, TP2 +200%, SL -30% (semua sell 50%)',
    '<code>50, 100, 200, -30</code>  → TP1/TP2/TP3 +50/+100/+200, SL -30%',
    '',
    '<b>Cara 2 — per baris (key=value, partial):</b>',
    '<code>tp1=50</code>  → set TP1 saja',
    '<code>sl=-30</code>  → set SL saja',
    '<code>tp1=100 tp2=200</code>  → TP1 + TP2 (TP3 & SL gak diubah)',
    '<code>tp3=300 tp1_sell=30</code>  → set TP3 dan sell % TP1',
    '',
    '<i>Sell % default: 100% kalau cuma 1 TP tier, 50% kalau 2+. SL selalu 100%.</i>',
  ].join('\n');
}

/** Field descriptors per setting (for prompt + parser). */
function fieldsForSetting(key) {
  if (key === 'tp_sl_plan') {
    return {
      csvOrder: ['tp1', 'tp2', 'tp3', 'sl'],
      csvOrderLabel: 'TP1, TP2, TP3, SL (SL negatif)',
      exampleCsv: '50, 100, 200, -30',
      exampleKvLines: [
        'tp1=50',
        'tp2=100',
        'tp3=200',
        'sl=-30',
      ],
      note: '<i>Tier yang dikosongkan / di-skip akan dihapus. Sell % default 50 (TP) / 100 (SL).</i>',
    };
  }
  if (key === 'trailing_stop') {
    return {
      csvOrder: ['act', 'trail'],
      csvOrderLabel: 'Activate (+%), Trail (-%)',
      exampleCsv: '50, -20',
      exampleKvLines: [
        'act=50',
        'trail=-20',
      ],
      note: '<i>Sell % default 100 (artinya jual semua saat trigger).</i>',
    };
  }
  if (key === 'dev_sell_trigger') {
    return {
      csvOrder: ['mode', 'sell'],
      csvOrderLabel: 'mode (any/whole), sell %',
      exampleCsv: 'any, 100',
      exampleKvLines: [
        'mode=any',
        'sell=100',
      ],
      note: '<i>mode: "any" (exit on any dev sell) atau "whole" (exit on full dump only).</i>',
    };
  }
  if (key === 'time_sell_plan') {
    return {
      csvOrder: ['t1', 't2', 't3'],
      csvOrderLabel: 'after T1s, T2s, T3s',
      exampleCsv: '30, 60, 120',
      exampleKvLines: [
        't1=30',
        't2=60',
        't3=120',
      ],
      note: '<i>Sell % default 100 per tier.</i>',
    };
  }
  return { csvOrder: [], csvOrderLabel: '', exampleCsv: '', exampleKvLines: [], note: '' };
}

/** Parse user input for the quick prompt. Returns new stored object or {error}. */
export function applyAutoSellQuick(key, inputText, stored) {
  const fields = fieldsForSetting(key);
  const trimmed = (inputText || '').trim();
  if (!trimmed) return { ok: false, msg: 'Empty input.' };

  // Count how many TP slots will be filled after this update.
  // Used to set default sell_pct: 100% kalau cuma 1 tier, 50% kalau multi.
  function countFinalTps(parsed) {
    let n = 0;
    for (let i = 1; i <= 3; i++) {
      const k = `tp${i}`;
      if (k in parsed) {
        const v = String(parsed[k] || '').trim();
        if (v !== '' && v !== '0') n += 1;
      }
    }
    return n;
  }

  let parsed = {};
  const looksLikeKv = trimmed.includes('=');
  if (!looksLikeKv) {
    // CSV: split by comma or whitespace.
    // IMPORTANT: positional CSV requires ALL fields filled (otherwise we
    // can't tell if the user's missing slot is intentional or just absent).
    // The user can omit TPs they don't need by sending FEWER fields than
    // expected ONLY if all tokens are uniquely identifiable — so we use a
    // smarter CSV: trailing SL is always allowed alone, but multiple
    // positional TPs need explicit key=value.
    const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
    if (tokens.length > fields.csvOrder.length) {
      return { ok: false, msg: `Terlalu banyak nilai. Maksimal ${fields.csvOrder.length}: ${fields.csvOrderLabel}` };
    }
    // If user provided fewer tokens than csvOrder.length, that's still
    // OK as long as the missing slots are in the MIDDLE (TP2/TP3).
    // Convention: missing trailing slots = unused.
    // However, ambiguous — so we accept positional CSV only when tokens
    // are all numeric OR the LAST token looks like SL (negative).
    // For mixed cases, recommend key=value.
    const allNumeric = tokens.every((t) => /^[+-]?\d+(\.\d+)?$/.test(t));
    // dev_sell_trigger CSV is [mode_text, sell_pct] so first token can be text.
    const csvAllowsText = key === 'dev_sell_trigger';
    if (!allNumeric && !csvAllowsText) {
      return { ok: false, msg: `Format CSV harus angka semua. Untuk mixed/partial, gunakan key=value.` };
    }
    if (tokens.length === 1 && !csvAllowsText) {
      return { ok: false, msg: `1 nilai saja kurang jelas. Gunakan key=value, misal "sl=-30" atau "tp1=50".` };
    }
    const negatives = tokens.filter((t) => Number(t) < 0);
    const positives = tokens.filter((t) => Number(t) > 0);
    if (negatives.length > 1) {
      return { ok: false, msg: `Lebih dari 1 angka negatif. Gunakan key=value untuk指定 SL/Trail yang mana. Contoh:\ntp1=50\nsl=-30` };
    }
    if (key === 'tp_sl_plan') {
      // Positives become TP1, TP2, TP3 in order. Negative becomes SL.
      positives.forEach((tok, i) => { parsed[`tp${i + 1}`] = tok; });
      if (negatives.length === 1) parsed.sl = negatives[0];
    } else if (key === 'trailing_stop') {
      // First positive = act, negative = trail.
      if (positives.length) parsed.act = positives[0];
      if (negatives.length === 1) parsed.trail = negatives[0];
    } else if (key === 'dev_sell_trigger') {
      // dev_sell: CSV order is mode, sell. So we don't use the negative trick.
      tokens.forEach((tok, i) => { parsed[fields.csvOrder[i]] = tok; });
    } else if (key === 'time_sell_plan') {
      // time_sell: all positives are T1, T2, T3 in order.
      positives.forEach((tok, i) => { parsed[`t${i + 1}`] = tok; });
    } else {
      // Fallback: positional.
      tokens.forEach((tok, i) => { parsed[fields.csvOrder[i]] = tok; });
    }
  } else {
    // KV: split by newline or semicolon
    const lines = trimmed.split(/[\n;]+/);
    for (const line of lines) {
      const m = line.match(/^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) return { ok: false, msg: `Format salah di baris: "${line}". Gunakan key=value.` };
      const k = m[1].toLowerCase();
      const v = m[2];
      // Validate key
      if (!fields.csvOrder.includes(k)) {
        return { ok: false, msg: `Key tidak dikenal: "${k}". Key valid: ${fields.csvOrder.join(', ')}` };
      }
      parsed[k] = v;
    }
  }

  // Apply parsed values to stored
  const obj = { ...stored };
  const errors = [];
  const changes = [];

  if (key === 'tp_sl_plan') {
    obj.tiers = Array.isArray(obj.tiers) ? [...obj.tiers] : [];
    for (let i = 1; i <= 3; i++) {
      const k = `tp${i}`;
      if (!(k in parsed)) continue;
      const v = parsed[k].trim();
      if (v === '' || v === '0') {
        if (obj.tiers[i - 1]) {
          obj.tiers.splice(i - 1, 1);
          changes.push(`TP${i} removed`);
        }
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 100000) {
        errors.push(`TP${i} harus angka positif (contoh: 50). Got: "${v}"`);
        continue;
      }
      // Default sell_pct: 100% kalau ini tier SATU-SATUNYA TP di plan,
      // 50% kalau ada tier lain (biar gak keluar semua di TP1).
      const finalTierCount = countFinalTps(parsed);
      const defaultSell = finalTierCount === 1 ? 100 : 50;
      obj.tiers[i - 1] = { tp_pct: n, sell_pct: obj.tiers[i - 1]?.sell_pct ?? defaultSell };
      changes.push(`TP${i} = +${n}% (sell ${obj.tiers[i - 1].sell_pct}%)`);
    }
    if ('sl' in parsed) {
      const v = String(parsed.sl).trim();
      if (v === '' || v === '0') {
        delete obj.sl_pct;
        delete obj.sl_sell_pct;
        changes.push('SL removed');
      } else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < -100 || n > 0) {
          errors.push(`SL harus angka negatif -100..0 (contoh: -30). Got: "${v}"`);
        } else {
          obj.sl_pct = n;
          obj.sl_sell_pct = obj.sl_sell_pct ?? 100;
          changes.push(`SL = ${n}%`);
        }
      }
    }
  } else if (key === 'trailing_stop') {
    if ('act' in parsed) {
      const v = String(parsed.act).trim();
      if (v === '' || v === '0') { delete obj.act_pct; changes.push('Activate removed'); }
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1) errors.push(`Activate harus positif. Got: "${v}"`);
        else { obj.act_pct = n; changes.push(`Activate = +${n}%`); }
      }
    }
    if ('trail' in parsed) {
      const v = String(parsed.trail).trim();
      if (v === '' || v === '0') { delete obj.trail_pct; changes.push('Trail removed'); }
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n > 0 || n < -100) errors.push(`Trail harus negatif -100..0. Got: "${v}"`);
        else { obj.trail_pct = n; changes.push(`Trail = ${n}%`); }
      }
    }
  } else if (key === 'dev_sell_trigger') {
    if ('mode' in parsed) {
      const v = String(parsed.mode).trim().toLowerCase();
      if (v === '' || v === '0') { delete obj.mode; changes.push('Mode removed'); }
      else if (v === 'any' || v === 'any_amount') { obj.mode = 'any_amount'; changes.push('Mode = any'); }
      else if (v === 'whole' || v === 'whole_amount') { obj.mode = 'whole_amount'; changes.push('Mode = whole'); }
      else errors.push(`Mode harus "any" atau "whole". Got: "${v}"`);
    }
    if ('sell' in parsed) {
      const v = String(parsed.sell).trim();
      if (v === '' || v === '0') { delete obj.sell_pct; changes.push('Sell % removed'); }
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1 || n > 100) errors.push(`Sell % harus 1-100. Got: "${v}"`);
        else { obj.sell_pct = n; changes.push(`Sell = ${n}%`); }
      }
    }
  } else if (key === 'time_sell_plan') {
    obj.tiers = Array.isArray(obj.tiers) ? [...obj.tiers] : [];
    for (let i = 1; i <= 3; i++) {
      const k = `t${i}`;
      if (!(k in parsed)) continue;
      const v = parsed[k].trim();
      if (v === '' || v === '0') {
        if (obj.tiers[i - 1]) { obj.tiers.splice(i - 1, 1); changes.push(`T${i} removed`); }
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 86400) {
        errors.push(`${k} harus detik 1..86400. Got: "${v}"`);
        continue;
      }
      obj.tiers[i - 1] = { after_s: n, sell_pct: obj.tiers[i - 1]?.sell_pct ?? 100 };
      changes.push(`${k} = ${n}s`);
    }
  }

  if (errors.length) return { ok: false, msg: errors.join('\n') };
  const json = serialise(obj);
  return { ok: true, obj, json, msg: changes.length ? changes.join(', ') : 'No changes.' };
}

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
