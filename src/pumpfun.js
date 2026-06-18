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
const { Connection, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SystemProgram, SYSVAR_RENT_PUBKEY } = web3;
// Some constants don't survive CJS->ESM interop cleanly. Hardcode them.
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
import config from './config.js';

// Pump.fun program constants (from on-chain IDL)
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const GLOBAL_PDA = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeQHcc7eCS78PTWa1W7U53NDeFDQUhM3bj1bpm8');

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
};

// Instruction discriminators (8-byte sighash, sha256 of "global:buy"/"global:sell")
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

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
  return PublicKey.findProgramAddressSync(
    [bc.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()],
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
  };
  BC_CACHE.set(cacheKey, { state, cachedAt: Date.now() });
  return state;
}

function readU64(buf, offset) {
  // Use BigInt to handle 64-bit unsigned values
  return buf.readBigUInt64LE(offset);
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
  };
}

// -----------------------------------------------------------------------------
// Build swap transaction
// -----------------------------------------------------------------------------
function createBuyInstruction({ mint, user, amount, maxSolCost }) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  const bc = findBondingCurve(m);
  const bcAta = findBondingCurveAta(m);
  const userAta = PublicKey.findProgramAddressSync(
    [u.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];

  // Data: discriminator (8) + amount (u64) + max_sol_cost (u64)
  const data = Buffer.alloc(8 + 8 + 8);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 8);
  data.writeBigUInt64LE(BigInt(maxSolCost), 16);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: bcAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: u, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function createSellInstruction({ mint, user, amount, minSolOutput }) {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const u = typeof user === 'string' ? new PublicKey(user) : user;
  const bc = findBondingCurve(m);
  const bcAta = findBondingCurveAta(m);
  const userAta = PublicKey.findProgramAddressSync(
    [u.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), m.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];

  // Data: discriminator (8) + amount (u64) + min_sol_output (u64)
  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amount), 8);
  data.writeBigUInt64LE(BigInt(minSolOutput), 16);

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys: [
      { pubkey: GLOBAL_PDA, isSigner: false, isWritable: false },
      { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: bc, isSigner: false, isWritable: true },
      { pubkey: bcAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: u, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
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
  if (side === 'buy') {
    mainIx = createBuyInstruction({
      mint,
      user,
      amount: quoteResponse.outAmount,
      maxSolCost: quoteResponse._maxSolCost,
    });
  } else if (side === 'sell') {
    mainIx = createSellInstruction({
      mint,
      user,
      amount: quoteResponse.inAmount,
      minSolOutput: quoteResponse._minSolOutput,
    });
  } else {
    throw new Error(`pumpfun.buildSwapTransaction: side must be 'buy' or 'sell', got ${side}`);
  }

  // ComputeBudget: set high priority (10M CU limit not needed, but price matters)
  // Match the sniper bot's pattern: 200K CU limit + ~0.0001 SOL priority price
  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000_000,  // 1M micro-lamports = 0.001 SOL base price
  });
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 250_000,  // plenty for 1 swap
  });

  // Build V0 message (we may need lookup tables in future, not now)
  const instructions = [computePriceIx, computeLimitIx, mainIx];
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
