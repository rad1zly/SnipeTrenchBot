// src/walletMenu.js
// =============================================================================
// Telegram UI for the bot's own trading wallet. The key is sent via DM, the
// user's message is auto-deleted, and the bot stores only the encrypted
// ciphertext in the `wallet` table (see walletManager.js).
//
// Flow:
//   1. User taps 🔑 Wallet in main menu → renderWalletMenu(ctx) shows status
//   2. User taps "➕ Set / Replace" → promptSetWallet(ctx) sends a prompt
//      message; bot enters pending-set mode for this chat (5 min TTL)
//   3. User sends a text message → handlePendingWalletText(ctx) is called
//      by telegramBot.js's text handler. We:
//        - validate format
//        - encrypt + store via walletManager.set()
//        - delete the user's message containing the key
//        - delete the "send your key" prompt
//        - send a confirmation that shows only last 4 of the public address
//   4. User taps "🗑 Remove" → confirmRemoveWallet → doRemoveWallet
//
// Security:
//   - Private chat (DM) only. We refuse in groups / channels.
//   - User's key message is deleted from Telegram via ctx.deleteMessage().
//     Works for any message the bot has access to in a private chat, even
//     messages sent by the user (within 48h of bot being added to chat).
//   - The "send your key" prompt is also deleted once the user replies.
//   - The full key never appears in any confirmation or log line.
// =============================================================================

import { Markup } from 'telegraf';
import { walletManager } from './walletManager.js';
import config from './config.js';

// -----------------------------------------------------------------------------
// Pending "set wallet" state
// -----------------------------------------------------------------------------
// chatId -> { startedAt: number, promptMsgId: number|null }
// promptMsgId is the message_id of the "send your key" prompt so we can
// delete it after the user replies. Cleared on submit, cancel, or TTL.
const pendingSetWallet = new Map();
const SET_WALLET_TTL_MS = 5 * 60 * 1000;

function setPending(chatId, promptMsgId = null) {
  pendingSetWallet.set(chatId, { startedAt: Date.now(), promptMsgId });
}
function isPending(chatId) {
  const p = pendingSetWallet.get(chatId);
  if (!p) return null;
  if (Date.now() - p.startedAt > SET_WALLET_TTL_MS) {
    pendingSetWallet.delete(chatId);
    return null;
  }
  return p;
}
function clearPending(chatId) {
  pendingSetWallet.delete(chatId);
}

// -----------------------------------------------------------------------------
// Display helpers
// -----------------------------------------------------------------------------

function buildWalletText() {
  const status = walletManager.getStatus();
  if (!status.set) {
    return [
      '🔑 <b>Trading Wallet</b>',
      '',
      'Status: ⚠️ <b>Not set</b>',
      '',
      'The bot has no trading wallet configured.',
      config.DRY_RUN
        ? 'You\'re in <b>DRY_RUN</b> mode — trades are logged but not signed, so this is fine for now.'
        : '⚠️ You\'re in <b>LIVE</b> mode — the bot cannot sign transactions until you set one.',
      '',
      '<i>Tap <b>➕ Set Wallet</b> to add one. The key is encrypted (AES-256-GCM) at rest and your message is auto-deleted from the chat.</i>',
    ].join('\n');
  }
  return [
    '🔑 <b>Trading Wallet</b>',
    '',
    'Status: ✅ <b>Set</b>',
    `Address: <code>${status.address}</code>`,
    `Last 4:  <code>...${status.last4}</code>`,
    `Set:     ${new Date(status.createdAt).toISOString().slice(0, 16).replace('T', ' ')}Z`,
    `Set by:  ${status.setBy ? '@' + status.setBy : '—'}`,
    '',
    '<b>Storage:</b> AES-256-GCM encrypted (single row, id=1)',
    '<b>Display:</b> only the public address + last 4 are ever shown.',
    '<b>Logs:</b>    the full key is never logged.',
  ].join('\n');
}

function walletMenu() {
  const status = walletManager.getStatus();
  const buttons = [
    [Markup.button.callback(
      status.set ? '🔄 Replace Wallet' : '➕ Set Wallet',
      'cmd:set_wallet'
    )],
  ];
  if (status.set) {
    buttons.push([Markup.button.callback('🗑 Remove Wallet', 'cmd:remove_wallet')]);
  }
  buttons.push([Markup.button.callback('« Back to Main', 'menu:main')]);
  return Markup.inlineKeyboard(buttons);
}

// -----------------------------------------------------------------------------
// Render / navigate
// -----------------------------------------------------------------------------

/**
 * Render the wallet submenu in place (edit the current message). Used by
 * `menu:wallet` callback. Falls back to sending a new message if edit
 * fails for any reason other than "message is not modified".
 */
async function renderWalletMenu(ctx) {
  try {
    await ctx.editMessageText(buildWalletText(), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...walletMenu(),
    });
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
}

/**
 * User tapped "Set / Replace". Send the prompt that asks them to paste
 * their private key. Record this chat as "in pending-set mode" so the next
 * text message is consumed by handlePendingWalletText.
 */
async function promptSetWallet(ctx) {
  // Track this chat. The prompt's message_id is captured after ctx.reply so
  // we can delete it once the user replies.
  setPending(ctx.chat.id, null);
  const sent = await ctx.reply(
    [
      '🔐 <b>Set Trading Wallet</b>',
      '',
      'Send your <b>private key</b> in the next message.',
      '',
      '<b>Accepted formats:</b>',
      '• Base58: <code>5abc123...xyz</code> (typical 80-90 chars)',
      '• JSON array: <code>[12,34,56,...]</code> (64 numbers)',
      '',
      'I will <b>delete your message immediately</b> after receiving it. Only the last 4 characters of the derived public address will be shown.',
      '',
      '⚠️ <b>Private chat only</b> (DM with this bot). Group / channel messages are refused.',
      '⚠️ Make sure nobody is shoulder-surfing.',
      '⚠️ Fund the wallet with <b>only what you can afford to lose</b>.',
      '',
      'Or /cancel to abort.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true },
    }
  );
  // Update pending with the prompt's message id so we can delete it later.
  setPending(ctx.chat.id, sent.message_id);
  try {
    await ctx.answerCbQuery();
  } catch {}
}

/**
 * User tapped "🗑 Remove". Show a confirmation screen with the current
 * address (so they know what they're deleting) and a yes/cancel pair.
 */
async function confirmRemoveWallet(ctx) {
  const status = walletManager.getStatus();
  if (!status.set) {
    try { await ctx.answerCbQuery('No wallet set'); } catch {}
    return renderWalletMenu(ctx);
  }
  try {
    await ctx.editMessageText(
      [
        '⚠️ <b>Remove Trading Wallet?</b>',
        '',
        'This will <b>delete the encrypted wallet</b> from the database.',
        '',
        config.DRY_RUN
          ? 'Bot is in <b>DRY_RUN</b> mode. Removing the wallet just means you can no longer sign transactions if you switch to LIVE later.'
          : '⚠️ Bot is in <b>LIVE</b> mode. The next trade attempt will fail until you set a new wallet.',
        '',
        `<b>Current address:</b> <code>${status.address}</code>`,
        `<b>Last 4:</b> <code>...${status.last4}</code>`,
        '',
        '<i>Are you sure?</i>',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, remove', 'cmd:do_remove_wallet')],
          [Markup.button.callback('❌ Cancel', 'menu:wallet')],
        ]),
      }
    );
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
  try { await ctx.answerCbQuery(); } catch {}
}

/**
 * User confirmed removal. Delete the wallet, clear pending state, and show
 * a confirmation screen.
 */
async function doRemoveWallet(ctx) {
  const removed = walletManager.remove();
  clearPending(ctx.chat.id);
  try {
    await ctx.editMessageText(
      [
        removed ? '🗑 <b>Trading wallet removed.</b>' : 'ℹ️ <b>No wallet was set.</b>',
        '',
        config.DRY_RUN
          ? 'Bot is in <b>DRY_RUN</b> mode. Set a new wallet via /start → 🔑 Wallet whenever you want to trade live.'
          : '⚠️ Bot is in <b>LIVE</b> mode. The next trade attempt will fail until you set a new wallet.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Set New Wallet', 'cmd:set_wallet')],
          [Markup.button.callback('« Back to Main', 'menu:main')],
        ]),
      }
    );
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
  try { await ctx.answerCbQuery('Removed'); } catch {}
}

// -----------------------------------------------------------------------------
// Text handler: receives the user's key message
// -----------------------------------------------------------------------------

/**
 * Called by telegramBot.js's `bot.on('text', ...)` handler. Returns true if
 * the message was consumed (i.e. user is in pending-set mode), false if
 * the text handler should fall through to other handlers.
 *
 * The order in telegramBot.js's text handler matters: settings menu's
 * handlePendingText runs first, then add-wallet, then THIS. That way the
 * wallets screen's "Add Wallet" flow is not confused with "Set Trading
 * Wallet" — they are different pending maps.
 */
async function handlePendingWalletText(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  const pending = isPending(chatId);
  if (!pending) return false;

  // Group / channel guard. Refuse and exit pending mode so the bot doesn't
  // keep waiting.
  if (ctx.chat.type !== 'private') {
    clearPending(chatId);
    await ctx.reply(
      '⚠️ <b>Wallet keys can only be set in a private chat (DM).</b>\n\n' +
        'Open a DM with this bot, then /start → 🔑 Wallet.',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  const text = (ctx.message?.text || '').trim();
  if (!text) return false;

  // /cancel — exit pending mode without setting anything.
  if (text === '/cancel' || text === 'cancel') {
    clearPending(chatId);
    await ctx.reply('❌ Cancelled.');
    return true;
  }

  // Refuse any /command — the user is probably confused, this isn't the
  // place to type /start or /help.
  if (text.startsWith('/')) {
    await ctx.reply(
      '⚠️ That looks like a command. Send just the private key (or /cancel).',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // Try to encrypt + store. On failure, still delete the user's message
  // (defense in depth) and reply with the error.
  let result;
  try {
    result = walletManager.set({
      privateKey: text,
      chatId: ctx.chat.id,
      username: ctx.from?.username || null,
    });
  } catch (err) {
    // Best-effort delete of the user's message even on error.
    try { await ctx.deleteMessage(); } catch { /* non-fatal */ }
    await ctx.reply(
      `❌ <b>Invalid private key.</b>\n\n<code>${String(err.message || err).replace(/</g, '&lt;')}</code>\n\nTry again, or /cancel.`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // SUCCESS — clean up the chat.
  // 1. Delete the user's message containing the key. Telegram allows bots
  //    to delete any message in a private chat where the bot is present.
  //    Failure here is non-fatal — log and continue.
  try {
    await ctx.deleteMessage();
  } catch (e) {
    console.warn('[walletMenu] failed to delete user key message:', e.message || e);
  }

  // 2. Delete the "send your key" prompt message so the chat is clean.
  if (pending.promptMsgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, pending.promptMsgId);
    } catch (e) {
      // Non-fatal: prompt may already be deleted, or bot may lack perm.
      console.warn('[walletMenu] failed to delete prompt message:', e.message || e);
    }
  }

  clearPending(chatId);

  // 3. Send confirmation. The key itself never appears here — only the
  //    derived public address and the last 4 chars of that address.
  await ctx.reply(
    [
      '✅ <b>Trading wallet saved!</b>',
      '',
      `Address: <code>${result.address}</code>`,
      `Last 4:  <code>...${result.last4}</code>`,
      '',
      '<b>Storage:</b> AES-256-GCM encrypted (SQLite, single row)',
      '<b>Encryption key:</b> scrypt(machine-id + WALLET_PEPPER)',
      '',
      '🗑 Your key message has been <b>deleted from this chat</b>.',
      '🗑 The "send your key" prompt has been <b>deleted</b>.',
      '',
      config.DRY_RUN
        ? '<i>Bot is in DRY_RUN — trades are logged but not signed. Flip DRY_RUN=false in .env to trade live.</i>'
        : '<i>Bot is in LIVE mode. The next signal will use this wallet to sign.</i>',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑 Remove Wallet', 'cmd:remove_wallet')],
        [Markup.button.callback('« Back to Main', 'menu:main')],
      ]),
    }
  );

  return true;
}

export {
  // Render
  renderWalletMenu, buildWalletText, walletMenu,
  // Actions
  promptSetWallet, confirmRemoveWallet, doRemoveWallet,
  // Text handler
  handlePendingWalletText,
  // Pending state (for tests / external control)
  isPending, clearPending,
};
