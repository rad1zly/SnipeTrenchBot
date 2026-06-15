// src/notifier.js
// =============================================================================
// Notification dispatcher. Wraps Telegraf and console.log behind one interface
// so the rest of the app can call `notifier.signal(event)` without caring
// whether the Telegram bot is connected yet.
//
// v0.6.1: per-user routing. Trade events (TOKEN_CREATED, SELL_DETECTED,
// tradeStep, tradeClosed, tradeDenied) are sent ONLY to the chat_id that
// owns the wallet — not broadcast. System events (info, error) still
// broadcast to all subscribers so everyone sees startup/pause/resume/etc.
//
// In DRY_RUN, every notifier call ALSO echoes to the console so the user can
// see what the bot would have done even without Telegram.
// =============================================================================

import { subscribersDb, walletsDb } from './db.js';

let bot = null; // telegraf instance (set later by telegramBot.js)

function getTargets() {
  // Broadcast to all known subscribers. If empty, no Telegram send (just log).
  return subscribersDb.list().map((s) => s.chat_id);
}

async function send(text, opts = {}) {
  // Local console echo first — always.
  console.log(text);
  if (!bot) return;
  const targets = getTargets();
  if (targets.length === 0) return;
  // Send to all subscribers in parallel. Per-recipient errors are logged but
  // do not stop other deliveries.
  await Promise.all(
    targets.map(async (chatId) => {
      try {
        await bot.telegram.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...opts,
        });
      } catch (err) {
        const msg = err?.response?.description || err?.message || String(err);
        console.error(`[notifier] send to ${chatId} failed: ${msg}`);
      }
    })
  );
}

/** Send to a single chat_id. Falls back to console-only if bot not attached. */
async function notifyOne(chatId, text, opts = {}) {
  console.log(`[notifier → ${chatId}] ${text}`);
  if (!bot || chatId == null) return;
  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts,
    });
  } catch (err) {
    const msg = err?.response?.description || err?.message || String(err);
    console.error(`[notifier] send to ${chatId} failed: ${msg}`);
  }
}

/**
 * Resolve the chatId from a trade event. Returns null if the event has no
 * owner (e.g. wallet removed mid-poll, or legacy broadcast). In that case
 * the caller can choose to drop the message or fall back to broadcast.
 */
function ownerChatId(event) {
  if (event?.chatId != null) return event.chatId;
  if (event?.wallet) {
    const owner = walletsDb.get(event.wallet);
    if (owner) return owner.chat_id;
  }
  return null;
}

function shortAddr(a) {
  if (!a) return '?';
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

const notifier = {
  /** Wire the bot instance. Called by telegramBot.js after launch. */
  attachBot(telegrafInstance) {
    bot = telegrafInstance;
  },

  /** Send a TOKEN_CREATED event to the wallet owner only. */
  async tokenCreated(event) {
    const { wallet, mint, signature } = event;
    const text = [
      `🆕 <b>TOKEN CREATED</b>  ${ts()}`,
      `Dev:     <code>${wallet}</code>`,
      `Mint:    <code>${mint}</code>`,
      `Tx:      <a href="https://solscan.io/tx/${signature}">${shortAddr(signature)}</a>`,
      `Watching for sell signal…`,
    ].join('\n');
    const target = ownerChatId(event);
    if (target != null) await notifyOne(target, text);
    else await send(text); // fallback (shouldn't happen, but log loudly)
  },

  /** Send a SELL_DETECTED event — the trade trigger. Owner only. */
  async sellDetected(event) {
    const { wallet, mint, solReceived, tokenSent, signature } = event;
    // v0.6.0: surface this wallet's copy count so users can see hot wallets.
    // Pre-buy count (this trade will bump it to N+1 once executor commits).
    const stats = walletsDb.getStats(wallet);
    const copyLine = stats && stats.copy_count > 0
      ? `\n📊 Copy #${stats.copy_count + 1} for this wallet` +
        (stats.last_copy_at ? `  (last: ${new Date(stats.last_copy_at).toISOString().slice(0, 16).replace('T', ' ')}Z)` : '')
      : `\n📊 Copy #1 for this wallet (first!)`;
    const text = [
      `🔔 <b>DEV SELL DETECTED</b>  ${ts()}`,
      `Dev:      <code>${wallet}</code>`,
      `Mint:     <code>${mint}</code>`,
      `Sold:     ${Number(tokenSent).toLocaleString()} tokens`,
      `Received: ${Number(solReceived).toFixed(4)} SOL`,
      `Tx:       <a href="https://solscan.io/tx/${signature}">${shortAddr(signature)}</a>`,
      copyLine,
      `⚡ Executing copy-trade…`,
    ].join('\n');
    const target = ownerChatId(event);
    if (target != null) await notifyOne(target, text);
    else await send(text);
  },

  /** Trade execution step. Owner only. */
  async tradeStep(event) {
    const { step, mint, details, chatId } = event;
    const text = [
      `${step === 'BUY' ? '🟢' : step === 'SELL' ? '🔴' : '⚪'} <b>${step}</b>  ${ts()}`,
      `Mint: <code>${mint}</code>`,
      ...Object.entries(details || {}).map(([k, v]) => `  ${k}: ${typeof v === 'number' ? v.toFixed(6) : v}`),
    ].join('\n');
    const target = chatId ?? ownerChatId(event);
    if (target != null) await notifyOne(target, text);
    else await send(text);
  },

  /** Trade completed. Owner only. */
  async tradeClosed(event) {
    const { mint, entrySol, exitSol, pnl, holdMs, chatId } = event;
    const sign = pnl >= 0 ? '📈' : '📉';
    const signStr = pnl >= 0 ? '+' : '';
    const text = [
      `${sign} <b>TRADE CLOSED</b>  ${ts()}`,
      `Mint:   <code>${mint}</code>`,
      `Spent:  ${entrySol.toFixed(6)} SOL`,
      `Got:    ${exitSol.toFixed(6)} SOL`,
      `PnL:    <b>${signStr}${pnl.toFixed(6)} SOL</b>`,
      `Held:   ${holdMs} ms`,
    ].join('\n');
    const target = chatId ?? ownerChatId(event);
    if (target != null) await notifyOne(target, text);
    else await send(text);
  },

  /** Trade blocked by safety guard. Owner only. */
  async tradeDenied(event) {
    const { reason, mint, solAmount, chatId } = event;
    const text = [
      `🛑 <b>TRADE BLOCKED</b>  ${ts()}`,
      `Mint:   <code>${mint || '?'}</code>`,
      `Amount: ${solAmount ?? '?'} SOL`,
      `Reason: ${reason}`,
    ].join('\n');
    const target = chatId ?? ownerChatId(event);
    if (target != null) await notifyOne(target, text);
    else await send(text);
  },

  /** Error to all subscribers. */
  async error(message) {
    const text = `❌ <b>ERROR</b>  ${ts()}\n<code>${String(message).slice(0, 500)}</code>`;
    await send(text);
  },

  /** Plain info / status. */
  async info(text) {
    await send(`ℹ️  ${ts()}\n${text}`);
  },
};

export default notifier;
