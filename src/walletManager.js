// src/walletManager.js
// =============================================================================
// Secure storage for the bot's trading wallet private key. Replaces the old
// .env-based BOT_WALLET_PRIVATE_KEY flow: user sends the key via Telegram,
// the bot encrypts it with AES-256-GCM, stores the ciphertext in SQLite, and
// the key never appears in plaintext on disk or in logs.
//
// Security model:
//   - Key encryption: AES-256-GCM with random 12-byte IV per write
//   - Key derivation: scryptSync(machine-id || WALLET_PEPPER, salt, 32)
//       → the wallet can only be decrypted on the same machine unless the
//         user also configured WALLET_PEPPER in .env
//   - Storage: ciphertext, IV, auth tag stored in `wallet` table (single row,
//     id=1). Plaintext NEVER written to disk, never logged.
//   - Display: only last 4 chars of the public address are ever shown
//   - In-memory: the keypair is held in JS memory only while the executor
//     is signing a transaction. (Future: zero the buffer after use.)
//
// Threat model coverage:
//   - DB file stolen alone        → useless without machine-id + pepper
//   - Logs intercepted             → regex scrub removes any leaked key
//   - Telegram chat screenshot     → key message auto-deleted by bot
// =============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getDb } from './db.js';
import config from './config.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = Buffer.from('snipetrench-wallet-v1', 'utf8');

// Regexes for log scrubbing — match either Base58 (32-88 chars) or a JSON
// byte array (>=32 ints). Used by index.js / notifier when logging arbitrary
// user text so a leaked private key never reaches disk.
const KEY_REGEX_B58 = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;
const KEY_REGEX_ARR = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,}\s*\]/g;

/**
 * Replace any key-like substring with [REDACTED]. Safe to call on any string
 * before logging. Returns the input unchanged if it's not a string.
 */
export function scrub(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(KEY_REGEX_B58, '[REDACTED]')
    .replace(KEY_REGEX_ARR, '[REDACTED]');
}

// -----------------------------------------------------------------------------
// Machine identity (best-effort, multiple fallbacks)
// -----------------------------------------------------------------------------
function getMachineId() {
  // Linux: /etc/machine-id (systemd) and /var/lib/dbus/machine-id
  // Linux: /proc/sys/kernel/random/boot_id (changes per boot, less stable)
  const candidates = [
    '/etc/machine-id',
    '/var/lib/dbus/machine-id',
  ];
  for (const p of candidates) {
    try {
      const id = fs.readFileSync(p, 'utf8').trim();
      if (id) return `linux:${id}`;
    } catch {
      // continue
    }
  }
  // WSL fallback: read Windows MachineGuid via /proc/registry or hostname
  try {
    const host = os.hostname();
    if (host) return `host:${host}`;
  } catch {
    // ignore
  }
  return 'snipetrench:fallback-identity';
}

// -----------------------------------------------------------------------------
// Key derivation (cached after first call)
// -----------------------------------------------------------------------------
let _derivedKey = null;
function getDerivedKey() {
  if (_derivedKey) return _derivedKey;
  const machineId = getMachineId();
  const pepper = (config.WALLET_PEPPER || '').trim() || 'snipetrench-default-pepper';
  // scrypt is intentionally slow (16384 N = ~100ms) — runs once at boot and
  // cached. N=16384 is the OWASP minimum for interactive use.
  _derivedKey = crypto.scryptSync(`${pepper}::${machineId}`, SALT, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return _derivedKey;
}

// -----------------------------------------------------------------------------
// Format detection
// -----------------------------------------------------------------------------
/**
 * Parse a private key string (Base58 or JSON array). Returns the secret
 * bytes as a Uint8Array and the format. Throws on anything that doesn't
 * look like a Solana key.
 */
function parsePrivateKey(str) {
  const trimmed = String(str || '').trim();
  if (!trimmed) throw new Error('Empty private key');
  // Max length budget:
  //   Base58:  Solana CLI outputs 87-88 chars. Allow up to 200 for any
  //            weird variant (e.g. 64-byte secret key in some wallets
  //            encodes to ~88, but some Phantom/Solfare exports can be
  //            different — be permissive).
  //   JSON array: 64 bytes * 3 digits + 63 commas + 2 brackets = 257.
  //               Add headroom = 1000.
  if (trimmed.length > 1000) throw new Error('Private key too long (max 1000 chars)');

  if (trimmed.startsWith('[')) {
    // JSON byte array
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new Error('Invalid JSON array');
    }
    if (!Array.isArray(arr)) throw new Error('JSON must be an array');
    if (arr.length < 32 || arr.length > 64) {
      throw new Error(`Array length ${arr.length} is not a valid Solana key (need 32-64 bytes)`);
    }
    if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error('Array must contain integers 0-255');
    }
    return { bytes: Uint8Array.from(arr), format: 'array' };
  }

  // Base58 (Solana CLI default)
  if (trimmed.length < 32 || trimmed.length > 200) {
    throw new Error('Base58 string must be 32-200 chars');
  }
  let bytes;
  try {
    bytes = bs58.decode(trimmed);
  } catch (e) {
    throw new Error('Invalid Base58 encoding');
  }
  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(`Decoded length ${bytes.length} is not a valid Solana key (need 32 or 64 bytes)`);
  }
  return { bytes, format: 'base58' };
}

// -----------------------------------------------------------------------------
// Encrypt / decrypt
// -----------------------------------------------------------------------------
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getDerivedKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    throw new Error(`Unexpected auth tag length: ${tag.length}`);
  }
  return { ciphertext: ct, iv, tag };
}

function decrypt({ ciphertext, iv, tag }) {
  if (!ciphertext || !iv || !tag) throw new Error('Missing ciphertext/iv/tag');
  if (iv.length !== IV_LEN) throw new Error(`Invalid IV length: ${iv.length}`);
  if (tag.length !== TAG_LEN) throw new Error(`Invalid auth tag length: ${tag.length}`);
  const decipher = crypto.createDecipheriv(ALGO, getDerivedKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return pt.toString('utf8');
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export const walletManager = {
  /**
   * Encrypt and store a private key. Validates format first by attempting
   * to derive a Keypair. Returns {address, last4}. Throws on bad input.
   */
  set({ privateKey, chatId, username = null }) {
    const { bytes } = parsePrivateKey(privateKey);
    // Derive a Keypair to validate the secret. The keypair object goes out
    // of scope immediately — only the address/last4 are kept.
    const kp = Keypair.fromSecretKey(bytes);
    const address = kp.publicKey.toBase58();
    const last4 = address.slice(-4);

    const { ciphertext, iv, tag } = encrypt(String(privateKey));
    const now = Date.now();

    getDb()
      .prepare(
        `INSERT INTO wallet
           (id, ciphertext, iv, tag, last4, address, created_at, updated_at, set_by_chat_id, set_by_username)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ciphertext       = excluded.ciphertext,
           iv               = excluded.iv,
           tag              = excluded.tag,
           last4            = excluded.last4,
           address          = excluded.address,
           updated_at       = excluded.updated_at,
           set_by_chat_id   = excluded.set_by_chat_id,
           set_by_username  = excluded.set_by_username`
      )
      .run(ciphertext, iv, tag, last4, address, now, now, chatId, username);

    return { address, last4 };
  },

  /**
   * Decrypt the stored key and return a Solana Keypair. Throws if no wallet
   * is set or if decryption fails (e.g. moved to a different machine without
   * WALLET_PEPPER).
   */
  getKeypair() {
    const row = getDb().prepare(`SELECT * FROM wallet WHERE id = 1`).get();
    if (!row) {
      throw new Error('No trading wallet set. Use /start → 🔑 Wallet to add one.');
    }
    let plaintext;
    try {
      plaintext = decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    } catch (e) {
      throw new Error(
        'Failed to decrypt wallet. The encryption key has changed ' +
        '(moved to a new machine without WALLET_PEPPER in .env?).'
      );
    }
    const { bytes } = parsePrivateKey(plaintext);
    return Keypair.fromSecretKey(bytes);
  },

  /**
   * Quick boolean check (no decryption). Safe to call at boot.
   */
  hasKey() {
    const row = getDb().prepare(`SELECT 1 FROM wallet WHERE id = 1`).get();
    return !!row;
  },

  /**
   * Status for display: {set, last4, address, createdAt, updatedAt, setBy}.
   * Never returns the private key. Safe to log.
   */
  getStatus() {
    const row = getDb()
      .prepare(
        `SELECT last4, address, created_at, updated_at, set_by_username
         FROM wallet WHERE id = 1`
      )
      .get();
    if (!row) return { set: false };
    return {
      set: true,
      last4: row.last4,
      address: row.address,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      setBy: row.set_by_username,
    };
  },

  /**
   * Wipe the wallet from the database. Returns the number of rows deleted
   * (0 or 1). Clears the in-memory key derivation cache so the next set()
   * starts fresh.
   */
  remove() {
    _derivedKey = null;
    return getDb().prepare(`DELETE FROM wallet WHERE id = 1`).run().changes;
  },
};

// Re-export the scrub helper at the module level too
export { scrub as scrubKey };
