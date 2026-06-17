// src/walletMenu.js
// =============================================================================
// Telegram UI for each subscriber's trading wallet. v0.7.0+: per-user, so
// each chat_id has its own row in the `wallet` table and other subscribers
// can never see this user's address or key.
//
// Flow:
//   1. User taps 🔑 Wallet in main menu → renderWalletMenu(ctx) shows their
//      own wallet status (last 4 + address). buildWalletText(chatId) is
//      scoped — never reads another user's row.
//   2. User taps "🆕 Generate" → promptGenerateWallet(ctx) creates a brand-
//      new Solana keypair inside the bot, encrypts it, stores it for the
//      user. The user just gets a public address to fund.
//   3. User taps "📥 Import" → promptSetWallet(ctx) sends a prompt; bot
//      enters pending-import mode for this chat (5 min TTL).
//   4. User sends a text message → handlePendingWalletText(ctx) consumes it.
//      We validate format, encrypt + store via walletManager.set(), delete
//      the user's message, and confirm with the derived public address.
//   5. User taps "🔐 Export" → returns their decrypted private key as a
//      single auto-deleted message. NEVER broadcast, NEVER logged.
//   6. User taps "🗑 Remove" → confirmRemoveWallet → doRemoveWallet.
//
// Security:
//   - Private chat (DM) only. We refuse in groups / channels.
//   - User's key message is deleted from Telegram via ctx.deleteMessage().
//   - The "send your key" prompt is also deleted once the user replies.
//   - The full key never appears in any confirmation or log line.
//   - The full key only appears in a single auto-deleted export message,
//     and only after the user explicitly taps "Export".
//   - Other subscribers cannot see this user's address or balance.
// =============================================================================

import { Markup } from 'telegraf';
import { walletManager } from './walletManager.js';
import config from './config.js';

// -----------------------------------------------------------------------------
// Pending "import wallet" state (one user at a time, 5 min TTL)
// -----------------------------------------------------------------------------
// chatId -> { startedAt: number, promptMsgId: number|null }
const pendingImportWallet = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function setPending(chatId, promptMsgId = null) {
  pendingImportWallet.set(chatId, { startedAt: Date.now(), promptMsgId });
}
function isPending(chatId) {
  const p = pendingImportWallet.get(chatId);
  if (!p) return null;
  if (Date.now() - p.startedAt > PENDING_TTL_MS) {
    pendingImportWallet.delete(chatId);
    return null;
  }
  return p;
}
function clearPending(chatId) {
  pendingImportWallet.delete(chatId);
}

// -----------------------------------------------------------------------------
// Display helpers — per-user
// -----------------------------------------------------------------------------

function buildWalletText(chatId) {
  const status = walletManager.getStatus(chatId);
  if (!status.set) {
    return [
      '🔑 <b>Your Trading Wallet</b>',
      '',
      'Status: ⚠️ <b>Not set</b>',
      '',
      'You don\'t have a trading wallet configured yet.',
      config.DRY_RUN
        ? 'You\'re in <b>DRY_RUN</b> — trades are logged but not signed, so you can set this up later.'
        : '⚠️ You\'re in <b>LIVE</b> — your trades can\'t be signed until you set one.',
      '',
      '<i>Tap <b>🆕 Generate</b> to create a fresh wallet, or <b>📥 Import</b> to use an existing one.</i>',
    ].join('\n');
  }
  return [
    '🔑 <b>Your Trading Wallet</b>',
    '',
    'Status: ✅ <b>Set</b>',
    `Address: <code>${status.address}</code>`,
    `Last 4:  <code>...${status.last4}</code>`,
    `Set:     ${new Date(status.createdAt).toISOString().slice(0, 16).replace('T', ' ')}Z`,
    `Set by:  ${status.setBy ? '@' + status.setBy : '—'}`,
    '',
    '<b>Storage:</b> AES-256-GCM, scoped to <code>chat_id=' + chatId + '</code>',
    '<b>Visible to:</b> you only — no other subscriber can see this.',
  ].join('\n');
}

function walletMenu(chatId) {
  const status = walletManager.getStatus(chatId);
  const buttons = [
    [Markup.button.callback(
      status.set ? '🔄 Replace' : (status.set ? '🔄 Replace' : '🆕 Generate'),
      'cmd:generate_wallet'
    )],
    [Markup.button.callback('📥 Import', 'cmd:set_wallet')],
  ];
  if (status.set) {
    buttons.push([Markup.button.callback('🔐 Export', 'cmd:export_wallet')]);
    buttons.push([Markup.button.callback('🗑 Remove', 'cmd:remove_wallet')]);
  }
  buttons.push([Markup.button.callback('« Back to Main', 'menu:main')]);
  return Markup.inlineKeyboard(buttons);
}

// -----------------------------------------------------------------------------
// Render / navigate
// -----------------------------------------------------------------------------

/**
 * Render the wallet submenu in place. Falls back if edit fails.
 */
async function renderWalletMenu(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  try {
    await ctx.editMessageText(buildWalletText(chatId), {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...walletMenu(chatId),
    });
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
}

/**
 * 🆕 Generate: create a fresh Solana keypair for the caller, encrypt it,
 * store it. No need for the user to paste a key.
 */
async function promptGenerateWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  if (ctx.chat.type !== 'private') {
    await ctx.answerCbQuery('Use a DM with the bot').catch(() => {});
    return ctx.reply('⚠️ Generate only works in a private chat (DM).');
  }
  const existing = walletManager.getStatus(chatId);
  const confirmText = existing.set
    ? [
        '🔄 <b>Replace Trading Wallet?</b>',
        '',
        'You already have a wallet set. Generating a new one will:',
        '• Create a fresh Solana keypair',
        '• Overwrite your existing encrypted wallet',
        '• <b>You\'ll need to re-fund the new address</b> if you want to trade',
        '',
        '<i>Are you sure?</i>',
      ].join('\n')
    : [
        '🆕 <b>Generate New Trading Wallet?</b>',
        '',
        'I will create a fresh Solana keypair and encrypt it for you.',
        'You\'ll get a public address to fund with SOL.',
        '',
        '<i>Proceed?</i>',
      ].join('\n');

  try {
    await ctx.editMessageText(confirmText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, generate', 'cmd:do_generate_wallet')],
        [Markup.button.callback('❌ Cancel', 'menu:wallet')],
      ]),
    });
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
  try { await ctx.answerCbQuery(); } catch {}
}

/**
 * Commit the generation: create the keypair, encrypt, store.
 */
async function doGenerateWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  let result;
  try {
    result = walletManager.generate({
      chatId,
      username: ctx.from?.username || null,
    });
  } catch (err) {
    await ctx.reply(`❌ <b>Failed to generate wallet.</b>\n\n<code>${String(err.message || err).replace(/</g, '&lt;')}</code>`, { parse_mode: 'HTML' });
    return;
  }
  try {
    await ctx.editMessageText(
      [
        '✅ <b>New trading wallet generated!</b>',
        '',
        `Address: <code>${result.address}</code>`,
        `Last 4:  <code>...${result.last4}</code>`,
        '',
        '<b>Next step:</b> fund this address with SOL. The bot uses it to sign every trade for your account.',
        '',
        config.DRY_RUN
          ? '<i>You\'re in DRY_RUN — trades are logged but not signed. Flip DRY_RUN=false in .env to go live.</i>'
          : '<i>You\'re in LIVE — the next signal will use this wallet.</i>',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔐 Export Private Key', 'cmd:export_wallet')],
          [Markup.button.callback('« Back to Wallet', 'menu:wallet')],
        ]),
      }
    );
  } catch (err) {
    if (!String(err.message || '').includes('message is not modified')) {
      throw err;
    }
  }
  try { await ctx.answerCbQuery('Generated'); } catch {}
}

/**
 * 📥 Import: prompt the user to paste a private key. The next text message
 * from this chat will be consumed as the key.
 */
async function promptSetWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  if (ctx.chat.type !== 'private') {
    await ctx.answerCbQuery('Use a DM with the bot').catch(() => {});
    return ctx.reply('⚠️ Import only works in a private chat (DM).');
  }
  setPending(chatId, null);
  const sent = await ctx.reply(
    [
      '📥 <b>Import Trading Wallet</b>',
      '',
      'Send your <b>private key</b> in the next message.',
      '',
      '<b>Accepted formats:</b>',
      '• Base58: <code>5abc123...xyz</code> (typical 80-90 chars)',
      '• JSON array: <code>[12,34,56,...]</code> (64 numbers)',
      '',
      'I will <b>delete your message immediately</b> after receiving it. Only the last 4 of the derived public address will be shown.',
      '',
      '⚠️ <b>Private chat only</b>. Group / channel messages are refused.',
      '⚠️ Make sure nobody is shoulder-surfing.',
      '',
      'Or /cancel to abort.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true },
    }
  );
  setPending(chatId, sent.message_id);
  try { await ctx.answerCbQuery(); } catch {}
}

/**
 * 🔐 Export: send the user's private key as a single auto-deleted message.
 * ONLY this user sees it. NEVER broadcast. NEVER logged.
 */
async function promptExportWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  if (ctx.chat.type !== 'private') {
    await ctx.answerCbQuery('Use a DM with the bot').catch(() => {});
    return ctx.reply('⚠️ Export only works in a private chat (DM).');
  }
  const status = walletManager.getStatus(chatId);
  if (!status.set) {
    await ctx.answerCbQuery('No wallet set').catch(() => {});
    return renderWalletMenu(ctx);
  }
  let pk;
  try {
    pk = walletManager.getPrivateKey(chatId);
  } catch (err) {
    await ctx.reply(`❌ <b>Failed to decrypt wallet.</b>\n\n<code>${String(err.message || err).replace(/</g, '&lt;')}</code>`, { parse_mode: 'HTML' });
    return;
  }

  // Send the key in a single message. Schedule auto-delete in 60s. The
  // surrounding wrapper text makes it clear this is sensitive. We do NOT
  // log the key — the notifier path is not used here.
  const sent = await ctx.reply(
    [
      '🔐 <b>Your Trading Wallet — Private Key</b>',
      '',
      '<b>This message will be auto-deleted in 60 seconds.</b>',
      'Copy it somewhere safe (e.g. a password manager) before then.',
      '',
      `Address: <code>${status.address}</code>`,
      `Last 4:  <code>...${status.last4}</code>`,
      '',
      '<b>Private key:</b>',
      '<code>' + pk + '</code>',
      '',
      '⚠️ Anyone with this key controls the wallet. Never share it.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }
  );

  // Best-effort auto-delete after 60s. Don't surface errors.
  setTimeout(() => {
    ctx.telegram.deleteMessage(chatId, sent.message_id).catch(() => {});
  }, 60_000);

  try { await ctx.answerCbQuery('Key sent — auto-deletes in 60s'); } catch {}
}

/**
 * 🗑 Remove: confirm then wipe.
 */
async function confirmRemoveWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const status = walletManager.getStatus(chatId);
  if (!status.set) {
    try { await ctx.answerCbQuery('No wallet set'); } catch {}
    return renderWalletMenu(ctx);
  }
  try {
    await ctx.editMessageText(
      [
        '⚠️ <b>Remove Your Trading Wallet?</b>',
        '',
        'This will <b>delete your encrypted wallet</b> from the database.',
        'Other subscribers are not affected.',
        '',
        config.DRY_RUN
          ? 'Bot is in <b>DRY_RUN</b>. Removing the wallet means trades for your account will be skipped.'
          : '⚠️ Bot is in <b>LIVE</b>. The next trade attempt for your account will fail until you set a new wallet.',
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

async function doRemoveWallet(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const removed = walletManager.remove(chatId);
  // Also evict any in-memory keypair cache for this user.
  try {
    const executor = await import('./executor.js');
    executor.evictKeypair(chatId);
  } catch { /* non-fatal */ }
  clearPending(chatId);
  try {
    await ctx.editMessageText(
      [
        removed ? '🗑 <b>Your trading wallet was removed.</b>' : 'ℹ️ <b>No wallet was set.</b>',
        '',
        config.DRY_RUN
          ? 'You\'re in DRY_RUN. Set a new one via /start → 🔑 Wallet → Generate or Import.'
          : '⚠️ You\'re in LIVE. Set a new one before the next signal, or trades will be denied.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🆕 Generate New', 'cmd:generate_wallet')],
          [Markup.button.callback('📥 Import', 'cmd:set_wallet')],
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
// Text handler: receives the user's pasted key
// -----------------------------------------------------------------------------

/**
 * Called by telegramBot.js's `bot.on('text', ...)` handler. Returns true if
 * the message was consumed, false otherwise.
 */
async function handlePendingWalletText(ctx) {
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  const pending = isPending(chatId);
  if (!pending) return false;

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

  if (text === '/cancel' || text === 'cancel') {
    clearPending(chatId);
    await ctx.reply('❌ Cancelled.');
    return true;
  }

  if (text.startsWith('/')) {
    await ctx.reply(
      '⚠️ That looks like a command. Send just the private key (or /cancel).',
      { parse_mode: 'HTML' }
    );
    return true;
  }

  let result;
  try {
    result = walletManager.set({
      privateKey: text,
      chatId,
      username: ctx.from?.username || null,
    });
  } catch (err) {
    try { await ctx.deleteMessage(); } catch { /* non-fatal */ }
    await ctx.reply(
      `❌ <b>Invalid private key.</b>\n\n<code>${String(err.message || err).replace(/</g, '&lt;')}</code>\n\nTry again, or /cancel.`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  // SUCCESS — clean up the chat.
  try {
    await ctx.deleteMessage();
  } catch (e) {
    console.warn('[walletMenu] failed to delete user key message:', e.message || e);
  }
  if (pending.promptMsgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, pending.promptMsgId);
    } catch (e) {
      console.warn('[walletMenu] failed to delete prompt message:', e.message || e);
    }
  }
  clearPending(chatId);

  await ctx.reply(
    [
      '✅ <b>Trading wallet saved!</b>',
      '',
      `Address: <code>${result.address}</code>`,
      `Last 4:  <code>...${result.last4}</code>`,
      '',
      '<b>Storage:</b> AES-256-GCM, scoped to your account',
      '<b>Visible to:</b> you only',
      '',
      '🗑 Your key message has been <b>deleted from this chat</b>.',
      '🗑 The "send your key" prompt has been <b>deleted</b>.',
      '',
      config.DRY_RUN
        ? '<i>You\'re in DRY_RUN — trades logged but not signed. Flip DRY_RUN=false in .env to go live.</i>'
        : '<i>You\'re in LIVE. The next signal will use this wallet.</i>',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔐 Export Private Key', 'cmd:export_wallet')],
        [Markup.button.callback('« Back to Wallet', 'menu:wallet')],
      ]),
    }
  );
  return true;
}

export {
  // Render
  renderWalletMenu, buildWalletText, walletMenu,
  // Generate / import
  promptGenerateWallet, doGenerateWallet, promptSetWallet,
  // Export / remove
  promptExportWallet, confirmRemoveWallet, doRemoveWallet,
  // Text handler
  handlePendingWalletText,
  // Pending state
  isPending, clearPending,
};
