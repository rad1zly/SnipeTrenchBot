// src/walletManager.js
// =============================================================================
// Secure per-user trading wallet storage (v0.7.0+).
//
// v0.7.0 changed from a single global row (id=1) to per-user (chat_id PK) so
// each Telegram subscriber can hold their own trading wallet — its address
// and key are scoped to that user and never broadcast to other subscribers.
//
// Security model (unchanged from v0.3.0):
//   - Key encryption: AES-256-GCM with random 12-byte IV per write
//   - Key derivation: scryptSync(machine-id || WALLET_PEPPER, salt, 32)
//       → the wallet can only be decrypted on the same machine unless the
//         user also configured WALLET_PEPPER in .env
//   - Storage: per-user row in `wallet` table (chat_id PK). Plaintext NEVER
//     written to disk, never logged.
//   - Display: only last 4 chars of the public address are ever shown
//   - In-memory: the keypair is held in JS memory only while the executor
//     is signing a transaction. (Future: zero the buffer after use.)
//
// Threat model coverage:
//   - DB file stolen alone        → useless without machine-id + pepper
//   - Logs intercepted             → regex scrub removes any leaked key
//   - Telegram chat screenshot     → key message auto-deleted by bot
//   - Cross-subscriber snooping    → each user has their own row, no shared
//     wallet address visible to others
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
   * Encrypt and store a private key for one user. Validates format first by
   * attempting to derive a Keypair. Returns {address, last4}. Throws on bad
   * input. Overwrites any existing wallet for the same chat_id.
   */
  set({ privateKey, chatId, username = null }) {
    if (chatId == null) throw new Error('walletManager.set: chatId is required');
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
           (chat_id, ciphertext, iv, tag, last4, address, created_at, updated_at, set_by_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           ciphertext       = excluded.ciphertext,
           iv               = excluded.iv,
           tag              = excluded.tag,
           last4            = excluded.last4,
           address          = excluded.address,
           updated_at       = excluded.updated_at,
           set_by_username  = excluded.set_by_username`
      )
      .run(chatId, ciphertext, iv, tag, last4, address, now, now, username);

    return { address, last4 };
  },

  /**
   * Generate a brand-new Solana keypair for one user, encrypt it, store it.
   * Returns {address, last4}. Caller is responsible for showing the user the
   * public address (and asking them to fund it).
   */
  generate({ chatId, username = null }) {
    if (chatId == null) throw new Error('walletManager.generate: chatId is required');
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const last4 = address.slice(-4);
    // Base58-encode the secret key for storage. The same parser handles both
    // forms, so this round-trips with set().
    const privateKey = bs58.encode(kp.secretKey);
    // Zero the local kp ref. JS GC will reclaim; we don't keep a copy.
    const { ciphertext, iv, tag } = encrypt(privateKey);
    const now = Date.now();

    getDb()
      .prepare(
        `INSERT INTO wallet
           (chat_id, ciphertext, iv, tag, last4, address, created_at, updated_at, set_by_username)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           ciphertext       = excluded.ciphertext,
           iv               = excluded.iv,
           tag              = excluded.tag,
           last4            = excluded.last4,
           address          = excluded.address,
           updated_at       = excluded.updated_at,
           set_by_username  = excluded.set_by_username`
      )
      .run(chatId, ciphertext, iv, tag, last4, address, now, now, username);

    return { address, last4 };
  },

  /**
   * Decrypt the stored key for a single user and return a Solana Keypair.
   * Throws if that user has no wallet set or if decryption fails (e.g.
   * moved to a different machine without WALLET_PEPPER).
   */
  getKeypair(chatId) {
    if (chatId == null) throw new Error('walletManager.getKeypair: chatId is required');
    const row = getDb()
      .prepare(`SELECT * FROM wallet WHERE chat_id = ?`)
      .get(chatId);
    if (!row) {
      throw new Error(
        'No trading wallet set for this account. Use /start → 🔑 Wallet to add one.'
      );
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
  hasKey(chatId) {
    if (chatId == null) return false;
    const row = getDb()
      .prepare(`SELECT 1 FROM wallet WHERE chat_id = ?`)
      .get(chatId);
    return !!row;
  },

  /**
   * Status for display: {set, last4, address, createdAt, updatedAt, setBy}.
   * Never returns the private key. Safe to log.
   */
  getStatus(chatId) {
    if (chatId == null) return { set: false };
    const row = getDb()
      .prepare(
        `SELECT last4, address, created_at, updated_at, set_by_username
         FROM wallet WHERE chat_id = ?`
      )
      .get(chatId);
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
   * Wipe this user's wallet. Returns the number of rows deleted (0 or 1).
   * Clears the in-memory key derivation cache so the next set() starts fresh.
   */
  remove(chatId) {
    if (chatId == null) throw new Error('walletManager.remove: chatId is required');
    _derivedKey = null;
    return getDb()
      .prepare(`DELETE FROM wallet WHERE chat_id = ?`)
      .run(chatId).changes;
  },

  /**
   * Number of users with a trading wallet configured. For diagnostics only.
   */
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM wallet`).get().c;
  },

  /**
   * Decrypt the stored key for a single user and return the plaintext private
   * key as a string. Use ONLY for user-initiated export — never log, never
   * include in /status, never broadcast. The caller (Telegram export flow)
   * must auto-delete the message after a short TTL.
   */
  getPrivateKey(chatId) {
    if (chatId == null) throw new Error('walletManager.getPrivateKey: chatId is required');
    const row = getDb()
      .prepare(`SELECT * FROM wallet WHERE chat_id = ?`)
      .get(chatId);
    if (!row) {
      throw new Error('No trading wallet set for this account.');
    }
    let plaintext;
    try {
      plaintext = decrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag });
    } catch (e) {
      throw new Error('Failed to decrypt wallet. Encryption key has changed.');
    }
    return plaintext;
  },
};

// Re-export the scrub helper at the module level too
export { scrub as scrubKey };
