// scripts/test-real-trade.js
// Real on-chain BUY + SELL test for one specific mint, using the exact
// executor flow (getBuyQuote → buildSwapTransaction → submitSwap →
// wait HOLD_MS → getSellQuote → submitSwap).
//
// SAFETY: requires user confirmation in chat. Wallet must be funded.
// This script will:
//   1. Read settings from DB (fixed_buy_sol, slippage_bps, hold_ms, auto_sell)
//   2. Guard the trade via safety.js (per-trade cap, daily loss, etc.)
//   3. BUY 0.01 SOL of <MINT> via pump.fun direct route
//   4. Wait HOLD_MS
//   5. SELL 100% of received tokens
//   6. Report final PnL in SOL
//
// Usage: node scripts/test-real-trade.js <MINT> [chatId]

import 'dotenv/config';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import config from '../src/config.js';
import * as settings from '../src/settings.js';
import { guardTrade } from '../src/safety.js';
import { positionsDb, signalsDb } from '../src/db.js';
import { getBuyQuote, getSellQuote, buildSwapTransaction } from '../src/swapRouter.js';
import { walletManager, fetchSolBalance } from '../src/walletManager.js';

const MINT = process.argv[2];
const CHAT_ID = process.argv[3] || '6170215817';
const MODE = process.argv[4] || 'full'; // 'full' = buy+sell, 'sell' = sell-only
if (!MINT) {
  console.error('Usage: node scripts/test-real-trade.js <MINT> [chatId] [full|sell]');
  process.exit(1);
}

function logStep(stage, data = {}) {
  console.log(`[${new Date().toISOString()}] ${stage}`, JSON.stringify(data));
  if (data && Object.keys(data).length === 0) data = undefined;
  try {
    signalsDb.log({ type: stage, wallet: 'TEST', mint: MINT, data });
  } catch {}
}

async function submitSwap(quoteResponse, label, route, side, chatId) {
  if (config.DRY_RUN) {
    logStep(`${label}:DRY_RUN`, { inputAmount: quoteResponse?.inAmount, outputAmount: quoteResponse?.outAmount });
    return { signature: 'DRY_RUN_' + Date.now(), simulated: true };
  }
  const kp = walletManager.getKeypair(chatId);
  const userPublicKey = kp.publicKey.toBase58();
  logStep(`${label}:BUILD_TX`, { route, side, userPublicKey });
  const txB64 = await buildSwapTransaction({ quoteResponse, userPublicKey, route, side });
  if (!txB64) throw new Error('buildSwapTransaction returned null');
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([kp]);
  logStep(`${label}:SIGNED`, { txSize: txB64.length });

  const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  logStep(`${label}:SEND_TX`, { rpc: config.SOLANA_RPC_URL?.slice(0, 50) });
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  logStep(`${label}:SENT`, { signature: sig });

  // Confirm
  const start = Date.now();
  let confirmed = null;
  for (let i = 0; i < 30; i++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = st?.value?.[0];
    if (s) {
      if (s.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
        confirmed = s;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!confirmed) {
    logStep(`${label}:CONFIRM_TIMEOUT`, { signature: sig, elapsedMs: Date.now() - start });
  } else {
    logStep(`${label}:CONFIRMED`, { signature: sig, slot: confirmed.slot, elapsedMs: Date.now() - start });
  }
  return { signature: sig, confirmed: !!confirmed };
}

async function getTokenBalance(mint, ownerPubkey) {
  // Use Helius RPC for SPL token balance
  const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
  // Try both Token and Token-2022
  for (const prog of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(ownerPubkey), false, prog);
      const bal = await conn.getTokenAccountBalance(ata);
      if (bal?.value?.amount) return { amount: BigInt(bal.value.amount), decimals: bal.value.decimals, ata: ata.toBase58(), program: prog.toBase58() };
    } catch {}
  }
  return null;
}

async function main() {
  console.log('=== REAL on-chain BUY + SELL test ===');
  console.log(`Mint:    ${MINT}`);
  console.log(`ChatId:  ${CHAT_ID}`);
  console.log(`Mode:    ${MODE}`);
  console.log(`DRY_RUN: ${config.DRY_RUN}`);
  console.log();

  // Settings
  // Allow override via env for testing; default to 0.008 to fit a 0.014 SOL
  // balance (need 0.008 trade + 0.005 fees buffer = 0.013).
  const envSolAmount = process.env.TEST_BUY_SOL ? Number(process.env.TEST_BUY_SOL) : null;
  const solAmount = envSolAmount || Math.min(0.008, settings.get('fixed_buy_sol'));
  const slippageBps = settings.get('slippage_bps');
  const pumpSlippageBps = settings.get('pump_slippage_bps');
  const holdMs = settings.get('hold_ms');
  logStep('SETTINGS', { solAmount, slippageBps, pumpSlippageBps, holdMs });

  // Wallet
  const kp = walletManager.getKeypair(CHAT_ID);
  const userPublicKey = kp.publicKey.toBase58();
  const startBal = await fetchSolBalance(userPublicKey);
  logStep('WALLET', { pubkey: userPublicKey, solBalance: startBal.sol });

  if (MODE === 'full') {
    if (startBal.sol < solAmount + 0.005) {
      throw new Error(`Insufficient SOL: have ${startBal.sol}, need ${solAmount + 0.005} (trade + fees)`);
    }
    // Guard
    const guard = guardTrade({ solAmount, mint: MINT });
    logStep('GUARD', guard);
    if (!guard.allowed) {
      throw new Error(`Trade denied: ${guard.reason}`);
    }
  }

  // ----- BUY (skip if sell-only mode) -----
  if (MODE === 'full') {
    console.log();
    console.log('--- BUY ---');
    const buyWrap = await getBuyQuote({ solAmount, outputMint: MINT, slippageBps: pumpSlippageBps });
    const buyQuote = buyWrap.quote;
    const buyRoute = buyWrap.route;
    if (!buyQuote || buyQuote.error) {
      throw new Error(`BUY quote failed: ${buyQuote?.error}`);
    }
    logStep('BUY_QUOTE_OK', { route: buyRoute, solIn: solAmount, tokensOut: buyQuote.outAmount, priceImpactPct: buyQuote.priceImpactPct });

    // Open position row
    const posRes = positionsDb.open({
      mint: MINT,
      devWallet: 'TEST_DEV',
      entrySig: null,
      entrySol: solAmount,
      entryTokens: buyQuote.outAmount,
    });
    logStep('POSITION_OPENED', { posRes });

    const buyResult = await submitSwap(buyQuote, 'BUY', buyRoute, 'buy', CHAT_ID);
    logStep('BUY_DONE', buyResult);

    // Track tx in memory (no DB update needed; we have sig in buyResult)
    logStep('TX_TRACKED', { posId: posRes.id, signature: buyResult.signature });

    // Wait HOLD_MS
    console.log(`Holding ${holdMs}ms...`);
    await new Promise(r => setTimeout(r, holdMs));
  } else {
    console.log('Skipping BUY (sell-only mode)');
  }

  // ----- SELL -----
  console.log();
  console.log('--- SELL ---');
  const balInfo = await getTokenBalance(MINT, userPublicKey);
  if (!balInfo) {
    throw new Error('No token balance found — BUY may not have credited');
  }
  logStep('TOKEN_BALANCE', { amount: balInfo.amount.toString(), decimals: balInfo.decimals, ata: balInfo.ata });

  // Open position row (for sell-only mode)
  if (MODE === 'sell') {
    var sellPosRes = positionsDb.open({
      mint: MINT,
      devWallet: 'TEST_DEV',
      entrySig: 'manual',
      entrySol: 0.008,  // approximate prior buy
      entryTokens: balInfo.amount.toString(),
    });
    logStep('POSITION_OPENED_SELL', { posRes: sellPosRes });
  }

  const sellWrap = await getSellQuote({ tokenRawAmount: Number(balInfo.amount), inputMint: MINT, slippageBps: pumpSlippageBps });
  const sellQuote = sellWrap.quote;
  const sellRoute = sellWrap.route;
  if (!sellQuote || sellQuote.error) {
    throw new Error(`SELL quote failed: ${sellQuote?.error}`);
  }
  logStep('SELL_QUOTE_OK', { route: sellRoute, tokensIn: sellQuote.inAmount, lamportsOut: sellQuote.outAmount, priceImpactPct: sellQuote.priceImpactPct });

  const sellResult = await submitSwap(sellQuote, 'SELL', sellRoute, 'sell', CHAT_ID);
  logStep('SELL_DONE', sellResult);

  // Re-check on-chain to confirm SELL actually went through
  const conn2 = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  await new Promise(r => setTimeout(r, 3000));
  let postSellBal = null;
  try {
    const ata = balInfo.ata;
    const bal2 = await conn2.getTokenAccountBalance(new PublicKey(ata));
    postSellBal = bal2.value.uiAmount;
  } catch (e) {
    logStep('POST_SELL_BAL_ERR', { err: e.message });
  }
  logStep('POST_SELL_TOKEN_BAL', { balance: postSellBal, hadTokens: balInfo.amount.toString() });

  // Close position
  const endBal = await fetchSolBalance(userPublicKey);
  const pnlSol = endBal.sol - startBal.sol;
  if (MODE === 'sell') {
    positionsDb.close(sellPosRes.id, { exitSig: sellResult.signature, exitSol: Number(sellQuote.outAmount) / 1e9, pnlSol, pnlPercent: null, holdMs });
  } else {
    positionsDb.close(posRes.id, { exitSig: sellResult.signature, exitSol: Number(sellQuote.outAmount) / 1e9, pnlSol, pnlPercent: null, holdMs });
  }
  logStep('POSITION_CLOSED', { pnlSol, endBal: endBal.sol });

  console.log();
  console.log('=== TEST COMPLETE ===');
  console.log(`Start SOL: ${startBal.sol}`);
  console.log(`End SOL:   ${endBal.sol}`);
  console.log(`PnL:       ${pnlSol} SOL`);
  console.log(`BUY sig:   ${buyResult.signature}`);
  console.log(`SELL sig:  ${sellResult.signature}`);
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
