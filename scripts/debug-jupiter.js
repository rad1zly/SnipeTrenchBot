// scripts/debug-jupiter.js
// Direct Jupiter API probe to see why quote returns null

import 'dotenv/config';
import config from '../src/config.js';
import axios from 'axios';

const MINT = process.argv[2] || '7Zg4GGUE18sTBZg6t68gRcJEzWFdApXymHnyTg6Dpump';
const url = `${config.JUPITER_API_URL}/quote`;
const params = {
  inputMint: config.SOL_MINT,
  outputMint: MINT,
  amount: 1000000, // 0.001 SOL in lamports
  slippageBps: 500,
  wrapAndUnwrapSol: true,
};
console.log('URL:', url);
console.log('Params:', params);
console.log('SOL_MINT:', config.SOL_MINT);

try {
  const res = await axios.get(url, { params, timeout: 10000 });
  console.log('Status:', res.status);
  console.log('Data:', JSON.stringify(res.data, null, 2).slice(0, 2000));
} catch (e) {
  console.log('ERR status:', e.response?.status);
  console.log('ERR data:', JSON.stringify(e.response?.data, null, 2).slice(0, 1000));
  console.log('ERR msg:', e.message);
}
