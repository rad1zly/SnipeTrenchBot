// src/heliusMonitor.js
// =============================================================================
// Polls Helius Enhanced Transactions API for each watched wallet, then emits
// normalized "events":
//
//   { type: 'TOKEN_CREATED', wallet, mint, signature, timestamp, source }
//   { type: 'SELL_DETECTED', wallet, mint, solReceived, tokenSent, signature, timestamp }
//
// Detection rules:
//   TOKEN_CREATED — tx.source === 'PUMP_FUN' AND wallet is the fee payer
//                   AND the tx creates a new SPL mint.
//   SELL_DETECTED — wallet is the SENDER of an SPL token AND the RECEIVER of
//                   native SOL in the same tx. This covers both Pump.fun
//                   bonding-curve sells and external DEX sells (Raydium etc).
//
// Dedup: signatures are kept in an in-memory Set per wallet. On a long
// running bot, the Set grows unbounded — for a portfolio demo this is fine
// (few hundred sigs/day). Production would store them in SQLite.
// =============================================================================

import axios from 'axios';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import config from './config.js';
import { walletsDb, signalsDb } from './db.js';

const HELIUS_BASE = 'https://api.helius.xyz';
const seenSignatures = new Map(); // walletAddress -> Set<sig>

function seen(wallet) {
  if (!seenSignatures.has(wallet)) seenSignatures.set(wallet, new Set());
  return seenSignatures.get(wallet);
}

function isValidSolanaAddress(addr) {
  return typeof addr === 'string' && addr.length >= 32 && addr.length <= 44;
}

/**
 * Fetch recent transactions for a wallet from Helius Enhanced Transactions API.
 * Returns the raw array (may be empty on error).
 */
async function fetchTxs(walletAddress, limit = config.HELIUS_TX_LIMIT) {
  if (!config.HELIUS_API_KEY) {
    throw new Error('HELIUS_API_KEY is empty — cannot fetch transactions');
  }
  const url = `${HELIUS_BASE}/v0/addresses/${walletAddress}/transactions`;
  const res = await axios.get(url, {
    params: { 'api-key': config.HELIUS_API_KEY, limit },
    timeout: 10_000,
  });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Decide if a tx is a Pump.fun token creation by `wallet`.
 * Heuristic: source = PUMP_FUN, fee payer = wallet, a new mint appears
 * in tokenTransfers as the destination OR a CREATE instruction is present.
 */
function isTokenCreated(tx, wallet) {
  if (tx.source !== 'PUMP_FUN') return false;
  // Fee payer is usually accountKeys[0].
  const feePayer = tx.transaction?.message?.accountKeys?.[0];
  if (feePayer !== wallet) return false;
  // Heuristic: a mint appears in tokenTransfers as a destination
  // (the dev receives initial tokens they minted).
  const transfers = tx.tokenTransfers || [];
  if (transfers.length === 0) return false;
  // The newly-minted token is sent TO the dev.
  const receivedMint = transfers.find(
    (t) => t.toUserAccount === wallet && t.tokenAmount > 0
  );
  if (!receivedMint) return false;
  return { mint: receivedMint.mint };
}

/**
 * Decide if a tx is a SELL by `wallet`.
 * Heuristic: wallet sends an SPL token (tokenAmount > 0, fromUserAccount = wallet)
 * AND either receives native SOL directly OR has negative net SOL balance change.
 *
 * v0.8.0: GMGN / Jupiter / Pump.fun aggregators often route SOL through
 * intermediate vaults, so nativeTransfers.toUserAccount !== wallet even for
 * a confirmed sell. We accept either:
 *   1) native SOL transferred directly to wallet, OR
 *   2) wallet's net nativeBalanceChange < 0 (proof of SOL outflow to anywhere)
 */
function isSell(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const natives = tx.nativeTransfers || [];
  const sentToken = transfers.find(
    (t) => t.fromUserAccount === wallet && t.tokenAmount > 0
  );
  if (!sentToken) return null;
  // v0.7.2: filter wSOL wraps/unwraps — not a real sell, just SOL wrapping.
  if (sentToken.mint === config.WSOL_MINT) return null;

  // Try direct SOL receive first (most precise).
  const directSol = natives.find(
    (t) => t.toUserAccount === wallet && t.amount > 0
  );
  if (directSol) {
    return {
      mint: sentToken.mint,
      solReceived: directSol.amount / config.LAMPORTS_PER_SOL,
      tokenSent: sentToken.tokenAmount,
    };
  }

  // Fallback: GMGN/Jupiter-routed sells. Use accountData's nativeBalanceChange.
  // If the wallet lost SOL (any negative amount), it's a sell. The "received"
  // amount is the absolute loss minus any non-sell SOL outflows (priority
  // fees, ATA rent) — but for now we log 0 if we can't determine the actual
  // received amount, and let the executor quote the real output via Jupiter.
  const acct = (tx.accountData || []).find(a => a.account === wallet);
  const netSol = acct ? (acct.nativeBalanceChange || 0) : 0;
  if (netSol >= 0) return null;  // no SOL loss → not a sell

  return {
    mint: sentToken.mint,
    solReceived: 0,  // unknown; executor will quote via Jupiter
    tokenSent: sentToken.tokenAmount,
  };
}

/**
 * Classify a single tx for a wallet. Returns null or an event object.
 */
function classifyTx(tx, wallet) {
  const ts = tx.timestamp ? tx.timestamp * 1000 : Date.now();
  const sig = tx.signature;
  // Token creation?
  const created = isTokenCreated(tx, wallet);
  if (created) {
    return {
      type: 'TOKEN_CREATED',
      wallet,
      mint: created.mint,
      signature: sig,
      timestamp: ts,
      source: tx.source,
    };
  }
  // Sell?
  const sold = isSell(tx, wallet);
  if (sold) {
    return {
      type: 'SELL_DETECTED',
      wallet,
      mint: sold.mint,
      solReceived: sold.solReceived,
      tokenSent: sold.tokenSent,
      signature: sig,
      timestamp: ts,
    };
  }
  return null;
}

/**
 * Monitor class. Owns the polling loop and emits events via an EventEmitter
 * so index.js can wire up the executor + notifier.
 */
export class HeliusMonitor extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._running = false;
    this._inFlight = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), config.POLL_INTERVAL_MS);
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    if (this._inFlight) return; // skip overlap
    this._inFlight = true;
    try {
      // v0.6.1: poll the union of unique addresses across all users.
      // The blockchain is shared — one poll per address, regardless of how
      // many users added it. Ownership is resolved per-event below.
      const addresses = walletsDb.listAll();
      if (addresses.length === 0) return;
      // v0.7.0: per-wallet delay to respect Helius free-tier rate limit (10 rps).
      // Sleep 1000/RPS ms between polls; +10ms safety margin.
      const perPollDelayMs = Math.ceil(1000 / config.HELIUS_RPS) + 10;
      for (const address of addresses) {
        await this._pollWallet(address);
        if (perPollDelayMs > 0) await sleep(perPollDelayMs);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this._inFlight = false;
    }
  }

  async _pollWallet(address) {
    if (!isValidSolanaAddress(address)) {
      this.emit('error', new Error(`invalid wallet address in DB: ${address}`));
      return;
    }
    const seenSet = seen(address);
    let txs;
    try {
      txs = await fetchTxs(address);
    } catch (err) {
      this.emit('error', new Error(`helius fetch failed for ${address}: ${err.message}`));
      return;
    }
    // Newest first. We process in order, stop at first seen.
    let freshCount = 0;
    for (const tx of txs) {
      if (!tx.signature) continue;
      if (seenSet.has(tx.signature)) break; // already processed up to here
      seenSet.add(tx.signature);
      const event = classifyTx(tx, address);
      if (event) {
        // v0.8.0: fan out to ALL owners of the wallet (was: only the first).
        // Without fan-out, only the first owner of a shared watch wallet
        // gets the signal — bad UX in multi-user mode.
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
      freshCount++;
    }
    walletsDb.touchOne(address);
    if (freshCount > 0) {
      // v0.6.0: include copy_count in poll event so index.js can log it.
      const stats = walletsDb.getStats(address) || { copy_count: 0 };
      this.emit('poll', { address, fresh: freshCount, copyCount: stats.copy_count });
    }
  }
}
