// src/heliusWebSocket.js
// =============================================================================
// Real-time wallet monitor via Helius WebSocket (logsSubscribe).
// Replaces the HTTP polling loop in heliusMonitor.js with instant
// notification when a watched wallet's transaction lands on-chain.
//
// v0.8.0 (June 2026).
//
// Why WSS instead of polling:
//   - Polling: worst-case latency = POLL_INTERVAL_MS * N_wallets
//     For 2 wallets @ 5s interval + 100ms rate-limit delay = 5.2s
//   - WSS: instant notification (~100-200ms after slot confirmation)
//     Total signal-to-quote latency: <300ms (was 5+ seconds)
//
// Architecture:
//   1. Open WSS to wss://mainnet.helius-rpc.com/?api-key=...
//   2. For each watched wallet, send logsSubscribe with mentions filter
//   3. On notification → fetch parsed tx via Helius enhanced HTTP API
//      (we still need the parsed tokenTransfers, nativeTransfers etc. for
//      classification — only available via the enhanced API)
//   4. Classify + emit same event shape as the polling version
//   5. Auto-reconnect with exponential backoff (1s → 30s) on disconnect
//   6. Re-subscribe all wallets on reconnect
// =============================================================================

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import axios from 'axios';
import config from './config.js';
import { walletsDb, signalsDb } from './db.js';

const HELIUS_WSS_URL = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
const HELIUS_HTTP_BASE = 'https://api.helius.xyz';
const FETCH_TIMEOUT_MS = 5000;
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

const seenSignatures = new Map();  // walletAddress -> Set<sig>

function seen(wallet) {
  if (!seenSignatures.has(wallet)) seenSignatures.set(wallet, new Set());
  return seenSignatures.get(wallet);
}

function isValidSolanaAddress(addr) {
  return typeof addr === 'string' && addr.length >= 32 && addr.length <= 44;
}

export class HeliusWebSocketMonitor extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._ready = false;
    this._reqId = 0;
    this._pending = new Map();           // id -> {resolve, reject, ts}
    this._subscriptions = new Map();      // address -> subscriptionId
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._shutdown = false;
    this._pendingFetches = new Set();     // signatures currently being fetched
  }

  async start() {
    this._shutdown = false;
    await this._connect();
  }

  stop() {
    this._shutdown = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* ignore */ }
      this._ws = null;
    }
    this._ready = false;
  }

  async _connect() {
    if (this._shutdown) return;
    this.emit('status', 'connecting');

    const ws = new WebSocket(HELIUS_WSS_URL, {
      handshakeTimeout: 10_000,
    });
    this._ws = ws;

    ws.on('open', () => {
      this._ready = true;
      this._reconnectAttempts = 0;
      this.emit('status', 'connected');
      // Re-subscribe to all known wallets
      this._resubscribeAll().catch((err) => this.emit('error', err));
      // v0.8.0: start periodic wallet-list refresh so users can add wallets
      // via Telegram /start → 🔑 Wallet without restarting the bot.
      if (!this._refreshTimer) {
        this._refreshTimer = setInterval(() => this._refreshWalletList().catch(() => {}), 30_000);
      }
    });

    ws.on('message', (data) => {
      this._handleMessage(data).catch((err) => this.emit('error', err));
    });

    ws.on('error', (err) => {
      this.emit('error', new Error(`helius WSS error: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      this._ready = false;
      this.emit('status', `disconnected (code=${code})`);
      if (!this._shutdown) this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_INITIAL_MS * Math.pow(2, this._reconnectAttempts)
    );
    this._reconnectAttempts++;
    this.emit('status', `reconnecting in ${backoff}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch((err) => this.emit('error', err));
    }, backoff);
  }

  async _request(method, params) {
    if (!this._ready || !this._ws) {
      throw new Error('WSS not ready');
    }
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, ts: Date.now() });
      const timeout = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`WSS request ${method} timed out`));
        }
      }, 10_000);
      this._pending.get(id).timeout = timeout;
      this._ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;  // ignore non-JSON
    }

    // Response to a request
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject, timeout } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timeout);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    // Subscription notification: logsSubscribe
    if (msg.method === 'logsNotification') {
      const { signature, err } = msg.params.result.value;
      if (err) return;  // tx failed — ignore
      if (!signature) return;
      // Fetch the full parsed tx asynchronously (don't block WSS)
      this._handleNewTx(signature).catch((err) =>
        this.emit('error', new Error(`handleNewTx failed: ${err.message}`))
      );
      return;
    }
  }

  /**
   * Fetch the full parsed transaction and emit classification events.
   * Runs out-of-band of the WSS message handler so we don't block other notifications.
   */
  async _handleNewTx(signature) {
    if (this._pendingFetches.has(signature)) return;  // already in flight
    this._pendingFetches.add(signature);
    try {
      const tx = await fetchTx(signature);
      if (!tx) return;
      // For each watched wallet mentioned in this tx, check + emit
      const addresses = walletsDb.listAll();
      for (const address of addresses) {
        if (seen(address).has(signature)) continue;
        seen(address).add(signature);
        const event = classifyTx(tx, address);
        if (event) {
          console.log(`[monitor] detected ${event.type} for ${address.slice(0,8)}... mint=${event.mint.slice(0,8)}...`);
          // v0.8.0: emit one event per owner. Without fan-out, only the
          // first owner of a shared watch wallet gets the signal — bad UX
          // for multi-user mode where multiple users watch the same dev.
          const owners = walletsDb.listOwners(address);
          for (const owner of owners) {
            const ownerEvent = { ...event, chatId: owner.chat_id };
            this.emit('event', ownerEvent);
          }
          signalsDb.log({
            type: event.type,
            wallet: event.wallet,
            mint: event.mint,
            data: { ...event, ownerCount: owners.length },
          });
        }
      }
    } finally {
      this._pendingFetches.delete(signature);
    }
  }

  /**
   * Subscribe to any new wallets in the DB that we don't already track.
   * Run periodically so users can add wallets without restart.
   */
  async _refreshWalletList() {
    if (!this._ready) return;
    const addresses = walletsDb.listAll();
    for (const address of addresses) {
      if (!this._subscriptions.has(address)) {
        try { await this._subscribe(address); }
        catch (err) { this.emit('error', new Error(`subscribe ${address} failed: ${err.message}`)); }
      }
    }
  }

  async _resubscribeAll() {
    const addresses = walletsDb.listAll();
    this._subscriptions.clear();
    for (const address of addresses) {
      try {
        await this._subscribe(address);
      } catch (err) {
        this.emit('error', new Error(`subscribe ${address} failed: ${err.message}`));
      }
    }
    this.emit('status', `subscribed to ${this._subscriptions.size} wallet(s)`);
  }

  async _subscribe(address) {
    if (!isValidSolanaAddress(address)) {
      this.emit('error', new Error(`invalid wallet address: ${address}`));
      return;
    }
    if (this._subscriptions.has(address)) return;
    // JSON-RPC positional args: [filter, config]
    const subId = await this._request('logsSubscribe', [
      { mentions: [address] },
      { commitment: 'processed' },  // v0.8.0: processed for fastest signal
    ]);
    this._subscriptions.set(address, subId);
  }

  async _unsubscribe(address) {
    const subId = this._subscriptions.get(address);
    if (!subId) return;
    try {
      await this._request('logsUnsubscribe', [subId]);
    } catch (err) {
      // best-effort — server may already have lost the connection
    }
    this._subscriptions.delete(address);
  }

  /**
   * Add a wallet to the watch list at runtime (no restart needed).
   */
  async addWallet(address) {
    if (!this._ready) {
      // Queue for after reconnection
      this.once('status', (s) => { if (s === 'connected') this._subscribe(address); });
      return;
    }
    await this._subscribe(address);
  }

  /**
   * Remove a wallet from the watch list.
   */
  async removeWallet(address) {
    await this._unsubscribe(address);
  }
}

// -----------------------------------------------------------------------------
// Tx fetch + classification (reused from heliusMonitor.js pattern)
// -----------------------------------------------------------------------------

async function fetchTx(signature) {
  try {
    const res = await axios.post(
      `${HELIUS_HTTP_BASE}/v0/transactions/?api-key=${config.HELIUS_API_KEY}`,
      { transactions: [signature] },
      { timeout: FETCH_TIMEOUT_MS }
    );
    return res.data?.[0] || null;
  } catch (err) {
    throw new Error(`fetchTx ${signature} failed: ${err.message}`);
  }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Decide if a tx is a SELL by `wallet`. v0.8.0: support GMGN-routed sells.
 */
function isSell(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const natives = tx.nativeTransfers || [];
  const sentToken = transfers.find(
    (t) => t.fromUserAccount === wallet && t.tokenAmount > 0
  );
  if (!sentToken) return null;
  if (sentToken.mint === WSOL_MINT) return null;
  // Direct SOL receive (GMGN transparent route, pump.fun V1 with direct transfer)
  const directSol = natives.find(
    (t) => t.toUserAccount === wallet && t.amount > 0
  );
  if (directSol) {
    return {
      mint: sentToken.mint,
      solReceived: directSol.amount / 1e9,
      tokenSent: sentToken.tokenAmount,
    };
  }
  // v0.8.7.1 (20 Jun 2026): three SOL-receipt paths for SELL detection.
  // Path 2: nativeBalanceChange > 0 (pump.fun V1 direct, wallet gains SOL from sell).
  //   Live failure: 6DVEt... SELL 5qgWr...pump sig 5LGS4d8... → netSol=+75,574 → missed.
  //   Threshold 50,000 lamports (~$0.007) for direct SELL (early-token thin liquidity).
  // Path 3: nativeBalanceChange < 0 (GMGN aggregator route, wallet loses SOL).
  //   Threshold 500,000 lamports to filter tiny refunds.
  const acct = (tx.accountData || []).find((a) => a.account === wallet);
  const netSol = acct ? (acct.nativeBalanceChange || 0) : 0;
  if (netSol > 0 && netSol >= 50_000) {
    return {
      mint: sentToken.mint,
      solReceived: netSol / 1e9,
      tokenSent: sentToken.tokenAmount,
    };
  }
  if (netSol < 0 && Math.abs(netSol) >= 500_000) {
    return {
      mint: sentToken.mint,
      solReceived: 0,
      tokenSent: sentToken.tokenAmount,
    };
  }
  return null;
}

/**
 * Decide if a tx is a BUY by `wallet`. Symmetric to isSell.
 * v0.8.7 (20 Jun 2026): support GMGN / Jupiter / Pump.fun aggregator routes.
 * User feedback: "teman ku trade pake gmgn gak ke track".
 */
function isBuy(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const natives = tx.nativeTransfers || [];
  const receivedToken = transfers.find(
    (t) => t.toUserAccount === wallet && t.tokenAmount > 0
  );
  if (!receivedToken) return null;
  if (receivedToken.mint === WSOL_MINT) return null;

  // Path 1: direct SOL spend (most precise).
  const directSol = natives.find(
    (t) => t.fromUserAccount === wallet && t.amount > 0
  );
  if (directSol) {
    return {
      mint: receivedToken.mint,
      solSpent: directSol.amount / 1e9,
      tokenReceived: receivedToken.tokenAmount,
    };
  }

  // Path 2: accountData shows negative net SOL change (GMGN aggregator).
  const acct = (tx.accountData || []).find((a) => a.account === wallet);
  const netSol = acct ? (acct.nativeBalanceChange || 0) : 0;
  if (netSol < 0 && Math.abs(netSol) >= 500_000) {
    return {
      mint: receivedToken.mint,
      solSpent: 0,  // unknown; executor uses fixed_buy_sol
      tokenReceived: receivedToken.tokenAmount,
    };
  }
  return null;
}

/**
 * Classify a tx for a given wallet: returns a normalized event or null.
 * Mirrors the polling version's classifyTx exactly.
 */
function classifyTx(tx, wallet) {
  if (!tx || !tx.signature) return null;
  // SELL detection first (most common)
  const sell = isSell(tx, wallet);
  if (sell) {
    return {
      type: 'SELL_DETECTED',
      wallet,
      mint: sell.mint,
      solReceived: sell.solReceived,
      tokenSent: sell.tokenSent,
      signature: tx.signature,
      timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
    };
  }
  // TOKEN_CREATED: pump.fun source + wallet is fee payer + creates new mint
  if (tx.source === 'PUMP_FUN' && tx.feePayer === wallet) {
    const mintCreate = (tx.tokenTransfers || []).find((t) => t.fromUserAccount === wallet);
    if (mintCreate) {
      return {
        type: 'TOKEN_CREATED',
        wallet,
        mint: mintCreate.mint,
        signature: tx.signature,
        timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
      };
    }
  }
  // v0.8.7: BUY_DETECTED — mirror-trade GMGN/Jupiter/Pump.fun aggregator buys.
  const buy = isBuy(tx, wallet);
  if (buy) {
    return {
      type: 'BUY_DETECTED',
      wallet,
      mint: buy.mint,
      solSpent: buy.solSpent,
      tokenReceived: buy.tokenReceived,
      signature: tx.signature,
      timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
    };
  }
  return null;
}
