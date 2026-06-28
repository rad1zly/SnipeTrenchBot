// src/hicarusSim.js
// =============================================================================
// Hicarus Wallet Discovery & Simulation Engine
// ============================================
// Finds wallets with "buy → hold 1-3s → sell (+10-25% gain)" pattern and
// auto-adds them to SnipeTrenchBot with copy_mode='mirror'.
//
// Per-user request (Jun 2026): "cari wallet yg seperti 8inTY66 — buy hold
// 2-3s sell dengan gain 10-25%. Pas ketemu masukin sim engine dulu."
//
// copy_mode='mirror' = when the watched wallet BUYs a token,
// the bot also BUYs the same token (follow-buy), holds ~1s, then sells.
// =============================================================================

import { execSync } from 'node:child_process';
import config from './config.js';
import { walletsDb } from './db.js';
import notifier from './notifier.js';

// ─── Config ─────────────────────────────────────────────────────────────────
const FEE           = 0.005;     // 0.5% total (0.25% × 2 sides)
const WIN_THR_PCT   = 5;         // minimum net gain % to count as WIN
const GAIN_MAX_PCT  = 25;        // maximum net gain % (filter outliers)
const MAX_HOLD_S    = 10;         // max hold time in seconds
const MIN_TRADES    = 2;         // minimum qualifying trades to consider
const AUTO_ADD_WR   = 55;        // auto-add threshold: WR%
const OWNER_CHAT_ID = String(config.TELEGRAM_CHAT_ID || '6170215817');

// ─── GMGN CLI wrapper ────────────────────────────────────────────────────────
/**
 * Call gmgn-cli and parse JSON response.
 * Uses execSync so the CLI reads ~/.config/gmgn/.env directly (correct HOME).
 * Suppresses stderr (invalid-address warnings from gmgn-cli pollute stdout).
 */
function gmgnRun(args) {
  try {
    // Use explicit bash shell so stderr redirect works correctly
    const out = execSync(
      `/bin/bash -c "gmgn-cli ${args} 2>/dev/null"`,
      { timeout: 30_000, encoding: 'utf8', env: process.env }
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ─── Fetch candidate wallets ─────────────────────────────────────────────────
/**
 * Get candidate wallet addresses to evaluate.
 * Seeds come first, then smartmoney/kol pump.fun traders.
 */
async function getCandidateWallets(seedWallets = []) {
  const candidates = new Set(seedWallets.map(w => w.toLowerCase()));

  // Scan smartmoney — flippers who traded pump.fun (sell side)
  const smart = gmgnRun('track smartmoney --chain sol --limit 100 --raw');
  if (smart?.list) {
    for (const t of smart.list) {
      if (t.base_token?.launchpad === 'pump') {
        candidates.add(t.maker.toLowerCase());
      }
    }
  }

  // Scan KOL traders
  const kol = gmgnRun('track kol --chain sol --limit 100 --raw');
  if (kol?.list) {
    for (const t of kol.list) {
      candidates.add(t.maker.toLowerCase());
    }
  }

  return [...candidates];
}

// ─── Evaluate one wallet ─────────────────────────────────────────────────────
/**
 * Fetch wallet activity and find quick-flip (buy→sell in 1-10s, 5-25% net gain).
 * Returns null if < MIN_TRADES qualifying trades found.
 */
function evaluateWallet(wallet) {
  const raw = gmgnRun(
    `portfolio activity --chain sol --wallet ${wallet} --limit 100 --raw`
  );
  if (!raw) return null;

  const acts = raw.activities;
  if (!acts || !Array.isArray(acts) || acts.length === 0) return null;

  // Group by token symbol
  const byToken = new Map();
  for (const a of acts) {
    if (!['buy', 'sell'].includes(a.event_type)) continue;
    const sym = a.token?.symbol || '?';
    if (!byToken.has(sym)) byToken.set(sym, []);
    byToken.get(sym).push(a);
  }

  const qualifying = [];

  for (const [, token_acts] of byToken) {
    const buys  = token_acts.filter(a => a.event_type === 'buy')
                      .sort((a, b) => a.timestamp - b.timestamp);
    const sells = token_acts.filter(a => a.event_type === 'sell')
                      .sort((a, b) => a.timestamp - b.timestamp);

    for (const buy of buys) {
      // First sell that comes AFTER this buy
      const sellsAfter = sells.filter(s => s.timestamp > buy.timestamp);
      if (!sellsAfter.length) continue;
      const sell = sellsAfter[0];
      const dt   = sell.timestamp - buy.timestamp;
      if (dt > MAX_HOLD_S) continue;

      // quote_amount = dollar value of the trade
      const entry = parseFloat(buy.quote_amount  || 0);
      const exit_ = parseFloat(sell.quote_amount || 0);
      if (entry <= 0) continue;

      const gross  = (exit_ - entry) / entry;
      const net    = gross - FEE;
      const pnl    = entry * net;
      const netPct = net * 100;
      const isWin  = netPct >= WIN_THR_PCT && netPct <= GAIN_MAX_PCT;

      qualifying.push({
        sym: buy.token?.symbol || '?',
        dt, entry, exit_, gross, net, pnl, win: isWin,
      });
    }
  }

  if (qualifying.length < MIN_TRADES) return null;

  const wins   = qualifying.filter(t => t.win).length;
  const wr     = wins / qualifying.length * 100;
  const pnl    = qualifying.reduce((s, t) => s + t.pnl, 0);
  const losses = qualifying.filter(t => !t.win);
  const worst  = losses.length ? Math.min(...losses.map(t => t.net)) : 0;
  // Penalize wallets with catastrophic single-trade losses (>30%)
  const lossPenalty = worst < -0.30 ? 0.3 : 1.0;
  const score = wr * Math.abs(pnl) * lossPenalty;

  return { wallet, total: qualifying.length, wins, wr, pnl, worst, score, trades: qualifying };
}

// ─── Auto-add to bot watchlist ─────────────────────────────────────────────
function autoAddWallet(wallet, result, dryRun = false) {
  const chatId   = OWNER_CHAT_ID;
  const address  = wallet.toLowerCase();

  const existing = walletsDb.get(chatId, address);
  if (existing) {
    const cfg = walletsDb.getCopyConfig({ chatId, address });
    if (cfg?.copy_mode === 'mirror') return { action: 'skip', reason: 'already_mirror' };
    if (!dryRun) walletsDb.setCopyConfig({ chatId, address, copyMode: 'mirror' });
    return { action: 'update', copy_mode: 'mirror' };
  }

  if (dryRun) return { action: 'add_dry', copy_mode: 'mirror', wr: result.wr.toFixed(1) };

  walletsDb.add({ chatId, address, label: `hicarus_${result.wr.toFixed(0)}pct` });
  walletsDb.setCopyConfig({ chatId, address, copyMode: 'mirror' });
  return { action: 'add', copy_mode: 'mirror', wr: result.wr.toFixed(1) };
}

// ─── Main scan ───────────────────────────────────────────────────────────────
export async function runHicarusScan({ seedWallets = [], dryRun = true, autoAdd = true } = {}) {
  console.log('[hicarus] Starting scan…');
  const t0 = Date.now();

  const candidates = await getCandidateWallets(seedWallets);
  console.log(`[hicarus] ${candidates.length} candidate wallets`);

  const results = [];
  for (const wallet of candidates) {
    const r = evaluateWallet(wallet);
    if (r) results.push(r);
  }

  // Sort: highest WR first, then most trades, then highest score
  results.sort((a, b) => b.wr !== a.wr ? b.wr - a.wr : b.total - a.total);

  const added   = [];
  const skipped = [];

  if (autoAdd) {
    for (const r of results) {
      if (r.wr < AUTO_ADD_WR) break;
      if (r.total < MIN_TRADES) continue;
      const res = autoAddWallet(r.wallet, r, dryRun);
      if (res.action === 'add' || res.action === 'update') {
        added.push({ wallet: r.wallet, wr: r.wr, total: r.total, pnl_sol: r.pnl });
      } else if (res.action === 'skip') {
        skipped.push({ wallet: r.wallet, wr: r.wr, reason: 'already_mirror' });
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const summary = {
    timestamp: new Date().toISOString(),
    elapsed_s:  parseFloat(elapsed),
    candidates: candidates.length,
    evaluated:  results.length,
    autoAdded:  added.length,
    skipped:    skipped.length,
    topWallets: results.slice(0, 10).map(r => ({
      wallet:         r.wallet,
      wr:             parseFloat(r.wr.toFixed(2)),
      total:          r.total,
      wins:           r.wins,
      pnl_sol:        parseFloat(r.pnl.toFixed(6)),
      worst_loss_pct: parseFloat((r.worst * 100).toFixed(2)),
      score:          parseFloat(r.score.toFixed(4)),
    })),
    addedWallets:   added,
    skippedWallets: skipped,
  };

  console.log(`[hicarus] Done in ${elapsed}s | ${results.length} evaluated | ${added.length} added`);
  return summary;
}

// ─── Notify via Telegram ────────────────────────────────────────────────────
export async function notifyHicarusResult(summary, chatId) {
  const lines = [
    `🟢 <b>Hicarus Scan Complete</b>`,
    `⏱ ${summary.elapsed_s}s | ${summary.candidates} candidates | ${summary.evaluated} evaluated`,
    ``,
  ];

  if (summary.addedWallets.length > 0) {
    lines.push(`✅ <b>Auto-added ${summary.addedWallets.length} wallets (WR ≥ ${AUTO_ADD_WR}%)</b>`);
    for (const w of summary.addedWallets) {
      lines.push(`  • ${w.wallet.slice(0, 16)}… | WR ${w.wr}% | ${w.total} trades`);
    }
    lines.push('');
  }

  lines.push(`🏆 <b>Top Wallets</b>`);
  for (const r of summary.topWallets.slice(0, 5)) {
    const flag = r.wr >= AUTO_ADD_WR ? '✅' : '  ';
    lines.push(
      `${flag} ${r.wallet.slice(0, 14)}… | WR ${r.wr}% | ${r.total} trades | ` +
      `PnL ${r.pnl_sol >= 0 ? '+' : ''}${r.pnl_sol.toFixed(4)} SOL`
    );
  }

  await notifier.notifyOne(chatId, lines.join('\n'));
}
