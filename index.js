// index.js
// =============================================================================
// SnipeTrenchBot — entry point.
//
// Wires the modules together:
//   config ──► validation gate
//      │
//      ├─► HeliusMonitor (polls watched wallets, emits events)
//      │      │
//      │      └─► Executor (handles TOKEN_CREATED + SELL_DETECTED)
//      │
//      ├─► TelegramBot  (commands, notifier destination)
//      │
//      └─► Notifier    (echoes events to Telegram + console)
//
// Lifecycle:
//   1. Load config, fail fast if required fields are missing
//   2. Init DB
//   3. Init executor (loads encrypted wallet in LIVE mode — see walletManager)
//   4. Start Telegram bot
//   5. Start Helius monitor
//   6. Wire events: monitor → notifier + executor
//   7. Wait for SIGINT / SIGTERM, then graceful shutdown
// =============================================================================

import config, { validation } from './src/config.js';
import { HeliusMonitor } from './src/heliusMonitor.js';
import { HeliusWebSocketMonitor } from './src/heliusWebSocket.js';
import { initExecutor, executeSignal, status as executorStatus } from './src/executor.js';
import { startTelegramBot, stopTelegramBot } from './src/telegramBot.js';
import notifier from './src/notifier.js';
import { getDb, walletsDb, subscribersDb } from './src/db.js';
// v0.7.0: per-user trading wallets — walletManager is no longer used at
// boot. Each subscriber sets their own via /start → 🔑 Wallet.

// 1. Validation gate.
if (!validation.valid) {
  console.error('=== CONFIGURATION ERRORS ===');
  for (const e of validation.errors) console.error('  ✗ ' + e);
  console.error('\n=== WARNINGS ===');
  for (const w of validation.warnings) console.error('  ⚠ ' + w);
  console.error('\nFix your .env and try again.');
  process.exit(1);
}

console.log('=== SnipeTrenchBot starting ===');
console.log(`Mode:           ${config.DRY_RUN ? 'DRY_RUN' : '⚠️  LIVE'}`);
console.log(`RPC:            ${config.SOLANA_RPC_URL}`);
console.log(`Jupiter URL:    ${config.JUPITER_API_URL}`);
console.log(`Hold (ms):      ${config.HOLD_MS}`);
console.log(`Max SOL/trade:  ${config.MAX_SOL_PER_TRADE}`);
console.log(`Slippage bps:   ${config.SLIPPAGE_BPS}`);

// Wallet status: per-user in v0.7.0. We no longer log a single global
// trading wallet — each subscriber has their own, and broadcasting any
// address would leak it to other subscribers. Operators can run
// `sqlite3 data/snipetrench.db 'SELECT chat_id, last4, address FROM wallet'`
// to see all configured wallets (operational access, not broadcast).
console.log('Trading wallet: per-user — set yours via /start → 🔑 Wallet');
console.log('Warnings:');
for (const w of validation.warnings) console.log('  ⚠ ' + w);

// 2. Init DB (lazy — first call opens + migrates).
getDb();

// 3. Init executor (loads encrypted wallet in LIVE mode).
initExecutor();

// 4. Start monitor and bot.
// v0.8.0: WSS by default (instant signal). Set MONITOR_MODE=polling to fall back to HTTP.
const monitorMode = process.env.MONITOR_MODE || 'websocket';
const monitor = monitorMode === 'websocket'
  ? new HeliusWebSocketMonitor()
  : new HeliusMonitor();
console.log(`Monitor:        ${monitorMode}  (${monitorMode === 'websocket' ? 'logsSubscribe via WSS — sub-second signal latency' : 'HTTP polling every ' + config.POLL_INTERVAL_MS + 'ms'})`);

// Surface WSS status for ops visibility
monitor.on('status', (msg) => console.log(`[monitor] ${msg}`));
const bot = startTelegramBot({
  onPause: () => console.log('[index] trading paused via Telegram'),
  onResume: () => console.log('[index] trading resumed via Telegram'),
});

// 5. Wire monitor events.
monitor.on('event', async (event) => {
  // Notify the user, then run the trade.
  try {
    if (event.type === 'TOKEN_CREATED') {
      await notifier.tokenCreated(event);
    } else if (event.type === 'SELL_DETECTED') {
      await notifier.sellDetected(event);
    }
  } catch (err) {
    console.error('[index] notifier failed:', err);
  }
  // Execute (no-op in dry-run, real swap in live).
  executeSignal(event).catch((err) => {
    console.error('[index] executor failed:', err);
    notifier.error(`executor: ${err.message}`).catch(() => {});
  });
});

monitor.on('error', (err) => {
  console.error('[monitor]', err.message);
});

monitor.on('poll', (info) => {
  if (info.fresh > 0) {
    // v0.6.0: show wallet copy_count so logs make hot wallets obvious.
    const cc = info.copyCount ?? 0;
    console.log(
      `[monitor] ${info.address.slice(0, 4)}…${info.address.slice(-4)}: ${info.fresh} new tx(s)  (copies so far: ${cc})`
    );
  }
});

monitor.start();

// 6. Send a startup notification (broadcast — system event).
// v0.7.0: no longer broadcast a "Trading wallet" line. Each subscriber has
// their own wallet and other subscribers must never see its address. The
// bot-started message only announces the mode + subscriber count.
setTimeout(() => {
  notifier
    .info(
      [
        '🟢 Bot started',
        `Mode: ${config.DRY_RUN ? 'DRY_RUN' : 'LIVE'}`,
        `Subscribers: ${subscribersDb.count()}`,
        `Jupiter: ${config.JUPITER_API_URL}`,
        'Tip: /start → 🔑 Wallet to set your own trading wallet, /start → 🎯 Copy Trade to tune filters.',
      ].join('\n')
    )
    .catch((e) => console.error('[index] startup notify failed:', e.message));
}, 1500);

// 7. Graceful shutdown.
function shutdown(signal) {
  console.log(`\n[index] received ${signal}, shutting down…`);
  try {
    monitor.stop();
    stopTelegramBot();
    notifier.info('🔴 Bot stopped').catch(() => {});
  } catch (e) {
    console.error('[index] shutdown error:', e);
  }
  // Give the notifier a moment to flush, then exit.
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
