// src/pumpfun.js
// =============================================================================
// Direct pump.fun bonding-curve swap. Bypasses Jupiter for tokens still in
// the bonding curve (pre-graduation). Faster than Jupiter v1 because:
//   - 1 program call vs Jupiter's multi-hop routing
//   - No HTTP API call (Jupiter quote + build takes 200-400ms each)
//   - Local compute via constant-product formula
//
// Trade-off: only works for tokens still in pump.fun's bonding curve.
// After graduation (~$69k market cap), tokens migrate to Raydium and
// require Jupiter or Raydium SDK. We detect graduation by reading the
// `complete` flag from the bonding curve account.
//
// v0.8.0 (June 2026).
// =============================================================================

import web3 from '@solana/web3.js';
const { Connection, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } = web3;
// Some constants don't survive CJS->ESM interop cleanly. Hardcode them.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
// v0.8.3: May 2026 pump.fun upgrade uses Token-2022 for the base mint
// (default in @pump-fun/pump-sdk 1.36.0). Old programs used regular Token.
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pumpSdk = require('@pump-fun/pump-sdk');
import config from './config.js';

// Pump.fun program constants (from on-chain IDL)
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const GLOBAL_PDA = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeQHcc7eCS78PTWa1W7U53NDeFDQUhM3bj1bpm8');

// v0.8.0 (post pump.fun May 2026 program upgrade): new program accounts required.
// Pump.fun added 0.05% creator fee + buyback fee recipient + volume accumulators.
// Omitting them = AnchorError 6062 (BuybackFeeRecipientMissing).
// Source: Based-LTD/prooflaunch/src/services/pumpfun.ts (production bot, May 2026)
const PUMP_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

// 8 buyback fee recipients (from @pump-fun/pump-sdk CURRENT_FEE_RECIPIENTS_FOR_BUYBACK)
// One is picked at random per buy, matching SDK behavior.
const BUYBACK_FEE_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
  '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL',
  '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6',
  'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD',
  'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW',
].map((a) => new PublicKey(a));
const BUYBACK_FEE_RECIPIENT = BUYBACK_FEE_RECIPIENTS[0];  // default (deterministic for tests)

// Pump.fun fee = 100 bps (1%) on buy/sell
// Creator fee on sell = 50 bps (0.5%) routed to token creator
const PROTOCOL_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10000n;

// Bonding curve account layout (after 8-byte discriminator):
//   0..8   : virtualTokenReserves (u64)
//   8..16  : virtualSolReserves (u64)
//   16..24 : realTokenReserves (u64)
//   24..32 : realSolReserves (u64)
//   32..40 : tokenTotalSupply (u64)
//   40..41 : complete (bool)
const BC_LAYOUT = {
  virtualTokenReserves: { offset: 8, size: 8 },
  virtualSolReserves: { offset: 16, size: 8 },
  realTokenReserves: { offset: 24, size: 8 },
  realSolReserves: { offset: 32, size: 8 },
  tokenTotalSupply: { offset: 40, size: 8 },
  complete: { offset: 48, size: 1 },
  // v0.8.0: creator Pubkey (32 bytes) at offset 49. Required for creator-vault PDA.
  creator: { offset: 49, size: 32 },
  // v0.8.6.3: is_mayhem_mode (bool, 1 byte) at offset 81 (after 8 disc + 5×u64 + 1 bool + 32 creator).
  // Required to pick the correct fee_recipient set for mayhem-mode tokens.
  isMayhemMode: { offset: 81, size: 1 },
};

// v0.8.3: pump.fun May 2026 program upgrade renamed/added BuyV2 & SellV2 instructions.
// The old Buy/Sell discriminators (0x66063d12... / 0x33e685a4...) now hit
// AccountNotInitialized (3012) on the bonding-curve ATA for fresh tokens
// (see test logs 2026-06-19). Use BuyV2 / SellV2 via @pump-fun/pump-sdk 1.36.0.
// Old discriminators are kept commented for forensics only.
// const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
// const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
// Singleton PumpSdk instance — the SDK uses `this.offlinePumpProgram`
// internally so we can't just call prototype methods. No connection needed
// for the offline builders; the SDK ships with its own IDL.
const _pumpSdkInstance = new pumpSdk.PumpSdk();

// In-memory cache of bonding-curve state. Mint graduates after ~$69k mcap;
// once `complete=true`, cache is invalidated.
const BC_CACHE = new Map();  // mint -> { state, cachedAt }
const BC_TTL_MS = 5_000;  // 5s — bonding curve state changes constantly during buys

let _connection = null;
function getConnection() {
  if (!_connection) {
    _connection = new Connection(config.SOLANA_RPC_URL, 'processed');
  }
  return _connection;
}

// -----------------------------------------------------------------------------
// PDA derivation
// -----------------------------------------------------------------------------
export function findBondingCurve(mint) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), m.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  )[0];
}

export function findBondingCurveAta(mint) {
  const bc = findBondingCurve(mint);
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  // v0.8.5: use TOKEN_2022_PROGRAM_ID for BC's token ATA (V2 era uses Token-2022 for all base mints)
  // Old V1 used regular TOKEN_PROGRAM_ID but that fails 3012 on fresh V2 tokens
  // (verified via simulation 2026-06-19 20:40 GMT+8)
  return PublicKey.findProgramAddressSync(
    [bc.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function findUserAta(user, mint) {
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  return PublicKey.findProgramAddressSync(
    [u.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

// -----------------------------------------------------------------------------
// Bonding curve state read (cached for BC_TTL_MS)
// -----------------------------------------------------------------------------
export async function getBondingCurveState(mint) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const cacheKey = m.toBase58();
  const cached = BC_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < BC_TTL_MS) {
    return cached.state;
  }
  const bc = findBondingCurve(m);
  const conn = getConnection();
  const info = await conn.getAccountInfo(bc);
  if (!info) {
    throw new Error(`bonding curve not found for mint ${cacheKey} (token not on pump.fun?)`);
  }
  const data = info.data;
  const state = {
    virtualTokenReserves: readU64(data, BC_LAYOUT.virtualTokenReserves.offset),
    virtualSolReserves: readU64(data, BC_LAYOUT.virtualSolReserves.offset),
    realTokenReserves: readU64(data, BC_LAYOUT.realTokenReserves.offset),
    realSolReserves: readU64(data, BC_LAYOUT.realSolReserves.offset),
    tokenTotalSupply: readU64(data, BC_LAYOUT.tokenTotalSupply.offset),
    complete: data[BC_LAYOUT.complete.offset] === 1,
    // v0.8.0: parse creator Pubkey for creator-vault PDA derivation.
    creator: new PublicKey(data.slice(BC_LAYOUT.creator.offset, BC_LAYOUT.creator.offset + 32)).toBase58(),
    // v0.8.6.3: parse is_mayhem_mode for fee_recipient selection.
    isMayhemMode: data[BC_LAYOUT.isMayhemMode.offset] === 1,
  };
  BC_CACHE.set(cacheKey, { state, cachedAt: Date.now() });
  return state;
}

function readU64(buf, offset) {
  // Use BigInt to handle 64-bit unsigned values
  return buf.readBigUInt64LE(offset);
}

// v0.8.0: derive PDAs required by the new pump.fun instruction format.
// All seeds verified against @pump-fun/pump-sdk (May 2026 release).
function findCreatorVault(creator) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  )[0];
}
function findEventAuthority() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_FUN_PROGRAM_ID
  )[0];
}
function findFeeConfig() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_FUN_PROGRAM_ID.toBuffer()],
    PUMP_FEE_PROGRAM_ID
  )[0];
}
function findBondingCurveV2(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  )[0];
}
function findGlobalVolumeAccumulator() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_FUN_PROGRAM_ID
  )[0];
}
function findUserVolumeAccumulator(user) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  )[0];
}

export function invalidateBondingCurveCache(mint) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  BC_CACHE.delete(m.toBase58());
}

// -----------------------------------------------------------------------------
// Quote: compute expected output using constant-product formula
// -----------------------------------------------------------------------------
function computeBuyQuote(virtualSolReserves, virtualTokenReserves, solAmountLamports) {
  // After 1% protocol fee, the effective input is (solAmount * 9900 / 10000)
  const amountAfterFee = (solAmountLamports * (BPS_DENOMINATOR - PROTOCOL_FEE_BPS)) / BPS_DENOMINATOR;
  if (amountAfterFee <= 0n) {
    return { tokensOut: 0n, priceImpact: 100 };
  }
  // x * y = k  =>  new_sol = virtual_sol + amount_after_fee
  //           =>  new_tokens = k / new_sol
  //           =>  tokens_out = virtual_tokens - new_tokens
  const k = virtualSolReserves * virtualTokenReserves;
  const newSol = virtualSolReserves + amountAfterFee;
  const newTokens = k / newSol;
  const tokensOut = virtualTokenReserves - newTokens;
  // Price impact %: (effective - spot) / spot * 100
  const spotPrice = (virtualSolReserves * BPS_DENOMINATOR) / virtualTokenReserves;  // lamports per 1 token (raw)
  const effectivePrice = (solAmountLamports * BPS_DENOMINATOR) / tokensOut;
  const priceImpactBps = effectivePrice > spotPrice
    ? Number(((effectivePrice - spotPrice) * 10000n) / spotPrice) / 100
    : 0;
  return {
    tokensOut,
    priceImpact: priceImpactBps,
    solAfterFee: amountAfterFee,
  };
}

function computeSellQuote(virtualSolReserves, virtualTokenReserves, tokenRawAmount) {
  // After 1% protocol fee + 0.5% creator fee on sell, effective is (amount * 9850 / 10000)
  const PROTOCOL_FEE = 100n;
  const CREATOR_FEE = 50n;
  const amountAfterFee = (tokenRawAmount * (BPS_DENOMINATOR - PROTOCOL_FEE - CREATOR_FEE)) / BPS_DENOMINATOR;
  if (amountAfterFee <= 0n) {
    return { solOut: 0n, priceImpact: 100 };
  }
  // x * y = k  =>  new_tokens = virtual_tokens + amount_after_fee
  //           =>  new_sol = k / new_tokens
  //           =>  sol_out = virtual_sol - new_sol
  const k = virtualSolReserves * virtualTokenReserves;
  const newTokens = virtualTokenReserves + amountAfterFee;
  const newSol = k / newTokens;
  const solOut = virtualSolReserves - newSol;
  // Apply 1% protocol fee on SOL out as well
  const solAfterFee = (solOut * (BPS_DENOMINATOR - PROTOCOL_FEE)) / BPS_DENOMINATOR;
  return {
    solOut: solAfterFee,
    priceImpact: 0,  // TODO compute properly
  };
}

// -----------------------------------------------------------------------------
// Public quote API — matches Jupiter interface so executor can swap freely
// -----------------------------------------------------------------------------

/**
 * Get buy quote: how many tokens will we get for X SOL?
 * @param {Object} args
 * @param {number|bigint} args.solAmount  - SOL amount in lamports (number) or SOL (auto-detect)
 * @param {string|PublicKey} args.outputMint
 * @param {number} args.slippageBps
 * @returns {Promise<Object>} - Jupiter-shaped quote response
 */
export async function getBuyQuote({ solAmount, outputMint, slippageBps = 500 }) {
  const state = await getBondingCurveState(outputMint);
  if (state.complete) {
    throw new Error(`Token ${outputMint.toString()} has graduated pump.fun bonding curve. Use Jupiter.`);
  }
  // solAmount is in SOL (decimal). Convert to lamports.
  const solLamports = typeof solAmount === 'bigint'
    ? solAmount * 1_000_000_000n
    : BigInt(Math.floor(solAmount * 1e9));
  const { tokensOut, priceImpact, solAfterFee } = computeBuyQuote(
    state.virtualSolReserves, state.virtualTokenReserves, solLamports
  );
  // max_sol_cost = solLamports * (10000 + slippageBps) / 10000
  const maxSolCost = (solLamports * BigInt(10000 + slippageBps)) / 10000n;
  // v0.8.6.6: min_tokens_out = tokensOut * (10000 - slippageBps) / 10000
  // BuyExactSolIn on-chain REQUIRES min_tokens_out as slippage floor.
  // Old code: otherAmountThreshold = tokensOut (no slippage applied) →
  //   any price movement between quote and execute → 6042 buySlippageBelowMinTokensOut
  // Confirmed live failure: 2026-06-19 15:50Z, mint FCZ9Ej...pump, mayhem mode.
  const minTokensOut = (tokensOut * BigInt(10000 - slippageBps)) / 10000n;
  return {
    inputMint: config.SOL_MINT,
    outputMint: outputMint.toString(),
    inAmount: solLamports.toString(),
    outAmount: tokensOut.toString(),
    otherAmountThreshold: minTokensOut.toString(),  // min tokens we'll accept (with slippage)
    slippageBps,
    priceImpactPct: String(priceImpact),
    _pumpfun: true,  // marker for executor to call pumpfun builder
    _maxSolCost: maxSolCost.toString(),
    _minTokensOut: minTokensOut.toString(),  // v0.8.6.6: explicit min for buildBuyInstruction
    _virtualSolReserves: state.virtualSolReserves.toString(),
    _virtualTokenReserves: state.virtualTokenReserves.toString(),
    _creator: state.creator,  // v0.8.4: needed for creator-vault PDA (BUG: missing in v0.8.0–v0.8.3 — caused Anchor 2006 ConstraintSeeds error on BuyV2)
    _isMayhem: state.isMayhemMode,  // v0.8.6.3: needed to pick correct fee_recipient set
  };
}

export async function getSellQuote({ tokenRawAmount, inputMint, slippageBps = 500 }) {
  const state = await getBondingCurveState(inputMint);
  if (state.complete) {
    throw new Error(`Token ${inputMint.toString()} has graduated pump.fun bonding curve. Use Jupiter.`);
  }
  const tokenAmount = typeof tokenRawAmount === 'bigint'
    ? tokenRawAmount
    : BigInt(tokenRawAmount);
  const { solOut, priceImpact } = computeSellQuote(
    state.virtualSolReserves, state.virtualTokenReserves, tokenAmount
  );
  // min_sol_output = solOut * (10000 - slippageBps) / 10000
  const minSolOutput = (solOut * BigInt(10000 - slippageBps)) / 10000n;
  return {
    inputMint: inputMint.toString(),
    outputMint: config.SOL_MINT,
    inAmount: tokenAmount.toString(),
    outAmount: solOut.toString(),
    otherAmountThreshold: minSolOutput.toString(),  // min SOL we'll accept
    slippageBps,
    priceImpactPct: String(priceImpact),
    _pumpfun: true,
    _minSolOutput: minSolOutput.toString(),
    _creator: state.creator,  // v0.8.0: needed for creator-vault PDA
    _isMayhem: state.isMayhemMode,  // v0.8.6.3: needed to pick correct fee_recipient set
  };
}

// -----------------------------------------------------------------------------
// Build swap transaction (v0.8.5 — HANDCRAFTED, on-chain verified discriminators)
// -----------------------------------------------------------------------------
// v0.8.5 LESSON (2026-06-19):
// The on-chain pump.fun program uses DIFFERENT discriminators than what
// @pump-fun/pump-sdk 1.36.0's bundled IDL says. Verified via user-shared
// working BUY tx on mint GTyGKtvxDgMJuLwEPyniqMpL1nDgPHB1CbPDMECspump:
//   - On-chain working instruction: "BuyExactSolIn" with disc 3efc1d45aa6a74dc
//   - SDK IDL says: BuyExactSolIn disc 38fc74089edfcd5f (FUTURE/published but not yet on-chain)
//   - On-chain working sell: V1 "sell" disc 33e685a4017f83ad (still works post-upgrade)
//   - SDK 1.36.0's BuyV2/SellV2 (b817ee6167c5d33d / 5df6823ce7e940b2) FAIL on-chain
//     with NotAuthorized 6000 (mayhem mode tokens) or AccountNotInitialized 3012
//     (non-mayhem fresh tokens — bc ATA not pre-initialized by V2 program).
//
// Key changes from v0.8.0 → v0.8.5:
//   - Use on-chain verified discriminators, not SDK IDL
//   - Use ROTATING fee recipients (8 random) + ROTATING buyback recipients
//     (8 random) — pump.fun picks one per tx
//   - Use Token-2022 program (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) for
//     user's base token ATA (V2 era)
//   - 18 accounts (vs v0.8.0's 18 — same count, correct order)
//   - UserAta derived with TOKEN_2022_PROGRAM_ID (not regular TOKEN_PROGRAM_ID)
//
// Source of truth: Solscan tx 2uPG4WPRYkjo2RfLf5KM6jYqyhXZXCEx4H5GBFQpyXjX
// (user-provided, 2026-06-19 12:22Z, "BuyExactSolIn" worked on-chain)

// 8 fee recipients (rotating, from @pump-fun/pump-sdk CURRENT_FEE_RECIPIENTS)
const FEE_RECIPIENTS = [
  '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV',
  '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
  '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX',
  '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz',
  'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY',
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM',
  'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz',
  'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP',
].map((a) => new PublicKey(a));

// v0.8.6.3: For MAYHEM-mode tokens, the on-chain program requires fee_recipient
// to be from `reserved_fee_recipients` array (7 pubkeys) + `reserved_fee_recipient`
// (single). Using `fee_recipients` for mayhem tokens triggers NotAuthorized 6000
// at programs/pump/src/fee_recipient.rs:19. Verified on-chain 2026-06-19 23:00 GMT+8:
// building buy with fee_recipient from FEE_RECIPIENTS for mayhem token
// 7Zg4GGUE18sTBZg6t68gRcJEzWFdApXymHnyTg6Dpump fails with NotAuthorized 6000.
const RESERVED_FEE_RECIPIENTS = [
  '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6',
  '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH',
  '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6',
  'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq',
  '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA',
].map((a) => new PublicKey(a));
const RESERVED_FEE_RECIPIENT = new PublicKey('GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS');  // single, from Global.reserved_fee_recipient

// On-chain verified discriminators
// v0.8.5 history:
//   - BuyExactSolIn disc (3efc1d45aa6a74dc) from user-shared tx — FAILED (Fallback 101)
//   - V1 'buy' disc (66063d12...) — WORKED on-chain for non-mayhem mints (2026-06-19 20:45 GMT+8)
//   - V1 'sell' disc (33e685a4...) — FAILED (AccountOwnedByWrongProgram — V1 sell expects regular Token program mint, but V2 mints are Token-2022)
//   - SellV2 disc (5df6823ce7e940b2) — TESTING (per IDL, but also failed earlier with NotAuthorized 6000 — may have been a mayhem-mode issue)
// v0.8.6.3 (REVISED 2026-06-19 23:00 GMT+8): The on-chain working BUY
// instruction is BuyExactSolIn with discriminator 38fc74089edfcd5f (= sha256
// "global:BuyExactSolIn" first 8 bytes — the IDL-published disc). The earlier
// "3efc1d45aa6a74dc" was an incorrect decoding of a user-shared tx. The V1
// "buy" disc (66063d12...) was being used by the bot but is REJECTED on-chain
// for mayhem-mode tokens (NotAuthorized 6000 at fee_recipient.rs:19).
//
// Blueprint user gave us (GTyGK...pump, on-chain verified slot 427262863):
//   disc 38fc74089edfcd5f  →  "Instruction: BuyExactSolIn" → OK
//   19 accounts including PUMP_FEE_PROGRAM (pfeeUxB6...) and bcAta as Token-2022 ATA
//   trackVolume OptionBool = 1 (Some(true)) — needed for current program
//   Use SDK IDL account layout, NOT custom 18-account legacy V1 layout
const BUY_V1_DISC = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);  // legacy V1 'buy' — works non-mayhem, REJECTED for mayhem
const BUY_EXACT_SOL_IN_DISC = Buffer.from([0x38, 0xfc, 0x74, 0x08, 0x9e, 0xdf, 0xcd, 0x5f]);  // IDL BuyExactSolIn — VERIFIED on-chain for mayhem
const SELL_V1_DISC = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);  // V1 'sell' — FAILED for Token-2022
const SELL_V2_DISC = Buffer.from([0x5d, 0xf6, 0x82, 0x3c, 0xe7, 0xe9, 0x40, 0xb2]);  // V2 'sell' — TESTING

// Pick a random fee recipient (matches pump.fun behavior: each tx uses one)
// v0.8.6.3: For MAYHEM tokens, pick from RESERVED_FEE_RECIPIENTS (Global.reserved_fee_recipients).
// For non-mayhem, pick from FEE_RECIPIENTS (Global.fee_recipients).
function pickFeeRecipient(isMayhem = false) {
  if (isMayhem) {
    const all = [...RESERVED_FEE_RECIPIENTS, RESERVED_FEE_RECIPIENT];
    return all[Math.floor(Math.random() * all.length)];
  }
  return FEE_RECIPIENTS[Math.floor(Math.random() * FEE_RECIPIENTS.length)];
}
function pickBuybackRecipient() {
  return BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)];
}

function buildBuyInstruction({ mint, user, tokenAmount, maxSolCost, creator, isMayhem = false }) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  const bc = findBondingCurve(m);
  const bcAta = findBondingCurveAta(m);
  // CRITICAL: userAta uses TOKEN_2022 (V2 era) — derived from user + Token-2022 + mint
  const userAta = PublicKey.findProgramAddressSync(
    [u.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
  const creatorKey = creator ? new PublicKey(creator) : new PublicKey('11111111111111111111111111111111');
  const creatorVault = findCreatorVault(creatorKey);
  // v0.8.6.3: For mayhem-mode tokens, use RESERVED_FEE_RECIPIENTS (required by
  // on-chain program). For non-mayhem, use regular FEE_RECIPIENTS.
  const feeRecipient = pickFeeRecipient(isMayhem);
  const buybackRecipient = pickBuybackRecipient();

  // v0.8.6.3: Use BuyExactSolIn disc (38fc74089edfcd5f) which is verified
  // on-chain for mayhem-mode tokens. Earlier V1 'buy' disc (66063d12...) is
  // rejected for mayhem with NotAuthorized 6000. Blueprint on-chain verified:
  //   sig 2uPG4WPRYkjo2RfLf5KM6jYqyhXZXCEx4H5GBFQpyXjXyeZSy86QYRREYebUk6ToHkk1Ga4Rxr1DSEzfQTtmKwEJ
  //   mint GTyGKtvxDgMJuLwEPyniqMpL1nDgPHB1CbPDMECspump, slot 427262863
  //
  // Data layout (BuyExactSolIn per IDL): disc(8) + spendable_sol_in(u64) + min_tokens_out(u64) + trackVolume(OptionBool) = 25 bytes
  // OptionBool: 0x00=None, 0x01 + bool=Some(true/false). Blueprint uses 0x01.
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_EXACT_SOL_IN_DISC.copy(data, 0);                 // v0.8.6.3: IDL BuyExactSolIn disc
  data.writeBigUInt64LE(BigInt(maxSolCost), 8);        // spendable_sol_in (max SOL to spend)
  data.writeBigUInt64LE(BigInt(tokenAmount), 16);      // min_tokens_out
  data.writeUInt8(1, 24);                              // trackVolume = Some(true) [0x01] — per blueprint

  // 19-account layout per blueprint (verified on-chain for mayhem tokens):
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },                       // [0]  Global PDA
      { pubkey: feeRecipient, isSigner: false, isWritable: true },                      // [1]  fee recipient (rotating)
      { pubkey: m, isSigner: false, isWritable: false },                                // [2]  mint
      { pubkey: bc, isSigner: false, isWritable: true },                                // [3]  bonding curve
      { pubkey: bcAta, isSigner: false, isWritable: true },                             // [4]  BC's Token-2022 ATA
      { pubkey: userAta, isSigner: false, isWritable: true },                           // [5]  user's Token-2022 ATA
      { pubkey: u, isSigner: true, isWritable: true },                                  // [6]  user (signer)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },          // [7]  system program
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },            // [8]  token-2022 program
      { pubkey: creatorVault, isSigner: false, isWritable: true },                      // [9]  creator vault
      { pubkey: findEventAuthority(), isSigner: false, isWritable: false },             // [10] event authority
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },              // [11] pump-fun program (CPI self)
      { pubkey: findGlobalVolumeAccumulator(), isSigner: false, isWritable: false },    // [12] global vol acc
      { pubkey: findUserVolumeAccumulator(u), isSigner: false, isWritable: true },      // [13] user vol acc
      { pubkey: findFeeConfig(), isSigner: false, isWritable: false },                  // [14] fee config
      { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },              // [15] pump fee program
      { pubkey: findBondingCurveV2(m), isSigner: false, isWritable: false },            // [16] bonding-curve-v2 PDA (verified [bonding-curve-v2, mint] under PUMP)
      { pubkey: buybackRecipient, isSigner: false, isWritable: true },                  // [17] buyback recipient (rotating)
    ],
    data,
  });
}

async function buildSellInstruction({ mint, user, tokenAmount, minSolOutput, creator, isMayhem = false }) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  // v0.8.5: Use SDK V2 sell (getSellV2InstructionRaw) — the V1 sell disc
  // (33e685a4...) fails on-chain for Token-2022 mints with 3007
  // AccountOwnedByWrongProgram. V2 sell uses base/quote model and works.
  // ON-CHAIN VERIFIED: sig THBMzv8UZW4suWyPGRYqHxuPPeZttDqNBTKeBwVfyvQe8Nt3XZuZNe8vFPz3q1ine83bTaUeB2rVniFwAD39Ezo
  // (sold 1.1M tokens → 30 lamports SOL → all routed correctly)
  const { BN } = require('@coral-xyz/anchor');
  const creatorPk = creator ? new PublicKey(creator) : new PublicKey('11111111111111111111111111111111');
  // v0.8.6.4: For MAYHEM tokens, SDK's default getStaticRandomFeeRecipient()
  // picks from CURRENT_FEE_RECIPIENTS (regular) — V2 program rejects with
  // NotAuthorized 6000 for mayhem tokens. Must explicitly pass reserved
  // fee recipient.
  //
  // ASYMMETRY (verified by simulation 2026-06-19 23:30 GMT+8, mint 7Zg4G...pump):
  //   - fee_recipient MUST be from RESERVED_FEE_RECIPIENTS (or single RESERVED_FEE_RECIPIENT)
  //   - buyback_fee_recipient can be from CURRENT_BUYBACK_FEE_RECIPIENTS
  //     (all 8 work for mayhem — verified by simulating each)
  //   - Putting buyback in RESERVED_FEE_RECIPIENTS gives 6057 BuybackFeeRecipientNotAuthorized
  //   - Putting fee in CURRENT_FEE_RECIPIENTS gives 6000 NotAuthorized
  const feeRecipient = pickFeeRecipient(isMayhem);
  const buybackFeeRecipient = BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)];
  const ix = await _pumpSdkInstance.getSellV2InstructionRaw({
    user: u,
    mint: m,
    creator: creatorPk,
    amount: new BN(tokenAmount.toString()),
    quoteAmount: new BN(minSolOutput.toString()),
    feeRecipient,
    buybackFeeRecipient,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteMint: new PublicKey(config.SOL_MINT),
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  return ix;
}

/**
 * Build a pump.fun swap transaction. Returns base64-encoded transaction.
 * @param {Object} args
 * @param {Object} args.quoteResponse  - output of getBuyQuote/getSellQuote
 * @param {string|PublicKey} args.userPublicKey
 * @param {string} args.side  - 'buy' or 'sell'
 */
export async function buildSwapTransaction({ quoteResponse, userPublicKey, side }) {
  const conn = getConnection();
  // Get a fresh blockhash (processed commitment for speed)
  const { blockhash } = await conn.getLatestBlockhash('processed');
  const user = new PublicKey(userPublicKey);
  // v0.8.6.4 (CRITICAL FIX): For SELL, inputMint=base_mint=MINT, outputMint=SOL.
  // For BUY, inputMint=SOL, outputMint=base_mint=MINT.
  // Bot's mint is always the BASE mint (pump.fun token), which is:
  //   - BUY: outputMint
  //   - SELL: inputMint
  // The previous code `outputMint || inputMint` picked SOL for SELL — wrong!
  // Result: buildSellInstruction received SOL as mint → SDK computed
  //   bondingCurve = pda([bonding-curve, SOL], PUMP) = 6PiyjiA... (wrong!)
  //   base_mint in tx = So1111... (SOL) instead of MINT
  // On-chain fail: "AnchorError caused by account: bonding_curve. Error Code:
  //   AccountOwnedByWrongProgram. Error Number: 3007"
  // Verified via on-chain tx 5BX6jU2jqzebSfz3Jk3V31J127xynf7ZGei5NJarvqaWENetrmtcgqEiwBKT7Abb9PZWYGjuP4QGgKMZg8Qb9uy4
  const baseMintStr = side === 'sell' ? quoteResponse.inputMint : quoteResponse.outputMint;
  const mint = new PublicKey(baseMintStr);
  const lamports = await conn.getMinimumBalanceForRentExemption(165);  // 165 = account size

  let mainIx;
  // v0.8.5: pass creator from quote state for creator-vault PDA derivation.
  // The quote fetches bonding curve state which has the creator field; we
  // stash it as _creator so the builder can use it without a 2nd RPC call.
  const creator = quoteResponse._creator;
  // v0.8.6.4: mayhem flag now used for BOTH buy and sell (was buy-only in v0.8.6.3).
  // SELL needs reserved fee recipients for mayhem tokens, same as BUY.
  const isMayhem = quoteResponse._isMayhem || false;
  if (side === 'buy') {
    // v0.8.6.3: handcrafted BuyExactSolIn (disc 38fc74089edfcd5f) — on-chain verified
    // v0.8.5: handcrafted V1 'buy' disc (66063d12...) — REJECTED for mayhem tokens
    // Blueprint verified: sig 2uPG4WPRYkjo2RfLf5KM6jYqyhXZXCEx4H5GBFQpyXjXyeZSy86QYRREYebUk6ToHkk1Ga4Rxr1DSEzfQTtmKwEJ
    mainIx = buildBuyInstruction({
      mint,
      user,
      tokenAmount: quoteResponse._minTokensOut,  // v0.8.6.6: pass min_tokens_out (slippage-adjusted) — was outAmount (no slippage) → 6042 fail
      maxSolCost: quoteResponse._maxSolCost,
      creator,
      isMayhem,
    });
  } else if (side === 'sell') {
    // v0.8.5: SDK V2 sell — V1 sell fails for Token-2022 mints (3007
    // AccountOwnedByWrongProgram). V2 sell uses base/quote model and is
    // on-chain verified working (sig THBMzv8UZW4s...).
    mainIx = await buildSellInstruction({
      mint,
      user,
      tokenAmount: quoteResponse.inAmount,
      minSolOutput: quoteResponse._minSolOutput,
      creator,
      isMayhem,  // v0.8.6.4: needed to pick reserved fee recipients for mayhem tokens
    });
  } else {
    throw new Error(`pumpfun.buildSwapTransaction: side must be 'buy' or 'sell', got ${side}`);
  }

  // v0.8.5: For SELL, the user's ATA must already exist (created during BUY).
  // Adding a create_associated_token_account instruction for Token-2022 mints
  // causes IncorrectProgramId on the SPL ATA program (observed 2026-06-19 20:55 GMT+8).
  // The standard SPL ATA program doesn't handle Token-2022 mints via the
  // create_associated_token_account instruction in the same way. For BUY we
  // need to prepend createATA, but for SELL the ATA is guaranteed to exist.
  // Skip the pre-ix for SELL.
  // ComputeBudget: set high priority
  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000_000,  // 1M micro-lamports = 0.001 SOL base price
  });
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 250_000,  // plenty for 1 swap
  });
  const instructions = [computePriceIx, computeLimitIx];
  if (side === 'buy') {
    // v0.8.4: pre-create the user's base token ATA. The V2 program expects
    // `associated_base_user` to be ALREADY INITIALIZED before the buy runs.
    // V1 created it as a side-effect; V2 doesn't. Without this, we get
    // AccountNotInitialized (3012) on the buy leg.
    const userPk = typeof user === 'string' ? new PublicKey(user) : user;
    const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const createAtaIx = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: userPk, isSigner: true, isWritable: true },  // payer
        { pubkey: PublicKey.findProgramAddressSync(
            [userPk.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID)[0], isSigner: false, isWritable: true },  // ata
        { pubkey: userPk, isSigner: false, isWritable: false },  // owner
        { pubkey: mintPk, isSigner: false, isWritable: false },  // mint
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),  // create_associated_token_account has no data
    });
    instructions.push(createAtaIx);
  }
  instructions.push(mainIx);

  // v0.8.5: ComputeBudget → [createATA only for BUY] → mainIx
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString('base64');
}

/**
 * Check if a token is still in pump.fun's bonding curve (pre-graduation).
 * @returns {Promise<boolean>}
 */
export async function isPumpfunToken(mint) {
  try {
    const state = await getBondingCurveState(mint);
    return !state.complete;
  } catch {
    return false;
  }
}

/**
 * Check if a token has is_mayhem_mode=true (v0.8.5).
 * Mayhem-mode tokens require reserved fee recipients that the on-chain program
 * validates; the regular 8 fee_recipients in @pump-fun/pump-sdk IDL are rejected
 * with NotAuthorized 6000. Bot should SKIP mayhem tokens entirely.
 * @returns {Promise<boolean>} - true if mayhem mode, false if normal
 */
export async function isMayhemModeToken(mint) {
  try {
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
    const bc = findBondingCurve(mint);
    const info = await conn.getAccountInfo(bc);
    if (!info) return false;
    // is_mayhem_mode is at byte 81 of BC state (151 bytes V2 layout)
    return info.data[81] === 1;
  } catch {
    return false;
  }
}
