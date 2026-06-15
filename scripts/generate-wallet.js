// scripts/generate-wallet.js
// =============================================================================
// Generate a fresh Solana keypair for the bot's trading wallet.
// Run with:  npm run generate-wallet
//
// IMPORTANT: This wallet will hold real SOL when DRY_RUN=false.
// Fund it with ONLY what you can afford to lose. Treat the printed private
// key like a password — anyone with it can drain the wallet.
// =============================================================================

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();

const secretKeyBs58 = bs58.encode(kp.secretKey);
const secretKeyJson = JSON.stringify(Array.from(kp.secretKey));
const publicKey = kp.publicKey.toBase58();

console.log('\n=== New Solana Wallet Generated ===\n');
console.log('Public Key (safe to share):');
console.log(`  ${publicKey}\n`);
console.log('Private Key — Base58 (paste into BOT_WALLET_PRIVATE_KEY=):');
console.log(`  ${secretKeyBs58}\n`);
console.log('Private Key — JSON array (alternative format):');
console.log(`  ${secretKeyJson}\n`);
console.log('Next steps:');
console.log('  1. Copy the Base58 private key into your .env as BOT_WALLET_PRIVATE_KEY');
console.log('  2. Fund this wallet with a small amount of SOL for trading');
console.log('  3. Start the bot in DRY_RUN mode first to verify behavior');
console.log('  4. Switch to DRY_RUN=false only when you are ready to trade live\n');
console.log('⚠️  NEVER commit this output to git or share it with anyone.\n');
