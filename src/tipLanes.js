// src/tipLanes.js
// =============================================================================
// Multi-lane tip routing (v0.8.8-experimental M4.0).
//
// User request (tg 01:23): "rute fast tracknya kalo bisa dibikin
// fallback selain jito, kalo lagi padat transaksi. helius,0slot,jito,
// astralane".
//
// 4 lanes, each is a (tip_account, submit_endpoint) pair:
//   - jito:      Jito block engine sendTransaction endpoint
//   - 0slot:     0slot regional endpoint (Jito-compatible, faster during
//                some congestion windows)
//   - helius:    Helius Sender — dual routing to validator + Jito
//                simultaneously. Regional endpoints, 7 regions.
//   - astralane: Astralane Iris — validator co-location + leader routing,
//                "fastest Solana transaction sender" per their docs.
//
// All 4 lanes accept a Jito-style tip ix (system.transfer to a tip
// account) — the difference is the SUBMISSION ENDPOINT. By default, the
// tip ix is built with the Jito tip account (config.JITO_TIP_ACCOUNTS)
// because all 4 lanes are Jito-compatible. To override per-lane, set
// JITO_TIP_ACCOUNTS / ZERO_SLOT_TIP_ACCOUNTS / ASTRALANE_TIP_ACCOUNTS in
// .env (CSV format).
//
// submitFastTrack({ signedTxB64, side, chatId }) tries the primary
// lane first, then fallbacks in order. Each lane gets
// `TIP_LANE_TIMEOUT_MS` to confirm before the next lane gets a try.
// Land times are tracked per lane (P50 over last 20) for diagnostics
// and (future) dynamic reordering.
//
// Config:
//   TIP_LANE_PRIMARY=jito
//   TIP_LANE_FALLBACKS=helius,0slot,astralane
//   TIP_LANE_TIMEOUT_MS=8000
//   JITO_TIP_ACCOUNTS=96gYZGLn...,HFqU5x6...,Cw8CFyM9...
//   HELIUS_SENDER_URL=https://sender.helius-rpc.com/fast
//   HELIUS_API_KEY=...                    (already in config)
//   ZERO_SLOT_URL=https://ny.0slot.trade
//   ZERO_SLOT_TIP_ACCOUNTS=Eb2KpSC8q...
//   ASTRALANE_IRIS_URL=https://iris.astralane.io/submit
//   ASTRALANE_TIP_ACCOUNTS=astra4yeMcH8gB3QYU7ihPocyFaALo1cK8tcGmYjJmQ
// =============================================================================

import { PublicKey, SystemProgram, Connection } from '@solana/web3.js';
import config from './config.js';

const log = (label, data) => {
  if (data == null) console.log(`[tipLanes] ${label}`);
  else console.log(`[tipLanes] ${label}`, JSON.stringify(data));
};

// ---------------------------------------------------------------------------
// Per-lane land-time tracking (P50 over last 20)
// ---------------------------------------------------------------------------
const _landTimes = new Map();
for (const lane of ['jito', '0slot', 'helius', 'astralane']) {
  _landTimes.set(lane, []);
}

function recordLand(lane, ms) {
  const arr = _landTimes.get(lane) || [];
  arr.push(ms);
  if (arr.length > 20) arr.shift();
  _landTimes.set(lane, arr);
}

export function getLaneStats() {
  const stats = {};
  for (const lane of ['jito', '0slot', 'helius', 'astralane']) {
    const arr = _landTimes.get(lane) || [];
    if (arr.length === 0) {
      stats[lane] = { attempts: 0, p50Ms: null, p100Ms: null };
      continue;
    }
    const sorted = [...arr].sort((a, b) => a - b);
    stats[lane] = {
      attempts: arr.length,
      p50Ms: sorted[Math.floor(sorted.length / 2)],
      p100Ms: sorted[sorted.length - 1],
    };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Lane definitions
//
// All 4 lanes use JSON-RPC `sendTransaction` (NOT {transaction: base64} —
// that was wrong). Differences:
//   - Jito:      api/v1/transactions endpoint, no API key
//   - 0slot:     0slot.trade JSON-RPC, no API key (tip is the access)
//   - Helius:    sender.helius-rpc.com/fast, API key as ?api-key= query
//   - Astralane: regional gateway /iris, API key as ?api-key= query
//
// 0slot tip accounts (verified from 0slot docs 2026):
//   6fQaVhYZA4w3MBSXjJ81Vf6W1EDYeUPXpgVQ6UQyU1Av
//   4HiwLEP2Bzqj3hM2ENxJuzhcPCdsafwiet3oGkMkuQY4
//   7toBU3inhmrARGngC7z6SjyP85HgGMmCTEwGNRAcYnEK
//   8mR3wB1nh4D6J9RUCugxUpc6ya8w38LPxZ3ZjcBhgzws
//   6SiVU5WEwqfFapRuYCndomztEwDjvS5xgtEof3PLEGm9
// ---------------------------------------------------------------------------
const JSON_RPC_BODY = (signedTxB64) => JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'sendTransaction',
  params: [signedTxB64, { encoding: 'base64', skipPreflight: true }],
});

const LANE_DEFS = {
  jito: {
    tipAccounts: (config.JITO_TIP_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    submit: async (signedTxB64) => {
      const url = 'https://mainnet.block-engine.jito.wtf/api/v1/transactions';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON_RPC_BODY(signedTxB64),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`jito http ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(`jito: ${JSON.stringify(data.error)}`);
      if (!data.result) throw new Error('jito: no signature in response');
      return data.result;
    },
  },
  '0slot': {
    // 0slot spec (from https://github.com/0slot-trade/cookbook/blob/main/how-to-start.md):
    //   - URL: http://ny.0slot.trade?api-key=$TOKEN  (HTTP not HTTPS for speed)
    //   - API key REQUIRED as query param
    //   - Rate limit: 5 calls/sec
    //   - Min tip: 0.0001 SOL to one of the 0slot tip accounts
    //   - 0slot tip accounts (verified):
    //     Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3
    //     FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe
    //     ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13
    //     6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK
    //     Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr
    // Available regional endpoints: ny, de, ams, jp, la (replace .0slot.trade prefix).
    tipAccounts: (config.ZERO_SLOT_TIP_ACCOUNTS || 'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3,FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe,ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13,6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK,Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr')
      .split(',').map((s) => s.trim()).filter(Boolean),
    submit: async (signedTxB64) => {
      const apiKey = config.ZERO_SLOT_API_KEY || '';
      if (!apiKey) {
        throw new Error('0slot: ZERO_SLOT_API_KEY not configured (set in .env)');
      }
      // 0slot docs recommend HTTP (slightly faster than HTTPS).
      const baseUrl = config.ZERO_SLOT_URL || 'http://ny.0slot.trade';
      // Strip any existing ?api-key= from the URL (user might have set it).
      const cleanUrl = baseUrl.split('?')[0];
      const url = `${cleanUrl}?api-key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON_RPC_BODY(signedTxB64),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`0slot http ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(`0slot: ${JSON.stringify(data.error)}`);
      const sig = data.result;
      if (!sig) throw new Error('0slot: no signature in response');
      return sig;
    },
  },
  helius: {
    // Helius Sender accepts Jito tip accounts (Jito-compatible). The
    // Sender service routes to validator + Jito simultaneously for
    // maximum inclusion. Per docs: minimum 0.0002 SOL tip required.
    tipAccounts: (config.JITO_TIP_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    submit: async (signedTxB64) => {
      const apiKey = config.HELIUS_API_KEY || '';
      const baseUrl = config.HELIUS_SENDER_URL || 'https://sender.helius-rpc.com/fast';
      const url = apiKey ? `${baseUrl}?api-key=${apiKey}` : baseUrl;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON_RPC_BODY(signedTxB64),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`helius http ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(`helius: ${JSON.stringify(data.error)}`);
      const sig = data.result;
      if (!sig) throw new Error('helius: no signature in response');
      return sig;
    },
  },
  astralane: {
    // Astralane Iris — regional gateway endpoint. API key REQUIRED.
    // Available regions: fr (Frankfurt), lim (Lima?), nyc, etc.
    tipAccounts: (config.ASTRALANE_TIP_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    submit: async (signedTxB64) => {
      const apiKey = config.ASTRALANE_API_KEY || '';
      if (!apiKey) {
        throw new Error('astralane: ASTRALANE_API_KEY not configured (set in .env)');
      }
      const url = (config.ASTRALANE_IRIS_URL || 'https://fr.gateway.astralane.io/iris') +
                  `?api-key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON_RPC_BODY(signedTxB64),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`astralane http ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(`astralane: ${JSON.stringify(data.error)}`);
      const sig = data.result;
      if (!sig) throw new Error('astralane: no signature in response');
      return sig;
    },
  },
};

// ---------------------------------------------------------------------------
// Tip ix building (per-lane — uses each lane's tip accounts)
// ---------------------------------------------------------------------------
const _tipAccountIdx = new Map();
for (const lane of Object.keys(LANE_DEFS)) _tipAccountIdx.set(lane, 0);

/**
 * Build a Jito-style tip transfer instruction for the given lane.
 * Caller MUST append as the LAST instruction of the transaction.
 */
export function buildLaneTipIx(lane, payer, amountSol) {
  const def = LANE_DEFS[lane];
  if (!def) return null;
  if (!amountSol || amountSol <= 0) return null;
  const lamports = Math.floor(Number(amountSol) * 1e9);
  if (lamports < 1) return null;
  if (!def.tipAccounts.length) {
    log('buildLaneTipIx: no tip accounts for lane', { lane });
    return null;
  }
  const idx = (_tipAccountIdx.get(lane) || 0) % def.tipAccounts.length;
  _tipAccountIdx.set(lane, idx + 1);
  return SystemProgram.transfer({
    fromPubkey: new PublicKey(payer),
    toPubkey: new PublicKey(def.tipAccounts[idx]),
    lamports,
  });
}

// ---------------------------------------------------------------------------
// Lane order (primary first, then fallbacks)
// ---------------------------------------------------------------------------
export function getLaneOrder() {
  const primary = (config.TIP_LANE_PRIMARY || 'jito').toLowerCase().trim();
  const fallbacks = (config.TIP_LANE_FALLBACKS || 'helius,0slot,astralane')
    .split(',').map((s) => s.toLowerCase().trim()).filter(Boolean);
  const order = [primary, ...fallbacks.filter((f) => f !== primary)];
  return order.filter((l) => LANE_DEFS[l]);
}

// ---------------------------------------------------------------------------
// Confirmation polling (uses Helius RPC for status checks)
// ---------------------------------------------------------------------------
let _rpc = null;
function getRpc() {
  if (!_rpc) _rpc = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  return _rpc;
}

async function pollConfirmation(signature, timeoutMs) {
  const t0 = Date.now();
  let lastStatus = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await getRpc().getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = r?.value?.[0];
      if (status) {
        if (status.err) throw new Error(`tx failed on-chain: ${JSON.stringify(status.err)}`);
        if (
          status.confirmationStatus === 'processed' ||
          status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized'
        ) {
          return true;
        }
        lastStatus = status.confirmationStatus;
      }
    } catch (e) {
      if (e.message && e.message.includes('tx failed on-chain')) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  log('pollConfirmation: timeout', { sig: signature.slice(0, 16) + '...', lastStatus, waitedMs: Date.now() - t0 });
  return false;
}

// ---------------------------------------------------------------------------
// Multi-lane submit with fallback
// ---------------------------------------------------------------------------
/**
 * Submit a signed tx (base64) to the primary lane first, then fallbacks.
 * Returns { signature, lane, landTimeMs, attempts } on first confirmed
 * lane. Throws if all lanes fail.
 *
 * @param {string} signedTxB64  - base64-encoded signed VersionedTransaction
 * @param {string} side         - 'buy' | 'sell' (for logging)
 * @param {number|string} chatId - for logging
 * @param {number} [timeoutMs]  - per-lane timeout (default TIP_LANE_TIMEOUT_MS)
 * @param {string[]} [lanes]    - override the lane order
 */
export async function submitFastTrack({ signedTxB64, side, chatId, timeoutMs, lanes }) {
  const order = (lanes && lanes.length) ? lanes : getLaneOrder();
  if (!order.length) throw new Error('tipLanes: no lanes configured');
  const perLaneTimeout = timeoutMs || Number(config.TIP_LANE_TIMEOUT_MS) || 8000;
  const attempts = [];

  for (const lane of order) {
    const def = LANE_DEFS[lane];
    if (!def) continue;
    const t0 = Date.now();
    try {
      log('submit:try', { lane, side, chatId, sigHead: signedTxB64.slice(0, 12) + '...' });
      const sig = await def.submit(signedTxB64);
      log('submit:sent', { lane, sig: sig.slice(0, 16) + '...' });
      const confirmed = await pollConfirmation(sig, perLaneTimeout);
      const elapsed = Date.now() - t0;
      if (confirmed) {
        recordLand(lane, elapsed);
        log('submit:landed', { lane, sig: sig.slice(0, 16) + '...', landTimeMs: elapsed });
        return { signature: sig, lane, landTimeMs: elapsed, attempts };
      }
      attempts.push({ lane, sig, error: 'timeout', elapsedMs: elapsed });
    } catch (e) {
      attempts.push({ lane, error: e.message });
      log('submit:failed', { lane, err: e.message });
    }
  }
  throw new Error(`All tip lanes failed: ${JSON.stringify(attempts)}`);
}

export const LANE_NAMES = Object.keys(LANE_DEFS);
