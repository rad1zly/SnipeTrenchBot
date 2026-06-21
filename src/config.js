// src/config.js
// =============================================================================
// Centralized configuration loader. Reads .env, validates required fields, and
// exposes a frozen `config` object for the rest of the app. Anything that needs
// configuration imports from here — no module reads process.env directly.
//
// v0.3.0: the bot's trading private key is NO LONGER read from .env. The
// key is set via Telegram (/start → 🔑 Wallet) and stored AES-256-GCM
// encrypted in the SQLite `wallet` table. See walletManager.js.
// =============================================================================

import 'dotenv/config';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function envBool(key, def) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  return v.toLowerCase() === 'true' || v === '1';
}

function envInt(key, def) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    console.warn(`[config] ${key} is not an integer ("${v}"), using default ${def}`);
    return def;
  }
  return n;
}

function envFloat(key, def) {
  const v = process.env[key];
  if (v == null || v === '') return def;
  const n = parseFloat(v);
  if (Number.isNaN(n)) {
    console.warn(`[config] ${key} is not a number ("${v}"), using default ${def}`);
    return def;
  }
  return n;
}

function envString(key, def) {
  const raw = process.env[key];
  if (raw == null || raw === '') return def;
  // B64: prefix → decode. Lets the user encode secrets in .env to avoid
  // chat/IDE leak risk without losing plaintext readability. Decoded value
  // is what the rest of the app uses.
  if (raw.startsWith('B64:')) {
    try {
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    } catch (e) {
      console.warn(`[config] ${key} has B64: prefix but failed to decode: ${e.message}`);
      return def;
    }
  }
  return raw;
}

// Derive SOLANA_RPC_URL with this priority:
//   1. Explicit SOLANA_RPC_URL in .env (overrides everything)
//   2. Helius mainnet RPC + api-key (charon/meridian pattern) — fast, no rate limit
//   3. Public Solana RPC fallback (slow, rate-limited)
function deriveSolanaRpcUrl() {
  const explicit = envString('SOLANA_RPC_URL', '');
  if (explicit) return explicit;
  const heliusKey = envString('HELIUS_API_KEY', '');
  if (heliusKey) return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  return 'https://api.mainnet-beta.solana.com';
}

const config = {
  // ---------------------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------------------
  DRY_RUN: envBool('DRY_RUN', true),
  MAX_SOL_PER_TRADE: envFloat('MAX_SOL_PER_TRADE', 0.01),
  SLIPPAGE_BPS: envInt('SLIPPAGE_BPS', 500),
  HOLD_MS: envInt('HOLD_MS', 1000),
  DAILY_LOSS_CAP_SOL: envFloat('DAILY_LOSS_CAP_SOL', 0.05),

  // ---------------------------------------------------------------------------
  // Telegram
  // ---------------------------------------------------------------------------
  // TELEGRAM_BOT_TOKEN is required. TELEGRAM_CHAT_ID is NOT — the bot uses a
  // multi-subscriber model: anyone who /start's is auto-added via the
  // subscribeMiddleware in telegramBot.js. The first /start becomes a
  // subscriber and receives broadcasts. /stop to unsubscribe.
  TELEGRAM_BOT_TOKEN: envString('TELEGRAM_BOT_TOKEN', ''),
  TELEGRAM_BOT_TOKENS: envString('TELEGRAM_BOT_TOKENS', ''), // M1.5: comma-separated for multi-bot
  TELEGRAM_CHAT_ID: envString('TELEGRAM_CHAT_ID', ''), // legacy/unused, kept for back-compat
  // M1.5: derived list — prefers TELEGRAM_BOT_TOKENS (csv) over single TELEGRAM_BOT_TOKEN.
  get TELEGRAM_BOT_TOKEN_LIST() {
    const multi = this.TELEGRAM_BOT_TOKENS.split(',').map((t) => t.trim()).filter(Boolean);
    if (multi.length > 0) return multi;
    if (this.TELEGRAM_BOT_TOKEN) return [this.TELEGRAM_BOT_TOKEN];
    return [];
  },

  // ---------------------------------------------------------------------------
  // Solana RPC
  // ---------------------------------------------------------------------------
  SOLANA_RPC_URL: deriveSolanaRpcUrl(),
  HELIUS_API_KEY: envString('HELIUS_API_KEY', ''),

  // ---------------------------------------------------------------------------
  // Jito tip (admin / fixed config — v0.8.8 experimental M1.20)
  // ---------------------------------------------------------------------------
  // Jito tips are a per-process fixed value (not per-user setting). Reference
  // bot (the one user is cloning) ships with a fixed tip amount, so users
  // don't need to tune it via the menu. Set JITO_BUY_TIP_SOL / JITO_SELL_TIP_SOL
  // in .env to override. Default = 0.001 SOL (1_000_000 lamports) for both.
  JITO_BUY_TIP_SOL: (() => {
    const v = Number(process.env.JITO_BUY_TIP_SOL ?? '0.001');
    return Number.isFinite(v) && v >= 0 ? v : 0.001;
  })(),
  JITO_SELL_TIP_SOL: (() => {
    const v = Number(process.env.JITO_SELL_TIP_SOL ?? '0.001');
    return Number.isFinite(v) && v >= 0 ? v : 0.001;
  })(),

  // ---------------------------------------------------------------------------
  // Bot trading wallet — REMOVED in v0.3.0
  // ---------------------------------------------------------------------------
  // The private key is now set via Telegram (see /start → 🔑 Wallet) and
  // stored encrypted in the DB. There is intentionally no `BOT_WALLET_PRIVATE_KEY`
  // field on this config object. If you have one in your .env, it is
  // silently ignored. (We do not log a warning, to keep the startup
  // output clean for users who copy the old .env.example by mistake.)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Wallet encryption pepper
  // ---------------------------------------------------------------------------
  // WALLET_PEPPER is optional. Combined with the machine-id, it derives the
  // AES-256-GCM key that encrypts your trading wallet at rest.
  //   - Set it if you want the bot's wallet to be portable across machines
  //     (e.g. you move the DB to a new VPS).
  //   - Leave it empty and the key is bound to the machine-id only — the
  //     wallet can only be decrypted on the same host.
  // Generate one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Treat it like any other secret.
  WALLET_PEPPER: envString('WALLET_PEPPER', ''),

  // ---------------------------------------------------------------------------
  // Jupiter
  // ---------------------------------------------------------------------------
  JUPITER_API_URL: envString('JUPITER_API_URL', 'https://quote-api.jup.ag/v6'),
  JUPITER_API_KEY: envString('JUPITER_API_KEY', ''),
  PRIORITY_FEE_MICROLAMPORTS: envInt('PRIORITY_FEE_MICROLAMPORTS', 0),

  // ---------------------------------------------------------------------------
  // Monitoring
  // ---------------------------------------------------------------------------
  POLL_INTERVAL_MS: envInt('POLL_INTERVAL_MS', 5000),
  HELIUS_TX_LIMIT: envInt('HELIUS_TX_LIMIT', 10),
  // v0.7.0: per-second rate cap for Helius Enhanced Tx API.
  // Free tier = 10 rps; we use 10 (no headroom margin — bump if you have paid).
  HELIUS_RPS: envInt('HELIUS_RPS', 10),
  ONLY_NEW_TOKENS: envBool('ONLY_NEW_TOKENS', true),

  // ---------------------------------------------------------------------------
  // v0.8.8 (experimental) M4.0: Multi-lane tip routing.
  // 4 lanes: jito, 0slot, helius (Sender), astralane (Iris). All accept a
  // Jito-style tip ix; the difference is the submission endpoint. When the
  // primary lane is congested, fall back to the next.
  //
  //   TIP_LANE_PRIMARY=jito              # which lane to try first
  //   TIP_LANE_FALLBACKS=helius,0slot,astralane   # fallbacks in order
  //   TIP_LANE_TIMEOUT_MS=8000           # per-lane wait before fallback
  //   JITO_TIP_ACCOUNTS=96gYZGLn...,HFqU5x6...,Cw8CFyM9...  # CSV
  //   HELIUS_SENDER_URL=https://sender.helius-rpc.com/fast
  //   ZERO_SLOT_URL=https://ny.0slot.trade
  //   ZERO_SLOT_TIP_ACCOUNTS=Eb2KpSC8q...
  //   ASTRALANE_IRIS_URL=https://iris.astralane.io/submit
  //   ASTRALANE_TIP_ACCOUNTS=astra4yeMcH8gB3QYU7ihPocyFaALo1cK8tcGmYjJmQ
  // ---------------------------------------------------------------------------
  TIP_LANE_PRIMARY: envString('TIP_LANE_PRIMARY', 'jito'),
  TIP_LANE_FALLBACKS: envString('TIP_LANE_FALLBACKS', 'helius,0slot,astralane'),
  TIP_LANE_TIMEOUT_MS: envInt('TIP_LANE_TIMEOUT_MS', 8000),
  JITO_TIP_ACCOUNTS: envString('JITO_TIP_ACCOUNTS', '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5,HFqU5x63VTqvQss8hp11i4wV8RH1T5ELA4Q8B42K3d3S,Cw8CFyM9EkoDy76U5Q9YY3pXTjLPgUaW7Y3HLL7n8GHe'),
  HELIUS_SENDER_URL: envString('HELIUS_SENDER_URL', 'https://sender.helius-rpc.com/fast'),
  ZERO_SLOT_URL: envString('ZERO_SLOT_URL', 'http://ny.0slot.trade'),
  ZERO_SLOT_TIP_ACCOUNTS: envString('ZERO_SLOT_TIP_ACCOUNTS', 'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3,FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe,ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13,6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK,Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr'),
  ZERO_SLOT_API_KEY: envString('ZERO_SLOT_API_KEY', ''),
  ASTRALANE_IRIS_URL: envString('ASTRALANE_IRIS_URL', 'https://fr.gateway.astralane.io/iris'),
  ASTRALANE_TIP_ACCOUNTS: envString('ASTRALANE_TIP_ACCOUNTS', 'astra4yeMcH8gB3QYU7ihPocyFaALo1cK8tcGmYjJmQ'),
  ASTRALANE_API_KEY: envString('ASTRALANE_API_KEY', ''),

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  SOL_MINT: 'So11111111111111111111111111111111111111112',
  WSOL_MINT: 'So11111111111111111111111111111111111111112',
  USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  LAMPORTS_PER_SOL: 1_000_000_000,
};

// =============================================================================
// Validation
// =============================================================================
const warnings = [];
const errors = [];

if (!config.TELEGRAM_CHAT_ID) {
  // Multi-user: not fatal. Anyone who /start'd gets broadcasts. If nobody has
  // /start'd yet, notifications just echo to console.
  warnings.push("TELEGRAM_CHAT_ID is empty — bot is in multi-user mode; notifications broadcast to everyone who /start'd.");
}
if (!config.HELIUS_API_KEY) {
  warnings.push('HELIUS_API_KEY is empty — wallet monitoring will fail. Get one at https://helius.dev.');
}
if (config.DRY_RUN) {
  warnings.push('DRY_RUN=true — bot will log actions but NOT submit transactions. Safe mode.');
}
// v0.3.0: the trading key is no longer validated here. Set the wallet via
// /start → 🔑 Wallet. If LIVE mode and no wallet is set, the executor
// emits its own warning at init time and fails at first trade with a
// readable error pointing the user to /wallet.
if (config.SLIPPAGE_BPS > 3000) {
  warnings.push(`SLIPPAGE_BPS=${config.SLIPPAGE_BPS} is very high (>30%). Are you sure?`);
}
if (config.MAX_SOL_PER_TRADE > 0.5) {
  warnings.push(`MAX_SOL_PER_TRADE=${config.MAX_SOL_PER_TRADE} is large. Trade carefully.`);
}

config._warnings = warnings;
config._errors = errors;
config._valid = errors.length === 0;

export default Object.freeze(config);

// Helper: re-export the validation result for index.js to consume.
export const validation = Object.freeze({
  warnings: [...warnings],
  errors: [...errors],
  valid: errors.length === 0,
});

// Helper: load Keypair from private key (Base58 or JSON array).
// Throws on invalid input. Callers handle the error.
export function loadKeypair(privateKeyStr) {
  const trimmed = privateKeyStr.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  // Default: Base58
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}
