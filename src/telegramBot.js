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
  { command: 'positions',   description: 'List open positions' },
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
import { walletsDb, positionsDb, subscribersDb, settingsDb } from './db.js';
import { pause, resume, isPaused, snapshot as safetySnapshot } from './safety.js';
import { status as executorStatus } from './executor.js';
import notifier from './notifier.js';
import * as sm from './settingsMenu.js';
import * as wm from './walletMenu.js';
import { walletManager } from './walletManager.js';

let bot = null;
let onPause = null; // callback set by index.js so we can stop the monitor if needed
let onResume = null;

function shortAddr(a) {
  if (!a) return '?';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
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

function buildMainText(chatId) {
  const e = executorStatus();
  const s = safetySnapshot();
  const w = walletManager.getStatus();
  // v0.6.1: per-user counts. Total copies & wallets are scoped to the
  // calling user; subscriber count stays global (system-level stat).
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
  const myCopies  = chatId != null ? walletsDb.totalCopies(chatId) : 0;
  const lines = [
    '<b>🤖 SnipeTrenchBot</b>',
    '',
    `Mode:      ${config.DRY_RUN ? '<b>DRY_RUN</b>' : '<b>⚠️ LIVE</b>'}`,
    `Wallet:    ${w.set ? `<code>${shortAddr(w.address)}</code> (...${w.last4})` : '<i>not set</i>'}`,
    `Wallets: ${myWallets}  |  Copies: ${myCopies}  |  Positions: ${s.openPositionCount}  |  Subs: ${subscribersDb.count()}`,
  ];
  if (isPaused()) lines.push('', '⏸ <b>PAUSED</b>');
  if (!w.set) lines.push('', '⚠️ <b>No trading wallet</b> — tap 🔑 Wallet to set one.');
  lines.push('', 'Tap a button below.');
  return lines.join('\n');
}

function mainMenu(chatId) {
  const running = !isPaused();
  // v0.6.1: button label uses the calling user's wallet count, not the
  // global table size. Falls back to 0 when chatId is unknown (e.g. legacy
  // callers).
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
  // TradeWiz-style: big prominent start/stop button on top, then 2-col grid.
  // 🎯 Copy Trade replaces the old "⚙️ Settings" — it now opens the flat
  // single-screen settings menu (TradeWiz parity). 🔑 Wallet stays prominent
  return Markup.inlineKeyboard([
    [Markup.button.callback(running ? '⏸ Pause Trading' : '▶️ Resume Trading', 'cmd:toggle_pause')],
    [Markup.button.callback('🎯 Copy Trade', 'menu:copytrade')],
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
      Markup.button.callback('❓ Help',      'cmd:help'),
    ],
  ]);
}

// Inline keyboard for the Wallets screen. Tap "➕ Add Wallet" → bot enters
// pending-add mode (waits for next text message = wallet address).
const walletsMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback('➕ Add Wallet', 'cmd:wallet_add')],
  [Markup.button.callback('« Back to Main', 'menu:main')],
]);

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
  const s = safetySnapshot();
  const e = executorStatus();
  // v0.6.1: "Watched" is the calling user's wallet count.
  const myWallets = chatId != null ? walletsDb.count(chatId) : 0;
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
    '<b>Bot wallet</b>',
    `Address:        <code>${e.botWallet}</code>`,
    `RPC:            ${e.rpc}`,
    `Jupiter:        ${e.jupiterUrl}`,
    '',
    '<b>Safety</b>',
    `Max SOL/trade:  ${s.maxSolPerTrade}`,
    `Slippage:       ${s.slippageBps} bps`,
    `Hold:           ${s.holdMs} ms`,
    `Daily loss cap: ${s.dailyLossCapSol} SOL`,
  ].join('\n');
}

function buildWalletsText(chatId) {
  // v0.6.1: per-user list. Users can only see their own wallets.
  const list = walletsDb.list(chatId);
  if (list.length === 0) {
    return '💼 <b>Wallets</b>\n\nEmpty. Tap <b>➕ Add Wallet</b> below, or send <code>/addwallet &lt;address&gt; [label]</code>.';
  }
  const totalCopies = walletsDb.totalCopies(chatId);
  const lines = list.map((w) => {
    const lastCopy = w.last_copy_at > 0
      ? `\n  copies: <b>${w.copy_count}</b> · last: ${new Date(w.last_copy_at).toISOString().slice(0, 16).replace('T', ' ')}Z`
      : `\n  copies: <b>${w.copy_count}</b>`;
    return `• <code>${w.address}</code>${w.label ? ` — ${w.label}` : ''}\n  added ${new Date(w.added_at).toISOString().slice(0, 10)}` + lastCopy;
  });
  return (
    `💼 <b>Wallets (${list.length}):</b>\n` +
    `<i>Total copies: <b>${totalCopies}</b></i>\n\n` +
    `${lines.join('\n')}\n\n` +
    `<i>Tap <b>➕ Add Wallet</b> to add, or /removewallet &lt;address&gt; to remove.</i>`
  );
}

function buildPositionsText() {
  const open = positionsDb.openAll();
  if (open.length === 0) return '💼 <b>Open positions</b>\n\nNone right now.';
  const lines = open.map(
    (p) =>
      `• <code>${p.mint}</code>\n  dev: ${shortAddr(p.dev_wallet)} | spent ${p.entry_sol} SOL | opened ${new Date(p.entry_time).toISOString().slice(11, 19)}Z`
  );
  return `<b>💼 Open positions (${open.length}):</b>\n\n${lines.join('\n')}`;
}

function buildSafetyText() {
  const s = safetySnapshot();
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

export function startTelegramBot({ onPause: pauseCb, onResume: resumeCb } = {}) {
  onPause = pauseCb;
  onResume = resumeCb;
  if (!config.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is empty — cannot start bot');
  }
  bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
  bot.use(subscribeMiddleware);

  // Pending "add wallet" state: chatId → { startedAt }
  // (User tapped "➕ Add Wallet" and the bot is waiting for a text reply.)
  const pendingAddWallet = new Map();
  const ADD_WALLET_TTL_MS = 5 * 60 * 1000; // 5 min

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
  bot.start((ctx) => {
    // subscribeMiddleware already added sender to subscribers table.
    // Show the main menu inline.
    ctx.replyWithHTML(buildMainText(ctx.chat.id), mainMenu(ctx.chat.id));
  });

  // ---- /menu (shortcut: re-show the main menu) ----
  bot.command('menu', (ctx) => {
    ctx.replyWithHTML(buildMainText(ctx.chat.id), mainMenu(ctx.chat.id));
  });

  // ---- callback_query handler (inline button taps) ----
  // Routes `menu:*` (navigate) and `cmd:*` (run command) callbacks to the
  // right screen. Edits the message in place so the chat doesn't fill up
  // with one new message per tap.
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    try {
      if (data === 'menu:main') {
        await renderScreen(ctx, buildMainText(ctx.chat.id), mainMenu(ctx.chat.id));
      } else if (data === 'cmd:copytrade' || data === 'menu:settings') {
        // Flat single-screen Copy Trade settings menu (v0.5.2+).
        // `menu:settings` is kept as an alias for backwards-compat with
        // any old messages that still have a Settings button.
        await sm.renderFlat(ctx);
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
          await sm.renderFlat(ctx);
        }
      } else if (data.startsWith('set:')) {
        // set:toggle:KEY  or  set:edit:KEY
        const parts = data.split(':');
        const action = parts[1];
        const key = parts.slice(2).join(':');
        await sm.handleSetCallback(ctx, action, key);
      } else if (data === 'cmd:status') {
        await renderScreen(ctx, buildStatusText(ctx.chat.id), commandBackMenu());
      } else if (data === 'cmd:wallets' || data === 'cmd:watchlist') {
        await renderScreen(ctx, buildWalletsText(ctx.chat.id), walletsMenu());
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
        await renderScreen(ctx, buildPositionsText(), commandBackMenu());
      } else if (data === 'cmd:safety') {
        await renderScreen(ctx, buildSafetyText(), commandBackMenu());
      } else if (data === 'cmd:help') {
        await renderScreen(ctx, buildHelpText(), commandBackMenu());
      } else if (data === 'cmd:toggle_pause') {
        if (isPaused()) {
          resume();
          onResume?.();
        } else {
          pause();
          onPause?.();
        }
        await renderScreen(ctx, buildMainText(ctx.chat.id), mainMenu(ctx.chat.id));
      } else if (data === 'menu:wallet') {
        // Bot's own trading wallet (encrypted). Set / Replace / Remove.
        await wm.renderWalletMenu(ctx);
      } else if (data === 'cmd:set_wallet') {
        // Enter pending-set mode. Next text message in this DM is consumed
        // as the private key (see handlePendingWalletText).
        await wm.promptSetWallet(ctx);
      } else if (data === 'cmd:remove_wallet') {
        // Show confirm dialog (don't delete yet).
        await wm.confirmRemoveWallet(ctx);
      } else if (data === 'cmd:do_remove_wallet') {
        // User confirmed. Wipe from DB.
        await wm.doRemoveWallet(ctx);
      } else {
        // Unknown callback — likely stale from an old message. Just refresh.
        await renderScreen(ctx, buildMainText(ctx.chat.id), mainMenu(ctx.chat.id));
      }
      await ctx.answerCbQuery();
    } catch (err) {
      console.error('[telegramBot] callback error:', err.message || err);
      await ctx.answerCbQuery('Error').catch(() => {});
    }
  });

  // ---- /stop (unsubscribe) ----
  bot.command('stop', (ctx) => {
    if (ctx.chat?.id == null) return;
    const removed = subscribersDb.remove(ctx.chat.id);
    if (removed) {
      ctx.reply('🔕 Unsubscribed. You will no longer receive broadcast notifications.\n\nSend /start again to re-subscribe.');
    } else {
      ctx.reply("You weren't subscribed.");
    }
  });

  // ---- /help ----
  bot.help((ctx) => {
    ctx.reply(
      [
        '<b>Commands:</b>',
        '/menu — show main menu (button UI)',
        '/settings — TradeWiz-style settings (Trade / Filters / Token / Time / Advanced)',
        '/wallets — show tracked wallets',
        '/addwallet <code>&lt;address&gt;</code> [label] — add a watched wallet',
        '/removewallet <code>&lt;address&gt;</code> — remove a watched wallet',
        '/wallet — set / replace / remove the bot\'s trading key (encrypted at rest)',
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
        '3. When a sell is detected, buy via Jupiter (using the bot wallet)',
        `4. Hold ${config.HOLD_MS}ms, then sell`,
        '5. Log PnL and notify <i>you</i> (the wallet owner)',
        '',
        '<b>Multi-user:</b> anyone can /start. Watchlists and trade alerts are private — you only see your own wallets, and only you get notified about your trades. /stop to unsubscribe.',
        '<b>Security:</b> /wallet stores the bot key AES-256-GCM encrypted and auto-deletes the key message.',
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
  bot.command('addwallet', (ctx) => {
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
  bot.command('removewallet', (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const addr = parts[1];
    if (!addr) return ctx.reply('Usage: /removewallet <address>');
    // v0.6.1: only remove if this user owns it.
    const removed = walletsDb.remove({ chatId: ctx.chat.id, address: addr });
    if (removed) ctx.reply(`🗑️ Removed <code>${addr}</code>.`, { parse_mode: 'HTML' });
    else ctx.reply(`<code>${addr}</code> was not in your watchlist.`, { parse_mode: 'HTML' });
  });

  // ---- /listwallets (legacy alias) ----
  bot.command('listwallets', (ctx) => {
    ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu());
  });

  // ---- /wallets (alias for the menu screen) ----
  bot.command('wallets', (ctx) => {
    ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu());
  });

  // ---- /wallet (bot's own trading key — set / replace / remove) ----
  bot.command('wallet', (ctx) => {
    // Send as a new message (not edit). /wallet is a fresh command, not a
    // tap on an existing button.
    ctx.replyWithHTML(wm.buildWalletText(), wm.walletMenu());
  });

  // ---- /copytrade (alias: /settings) — flat single-screen settings menu ----
  bot.command(['copytrade', 'settings'], async (ctx) => {
    // Send as a new message (not edit). /copytrade is a fresh command.
    try {
      await ctx.replyWithHTML(sm.buildFlatText(), sm.buildFlatKeyboard());
    } catch (e) {
      // Fallback if the text is empty for any reason
      await ctx.reply('❌ Could not render settings menu. Try /menu → 🎯 Copy Trade.');
    }
  });

  // ---- /pause ----
  bot.command('pause', (ctx) => {
    pause();
    onPause?.();
    ctx.reply('⏸  Trading paused. New signals will be logged but not traded.');
  });

  // ---- /resume ----
  bot.command('resume', (ctx) => {
    resume();
    onResume?.();
    ctx.reply('▶️  Trading resumed.');
  });

  // ---- /status ----
  bot.command('status', (ctx) => {
    const s = safetySnapshot();
    const e = executorStatus();
    const lines = [
      '<b>Status</b>',
      `Mode:           ${s.mode}`,
      `Manual pause:   ${s.manualPaused ? 'yes' : 'no'}`,
      `Watched:        ${walletsDb.count()} wallet(s)`,
      `Subscribers:    ${subscribersDb.count()}`,
      `Open positions: ${s.openPositionCount}`,
      `Closed today:   ${s.closedTodayCount} (PnL ${s.pnlTodaySol.toFixed(4)} SOL)`,
      '',
      '<b>Bot wallet</b>',
      `Address:        <code>${e.botWallet}</code>`,
      `RPC:            ${e.rpc}`,
      `Jupiter:        ${e.jupiterUrl}`,
      '',
      '<b>Safety</b>',
      `Max SOL/trade:  ${s.maxSolPerTrade}`,
      `Slippage:       ${s.slippageBps} bps`,
      `Hold:           ${s.holdMs} ms`,
      `Daily loss cap: ${s.dailyLossCapSol} SOL`,
    ];
    ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // ---- /positions ----
  bot.command('positions', (ctx) => {
    const open = positionsDb.openAll();
    if (open.length === 0) return ctx.reply('No open positions.');
    const lines = open.map(
      (p) =>
        `• <code>${p.mint}</code>\n  dev: ${shortAddr(p.dev_wallet)} | spent ${p.entry_sol} SOL | opened ${new Date(p.entry_time).toISOString().slice(11, 19)}Z`
    );
    ctx.reply(`<b>Open positions (${open.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // ---- /recent ----
  bot.command('recent', (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const n = Math.max(1, Math.min(50, parseInt(parts[1], 10) || 10));
    const list = positionsDb.recent(n);
    if (list.length === 0) return ctx.reply('No closed positions yet.');
    const lines = list.map((p) => {
      const pnlStr = p.pnl_sol != null ? `${p.pnl_sol >= 0 ? '+' : ''}${p.pnl_sol.toFixed(4)} SOL` : '—';
      const status = p.status === 'CLOSED' ? '✅' : p.status === 'FAILED' ? '❌' : '⏳';
      return `${status} <code>${p.mint}</code>\n  ${pnlStr}  (${new Date(p.entry_time).toISOString().slice(11, 19)}Z)`;
    });
    ctx.reply(`<b>Recent (${list.length}):</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // ---- /safety ----
  bot.command('safety', (ctx) => {
    const s = safetySnapshot();
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
  bot.on('text', async (ctx) => {
    // Order matters here. First the settings edit flow, then "add wallet"
    // (watched wallet address), then "set trading wallet" (private key).
    // Each handler is gated by its own pending-map and returns true to
    // signal the message was consumed.
    if (await sm.handlePendingText(ctx)) return;
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
        await ctx.replyWithHTML(buildWalletsText(ctx.chat.id), walletsMenu());
      } catch (e) { /* ignore — message was best-effort */ }
      return;
    }

    if (ctx.message.text.startsWith('/')) {
      ctx.reply('Unknown command. Try /help.');
    }
  });

  // ---- error handler ----
  bot.catch((err) => {
    console.error('[telegramBot] error:', err);
  });

  // 409-retry wrapper: Telegraf's polling throws on "Conflict: terminated by
  // other getUpdates request" if a stale long-poll is still held (typical
  // after a hard crash of a previous instance, OR concurrent CLI getUpdates
  // calls from a developer). Telegram holds the slot for up to ~5 min. We
  // catch the 409, wait progressively longer, and re-launch.
  const launchWith409Retry = async (attempt = 1) => {
    try {
      await bot.launch({ dropPendingUpdates: false });
      notifier.attachBot(bot);

      // Register the command list so when a user types "/" in the chat,
      // Telegram shows the autocomplete list with descriptions.
      // (Scope: default — applies to all private chats with this bot.)
      try {
        await bot.telegram.setMyCommands(BOT_COMMANDS);
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

  return bot;
}

export function stopTelegramBot() {
  if (bot) bot.stop('shutdown');
}
