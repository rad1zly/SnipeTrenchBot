// scripts/test-force-pumpfun.js
// Force pump.fun direct route (bypass mayhem guard) and BUILD tx only.
// Use this to verify whether BuyExactSolIn (disc 38fc74089edfcd5f) actually
// works on-chain for mayhem tokens.

import 'dotenv/config';
import config from '../src/config.js';
import * as swapRouter from '../src/swapRouter.js';
import * as pumpfun from '../src/pumpfun.js';
import { walletManager, fetchSolBalance } from '../src/walletManager.js';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

const MINT = process.argv[2];
const CHAT_ID = '6170215817';
const SOL_AMOUNT = 0.005; // small for safety

if (!MINT) {
  console.error('Usage: node scripts/test-force-pumpfun.js <MINT>');
  process.exit(1);
}

async function main() {
  console.log('=== Force pump.fun direct (mayhem bypass) ===');
  console.log(`Mint: ${MINT}`);
  console.log();

  // Check mayhem
  const isPF = await pumpfun.isPumpfunToken(MINT);
  const isMayhem = isPF ? await pumpfun.isMayhemModeToken(MINT) : false;
  console.log('pump.fun token:', isPF);
  console.log('mayhem mode:    ', isMayhem);
  console.log();

  // Get quote directly from pumpfun (bypass swapRouter's mayhem guard)
  console.log('[1] Direct pumpfun.getBuyQuote');
  const buyQuote = await pumpfun.getBuyQuote({ solAmount: SOL_AMOUNT, outputMint: MINT, slippageBps: 500 });
  console.log('  outAmount:', buyQuote.outAmount, 'tokens');
  console.log('  priceImpactPct:', buyQuote.priceImpactPct);
  console.log();

  // Build tx
  console.log('[2] Direct pumpfun.buildSwapTransaction (BUY, new disc 38fc74089edfcd5f)');
  const kp = walletManager.getKeypair(CHAT_ID);
  const userPublicKey = kp.publicKey.toBase58();
  console.log('  user:', userPublicKey);
  const bal = await fetchSolBalance(userPublicKey);
  console.log('  SOL balance:', bal.sol);
  console.log();

  if (process.env.FORCE_SIDE === 'sell') {
    // Sell mode: skip buy, sell all tokens
    const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
    const ata = getAssociatedTokenAddressSync(new (await import('@solana/web3.js')).PublicKey(MINT), new (await import('@solana/web3.js')).PublicKey(userPublicKey), false, TOKEN_2022_PROGRAM_ID);
    const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
    const bal2 = await conn.getTokenAccountBalance(ata);
    console.log('  Token balance:', bal2.value.uiAmount, bal2.value.amount);
    const sellQuote = await pumpfun.getSellQuote({ tokenRawAmount: bal2.value.amount, inputMint: MINT, slippageBps: 500 });
    console.log('  Sell quote outAmount:', sellQuote.outAmount, 'lamports =', Number(sellQuote.outAmount)/1e9, 'SOL');
    const txB64 = await pumpfun.buildSwapTransaction({
      quoteResponse: sellQuote,
      userPublicKey,
      side: 'sell',
    });
    console.log('  SELL TX built, length:', txB64.length, 'b64 chars');
    console.log();
    console.log('[3] Sending REAL SELL tx to mainnet...');
    const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
    tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    console.log('  Sent, signature:', sig);
    console.log();
    console.log('[4] Confirming...');
    for (let i = 0; i < 30; i++) {
      const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = st?.value?.[0];
      if (s) {
        console.log(`  status after ${i + 1}s:`, JSON.stringify({ confirmation: s.confirmationStatus, err: s.err ? JSON.stringify(s.err) : 'none', slot: s.slot }));
        if (s.err) {
          const fullTx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          if (fullTx?.meta?.logMessages) {
            console.log('On-chain log messages (last 15):');
            for (const log of fullTx.meta.logMessages.slice(-15)) console.log('  ', log.slice(0, 200));
          }
          process.exit(1);
        }
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          console.log('✅ SELL TX CONFIRMED');
          console.log('Final balance:', (await fetchSolBalance(userPublicKey)).sol);
          process.exit(0);
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('⚠️ Confirm timeout');
    process.exit(1);
  }

  const txB64 = await pumpfun.buildSwapTransaction({
    quoteResponse: buyQuote,
    userPublicKey,
    side: 'buy',
  });
  console.log('  TX built, length:', txB64.length, 'b64 chars');
  console.log();

  if (bal.sol < SOL_AMOUNT + 0.005) {
    console.log('⚠️ Insufficient SOL — would NOT submit');
    console.log('   Build-only test done.');
    return;
  }

  console.log('[3] Sending REAL tx to mainnet...');
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  tx.sign([kp]);

  const conn = new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log('  Sent, signature:', sig);
  console.log();

  console.log('[4] Confirming...');
  for (let i = 0; i < 30; i++) {
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = st?.value?.[0];
    if (s) {
      console.log(`  status after ${i + 1}s:`, JSON.stringify({
        confirmation: s.confirmationStatus,
        err: s.err ? JSON.stringify(s.err) : 'none',
        slot: s.slot,
      }));
      if (s.err) {
        console.log('❌ TX FAILED:', JSON.stringify(s.err));
        // Fetch full tx for detailed log
        const fullTx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (fullTx?.meta?.logMessages) {
          console.log('On-chain log messages:');
          for (const log of fullTx.meta.logMessages.slice(-15)) {
            console.log('  ', log.slice(0, 200));
          }
        }
        process.exit(1);
      }
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
        console.log('✅ TX CONFIRMED');
        console.log('Final balance:', (await fetchSolBalance(userPublicKey)).sol);
        process.exit(0);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('⚠️ Confirm timeout after 30s');
}

main().catch(e => {
  console.error('TEST FAILED:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
