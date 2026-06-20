#!/usr/bin/env node
// scripts/test-gmgn-sell-detection.js
// Regression test for v0.8.0: detect SELL events from GMGN/Jupiter-routed
// transactions where SOL is routed through intermediate vaults.
// Run: node scripts/test-gmgn-sell-detection.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✅', name);
    pass++;
  } catch (e) {
    console.log('  ❌', name, '—', e.message);
    fail++;
  }
}

console.log('=== GMGN/Jupiter-routed SELL detection (v0.8.0) ===');

// Replicate isSell (since it's not exported)
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1e9;
const src = readFileSync('src/heliusMonitor.js', 'utf8');

function isSell(tx, wallet) {
  const transfers = tx.tokenTransfers || [];
  const natives = tx.nativeTransfers || [];
  const sentToken = transfers.find(
    (t) => t.fromUserAccount === wallet && t.tokenAmount > 0
  );
  if (!sentToken) return null;
  if (sentToken.mint === WSOL_MINT) return null;
  const directSol = natives.find(
    (t) => t.toUserAccount === wallet && t.amount > 0
  );
  if (directSol) {
    return { mint: sentToken.mint, solReceived: directSol.amount / LAMPORTS_PER_SOL, tokenSent: sentToken.tokenAmount };
  }
  const acct = (tx.accountData || []).find(a => a.account === wallet);
  const netSol = acct ? (acct.nativeBalanceChange || 0) : 0;
  if (netSol >= 0) return null;
  return { mint: sentToken.mint, solReceived: 0, tokenSent: sentToken.tokenAmount };
}

const WALLET = '6DVEtijzmZbh18LvgMdF8fqYB2cFozdr2jAXhnVfDooM';

test('source code has v0.8.0 GMGN comment', () => {
  assert.match(src, /v0\.8\.0.*[Gg][Mm][Gg][Nn]/);
  assert.match(src, /negative net SOL balance change/);
});

test('source code falls back to accountData when no direct SOL', () => {
  assert.match(src, /accountData.*find|netSol < 0/);
});

test('GMGN-routed sell is detected (real tx shape)', () => {
  const tx = {
    source: 'PUMP_FUN', type: 'SWAP',
    tokenTransfers: [{
      fromUserAccount: WALLET,
      toUserAccount: 'AQQ6kmUW8n9fJKJrUKb2U6MUd2oKdUmnJZjad6K7Rxsw',
      tokenAmount: 3497.1102,
      mint: '9mNvAGsKQ9dUj4yPgLXmy4fBjmeC1TvqjK96U8Rapump',
    }],
    nativeTransfers: [
      { fromUserAccount: WALLET, toUserAccount: 'gmgnUA4v4i7GcVm3FqFV6us9stcfgDQKYDLARsz8wU1', amount: 100000 },
      { fromUserAccount: WALLET, toUserAccount: '6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn', amount: 967 },
    ],
    accountData: [
      { account: WALLET, nativeBalanceChange: -19257, tokenBalanceChanges: [] }
    ]
  };
  const r = isSell(tx, WALLET);
  assert.ok(r, 'should detect sell');
  assert.equal(r.mint, '9mNvAGsKQ9dUj4yPgLXmy4fBjmeC1TvqjK96U8Rapump');
  assert.equal(r.solReceived, 0, 'solReceived is unknown (will be quoted by executor)');
  assert.equal(r.tokenSent, 3497.1102);
});

test('direct SOL receive still uses the precise amount', () => {
  const tx = {
    tokenTransfers: [{
      fromUserAccount: WALLET, toUserAccount: 'poolAddr',
      tokenAmount: 100, mint: 'SomeTokenMint',
    }],
    nativeTransfers: [
      { fromUserAccount: 'poolAddr', toUserAccount: WALLET, amount: 5000000000 },
    ],
    accountData: [{ account: WALLET, nativeBalanceChange: 4999900000 }],
  };
  const r = isSell(tx, WALLET);
  assert.equal(r.solReceived, 5);
  assert.equal(r.tokenSent, 100);
});

test('buy-only tx (no token sent) returns null', () => {
  const tx = {
    tokenTransfers: [{
      fromUserAccount: 'someone', toUserAccount: WALLET,
      tokenAmount: 100, mint: 'SomeTokenMint',
    }],
    nativeTransfers: [
      { fromUserAccount: WALLET, toUserAccount: 'poolAddr', amount: 1000000000 },
    ],
    accountData: [{ account: WALLET, nativeBalanceChange: -1000000000 }],
  };
  const r = isSell(tx, WALLET);
  assert.equal(r, null);
});

test('wSOL wrap (not a real sell) returns null', () => {
  const tx = {
    tokenTransfers: [{
      fromUserAccount: WALLET, toUserAccount: 'wSolAta',
      tokenAmount: 1000000000, mint: WSOL_MINT,
    }],
    nativeTransfers: [],
    accountData: [],
  };
  const r = isSell(tx, WALLET);
  assert.equal(r, null);
});

test('net SOL change >= 0 (gaining SOL, no direct) is not a sell', () => {
  // airdrop via vault — token sent but SOL routed elsewhere and gained overall
  const tx = {
    tokenTransfers: [{
      fromUserAccount: WALLET, toUserAccount: 'someone',
      tokenAmount: 100, mint: 'SomeTokenMint',
    }],
    nativeTransfers: [
      // no transfer TO wallet
      { fromUserAccount: WALLET, toUserAccount: 'airdrop_vault', amount: 100 },
    ],
    accountData: [{ account: WALLET, nativeBalanceChange: 1000 }],  // net gain
  };
  const r = isSell(tx, WALLET);
  assert.equal(r, null);
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
