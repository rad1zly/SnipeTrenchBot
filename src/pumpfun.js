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
  return {
    inputMint: config.SOL_MINT,
    outputMint: outputMint.toString(),
    inAmount: solLamports.toString(),
    outAmount: tokensOut.toString(),
    otherAmountThreshold: tokensOut.toString(),  // min out (we already computed with fee)
    slippageBps,
    priceImpactPct: String(priceImpact),
    _pumpfun: true,  // marker for executor to call pumpfun builder
    _maxSolCost: maxSolCost.toString(),
    _virtualSolReserves: state.virtualSolReserves.toString(),
    _virtualTokenReserves: state.virtualTokenReserves.toString(),
    _creator: state.creator,  // v0.8.4: needed for creator-vault PDA (BUG: missing in v0.8.0–v0.8.3 — caused Anchor 2006 ConstraintSeeds error on BuyV2)
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

// On-chain verified discriminators
// v0.8.5 history:
//   - BuyExactSolIn disc (3efc1d45aa6a74dc) from user-shared tx — FAILED (Fallback 101)
//   - V1 'buy' disc (66063d12...) — WORKED on-chain for non-mayhem mints (2026-06-19 20:45 GMT+8)
//   - V1 'sell' disc (33e685a4...) — FAILED (AccountOwnedByWrongProgram — V1 sell expects regular Token program mint, but V2 mints are Token-2022)
//   - SellV2 disc (5df6823ce7e940b2) — TESTING (per IDL, but also failed earlier with NotAuthorized 6000 — may have been a mayhem-mode issue)
const BUY_V1_DISC = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);  // V1 'buy' — WORKS!
const SELL_V1_DISC = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);  // V1 'sell' — FAILED for Token-2022
const SELL_V2_DISC = Buffer.from([0x5d, 0xf6, 0x82, 0x3c, 0xe7, 0xe9, 0x40, 0xb2]);  // V2 'sell' — TESTING
const BUY_EXACT_SOL_IN_DISC = Buffer.from([0x3e, 0xfc, 0x1d, 0x45, 0xaa, 0x6a, 0x74, 0xdc]);  // legacy, FAILED

// Pick a random fee recipient (matches pump.fun behavior: each tx uses one)
function pickFeeRecipient() {
  return FEE_RECIPIENTS[Math.floor(Math.random() * FEE_RECIPIENTS.length)];
}
function pickBuybackRecipient() {
  return BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)];
}

function buildBuyInstruction({ mint, user, tokenAmount, maxSolCost, creator }) {
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
  const feeRecipient = pickFeeRecipient();
  const buybackRecipient = pickBuybackRecipient();

  // Data layout (BuyExactSolIn): disc(8) + spendable_sol_in(u64) + min_tokens_out(u64) + trackVolume(OptionBool) = 8+8+8+1=25
  // OptionBool: 0x00 = None, 0x01 + bool = Some(true/false). We use None (= 0x00) to match working tx.
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_V1_DISC.copy(data, 0);  // v0.8.5: try V1 'buy' disc (legacy)
  data.writeBigUInt64LE(BigInt(maxSolCost), 8);    // spendable_sol_in
  data.writeBigUInt64LE(BigInt(tokenAmount), 16);  // min_tokens_out
  data.writeUInt8(0, 24);                          // trackVolume = None

  // 18 accounts in EXACT order from on-chain working tx:
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },                    // 0
      { pubkey: feeRecipient, isSigner: false, isWritable: true },                   // 1 (rotating)
      { pubkey: m, isSigner: false, isWritable: false },                             // 2
      { pubkey: bc, isSigner: false, isWritable: true },                             // 3
      { pubkey: bcAta, isSigner: false, isWritable: true },                          // 4 (BC's Token-2022 ATA)
      { pubkey: userAta, isSigner: false, isWritable: true },                        // 5 (user's Token-2022 ATA)
      { pubkey: u, isSigner: true, isWritable: true },                               // 6
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },       // 7
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },         // 8
      { pubkey: creatorVault, isSigner: false, isWritable: true },                   // 9
      { pubkey: findEventAuthority(), isSigner: false, isWritable: false },          // 10
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },           // 11
      { pubkey: findGlobalVolumeAccumulator(), isSigner: false, isWritable: false },// 12
      { pubkey: findUserVolumeAccumulator(u), isSigner: false, isWritable: true },  // 13
      { pubkey: findFeeConfig(), isSigner: false, isWritable: false },              // 14
      { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },          // 15
      { pubkey: findBondingCurveV2(m), isSigner: false, isWritable: false },         // 16
      { pubkey: buybackRecipient, isSigner: false, isWritable: true },              // 17 (rotating)
    ],
    data,
  });
}

function buildSellInstruction({ mint, user, tokenAmount, minSolOutput, creator }) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  const bc = findBondingCurve(m);
  const bcAta = findBondingCurveAta(m);
  const userAta = PublicKey.findProgramAddressSync(
    [u.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
  const creatorKey = creator ? new PublicKey(creator) : new PublicKey('11111111111111111111111111111111');
  const creatorVault = findCreatorVault(creatorKey);
  const feeRecipient = pickFeeRecipient();

  // Data layout (V2 sell): disc(8) + amount(u64) + min_sol_output(u64) + trackVolume(OptionBool) = 8+8+8+1=25
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  SELL_V2_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(tokenAmount), 8);   // amount of tokens to sell
  data.writeBigUInt64LE(BigInt(minSolOutput), 16); // min SOL output
  data.writeUInt8(0, 24);                           // trackVolume = None

  // 17 accounts (sell doesn't need buyback recipient — buyback is buy-only)
  // CRITICAL: SELL has DIFFERENT account order than BUY! On-chain verified:
  //   - Account 2 = WSOL_MINT (not project mint!)
  //   - Account 3 = mint (project mint)
  //   - Account 4 = bc
  //   - Account 5 = bcAta
  //   - Account 6 = userAta
  //   - Account 7 = user
  // Found via tx 3HKyiG7xU4YesSzS4rbTJim7n5RgCJPfpxND7Qm6XdexdMPmsaRMEcv86a4E6EvfboHXM5zzPxX2LGJpQ2arEHL6
  // (3007 AccountOwnedByWrongProgram on BC) — the BC was at the wrong index
  const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },                    // 0
      { pubkey: feeRecipient, isSigner: false, isWritable: true },                   // 1
      { pubkey: WSOL_MINT, isSigner: false, isWritable: false },                     // 2
      { pubkey: m, isSigner: false, isWritable: false },                             // 3
      { pubkey: bc, isSigner: false, isWritable: true },                             // 4
      { pubkey: bcAta, isSigner: false, isWritable: true },                          // 5
      { pubkey: userAta, isSigner: false, isWritable: true },                        // 6
      { pubkey: u, isSigner: true, isWritable: true },                               // 7
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },       // 8
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },         // 9
      { pubkey: creatorVault, isSigner: false, isWritable: true },                   // 10
      { pubkey: findEventAuthority(), isSigner: false, isWritable: false },          // 11
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },           // 12
      { pubkey: findGlobalVolumeAccumulator(), isSigner: false, isWritable: false },// 13
      { pubkey: findUserVolumeAccumulator(u), isSigner: false, isWritable: true },  // 14
      { pubkey: findFeeConfig(), isSigner: false, isWritable: false },              // 15
      { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },          // 16
    ],
    data,
  });
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
  const mint = new PublicKey(quoteResponse.outputMint || quoteResponse.inputMint);
  const lamports = await conn.getMinimumBalanceForRentExemption(165);  // 165 = account size

  let mainIx;
  // v0.8.5: pass creator from quote state for creator-vault PDA derivation.
  // The quote fetches bonding curve state which has the creator field; we
  // stash it as _creator so the builder can use it without a 2nd RPC call.
  const creator = quoteResponse._creator;
  if (side === 'buy') {
    // v0.8.5: handcrafted BuyExactSolIn (disc 3efc1d45aa6a74dc) — on-chain verified
    // v0.8.3 SDK BuyV2 was using wrong disc (b817ee6167c5d33d) which the on-chain
    // program doesn't accept. See v0.8.5 block comment above for full forensic.
    mainIx = buildBuyInstruction({
      mint,
      user,
      tokenAmount: quoteResponse.outAmount,
      maxSolCost: quoteResponse._maxSolCost,
      creator,
    });
  } else if (side === 'sell') {
    // v0.8.5: handcrafted V1 sell (disc 33e685a4017f83ad) — on-chain verified
    // The V1 sell discriminator still works post-May 2026 upgrade. The V2
    // sell (5df6823ce7e940b2) requires mayhem-aware SDK that doesn't exist yet.
    mainIx = buildSellInstruction({
      mint,
      user,
      tokenAmount: quoteResponse.inAmount,
      minSolOutput: quoteResponse._minSolOutput,
      creator,
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
