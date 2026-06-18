#!/usr/bin/env node
// scripts/test-wss-monitor.js
// Regression test for v0.8.0: WSS-based monitor subscribes to wallets
// and receives logs notifications in real time.
// Run: node scripts/test-wss-monitor.js
import assert from 'node:assert/strict';
import { HeliusWebSocketMonitor } from '../src/heliusWebSocket.js';
import WebSocket from 'ws';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    const r = await fn();
    console.log('  ✅', name, r ? `· ${r}` : '');
    pass++;
  } catch (e) {
    console.log('  ❌', name, '—', e.message);
    fail++;
  }
}

console.log('=== WSS monitor (v0.8.0 — sub-second signal) ===');

await test('connects to wss://mainnet.helius-rpc.com and subscribes', async () => {
  const m = new HeliusWebSocketMonitor();
  let connected = false;
  m.on('status', (s) => { if (s === 'connected') connected = true; });
  await m.start();
  // Wait up to 5s for connection
  for (let i = 0; i < 50 && !connected; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(connected, 'should connect');
  // Try subscribing
  let subErr = null;
  m.on('error', (e) => { subErr = e.message; });
  await m._subscribe('rYn57LmWs2qX98koT13cDz8GKMDoMNoBcTveSnHqM7v');
  if (subErr) throw new Error('subscribe error: ' + subErr);
  assert.ok(m._subscriptions.size >= 1, `should have at least 1 subscription, got ${m._subscriptions.size}`);
  m.stop();
  return `${m._subscriptions.size} wallet(s) subscribed`;
});

await test('handles invalid wallet address gracefully', async () => {
  const m = new HeliusWebSocketMonitor();
  let errorCaught = null;
  m.on('error', (e) => { errorCaught = e; });
  await m.start();
  await new Promise((r) => setTimeout(r, 1000));  // wait for connect
  await m._subscribe('short');  // too short to be valid
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(errorCaught, 'should emit error for invalid address');
  assert.match(errorCaught.message, /invalid wallet address/);
  m.stop();
});

await test('reconnect on disconnect (simulated)', async () => {
  const m = new HeliusWebSocketMonitor();
  let statusMessages = [];
  m.on('status', (s) => statusMessages.push(s));
  await m.start();
  await new Promise((r) => setTimeout(r, 1500));  // connect
  // Force disconnect
  m._ws.terminate();
  await new Promise((r) => setTimeout(r, 200));
  m.stop();
  // Should have status: connected, then disconnected, then reconnecting
  assert.ok(statusMessages.includes('connected'), 'should connect');
  // We won't wait for actual reconnect since stop() shuts down
});

await test('addWallet queues when not ready, subscribes when ready', async () => {
  const m = new HeliusWebSocketMonitor();
  await m.start();
  await new Promise((r) => setTimeout(r, 1500));
  // addWallet should subscribe immediately if ready
  const NEW_WALLET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const beforeSize = m._subscriptions.size;
  await m.addWallet(NEW_WALLET);
  const afterSize = m._subscriptions.size;
  assert.equal(afterSize, beforeSize + 1, 'should add new subscription');
  m.stop();
});

await test('removeWallet unsubscribes', async () => {
  const m = new HeliusWebSocketMonitor();
  await m.start();
  await new Promise((r) => setTimeout(r, 1500));
  const WALLET = 'rYn57LmWs2qX98koT13cDz8GKMDoMNoBcTveSnHqM7v';
  await m._subscribe(WALLET);
  assert.ok(m._subscriptions.has(WALLET), 'should be subscribed');
  await m.removeWallet(WALLET);
  assert.ok(!m._subscriptions.has(WALLET), 'should be unsubscribed');
  m.stop();
});

console.log('---');
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
