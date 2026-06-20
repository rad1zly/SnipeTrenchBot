// src/db.js
// =============================================================================
// SQLite persistence layer. Seven tables:
//   - watched_wallets : the dev wallets the user has added via Telegram
//   - positions       : open + closed positions (one row per token bought)
//   - signals         : append-only log of every signal detected and acted on
//   - safety_log      : every safety event (cap hit, daily loss, pause, etc.)
//   - settings        : mutable runtime settings (DB-backed, overrides .env)
//   - subscribers     : every Telegram user who /start'd (multi-user broadcast)
//   - bot_meta        : generic key-value for owner capture, schema version
//   - wallet          : the bot's own trading key (encrypted, single row)
//
// Uses better-sqlite3 (synchronous, fast, single-file). All queries return
// plain JS objects/arrays — no ORM.
// =============================================================================

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'snipetrench.db');

let db = null;

export function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  initSchema(db);
  return db;
}

function initSchema(d) {
  // Watchlist schema note: rows are owned by a chat_id (the Telegram user
  // who added them). v0.6.1 dropped the old global table — see the
  // migration block below. Auto-migrate: drop old table (warn) so the
  // bot can't accidentally leak wallets across users in multi-user mode.
  const cols = d.prepare(`PRAGMA table_info(watched_wallets)`).all();
  const hasChatId = cols.some((c) => c.name === 'chat_id');
  if (cols.length > 0 && !hasChatId) {
    // Old single-owner schema. Snapshot the rows (we may want them) and
    // drop the table. We can't auto-assign ownership — that's the whole
    // point of the migration — so a human re-adds the wallets they still
    // need. Keep the snapshot in a side table for forensic recovery.
    console.warn(
      '[db] watched_wallets is on the old global schema. ' +
      'Backing up rows to `watched_wallets_legacy_global` and recreating with chat_id. ' +
      'Re-add your wallet(s) via /addwallet in Telegram.'
    );
    d.exec(`
      DROP TABLE IF EXISTS watched_wallets_legacy_global;
      CREATE TABLE watched_wallets_legacy_global AS SELECT * FROM watched_wallets;
      DROP TABLE watched_wallets;
    `);
  }
  d.exec(`
    CREATE TABLE IF NOT EXISTS watched_wallets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id      INTEGER NOT NULL,
      address      TEXT    NOT NULL,
      label        TEXT,
      added_at     INTEGER NOT NULL,
      last_checked INTEGER NOT NULL DEFAULT 0,
      copy_count   INTEGER NOT NULL DEFAULT 0,
      last_copy_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(chat_id, address)
    );
    CREATE INDEX IF NOT EXISTS idx_watched_wallets_chat ON watched_wallets(chat_id);
    CREATE INDEX IF NOT EXISTS idx_watched_wallets_address ON watched_wallets(address);
  `);

  // v0.6.2: rename min_mc_sol / max_mc_sol → min_mc_usd / max_mc_usd.
  // MC bounds now live in USD (TradeWiz parity: "MC (USD)"). One-time,
  // idempotent — re-running is a no-op because the old key no longer exists.
  // PATCH v0.7.2-freshinstall: settings table is created further down in
  // initSchema(), so SELECTing from it here crashes on first boot. Defer
  // the migration block to after the CREATE TABLE settings statement.
  // (The actual rename is run a few lines below.)

  d.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      mint         TEXT NOT NULL,
      dev_wallet   TEXT NOT NULL,
      entry_sig    TEXT,
      entry_time   INTEGER NOT NULL,
      entry_sol    REAL NOT NULL,
      entry_tokens REAL,
      exit_sig     TEXT,
      exit_time    INTEGER,
      exit_sol     REAL,
      pnl_sol      REAL,
      pnl_percent  REAL,
      hold_ms      INTEGER,
      status       TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'FAILED')),
      fail_reason  TEXT,
      created_at   INTEGER NOT NULL
    );
    -- v0.8.7.15: chat_id is added via ALTER TABLE in the migration block
    -- below (so existing tables can be upgraded). The CREATE INDEX for
    -- chat_id is also added there, AFTER the ALTER TABLE runs.
    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_dev ON positions(dev_wallet);

    CREATE TABLE IF NOT EXISTS signals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  INTEGER NOT NULL,
      type       TEXT NOT NULL,    -- 'TOKEN_CREATED' | 'DEV_SELL' | 'BUY' | 'SELL'
      wallet     TEXT,
      mint       TEXT,
      data_json  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
    CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
    CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(timestamp);

    CREATE TABLE IF NOT EXISTS safety_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  INTEGER NOT NULL,
      type       TEXT NOT NULL,    -- 'DRY_RUN' | 'CAP_HIT' | 'DAILY_LOSS' | 'PAUSE' | 'ERROR'
      details    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_safety_type ON safety_log(type);

    -- v0.2.0: bot-level metadata (owner chat_id captured on first /start)
    CREATE TABLE IF NOT EXISTS bot_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL
    );

    -- v0.2.0: runtime-mutable settings (DB-backed, override .env)
    -- v0.8.7.15: deprecated. Migrated to user_settings(chat_id, key) below.
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- v0.8.7.15: per-user settings. Replaces the global settings table so
    -- changing fixed_buy_sol for one subscriber doesn't affect others.
    CREATE TABLE IF NOT EXISTS user_settings (
      chat_id    INTEGER NOT NULL,
      key        TEXT    NOT NULL,
      value      TEXT    NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_settings_chat ON user_settings(chat_id);

    -- Multi-user support: anyone who /start'd becomes a subscriber.
    -- The notifier broadcasts to all subscribers. No owner restriction.
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id    INTEGER PRIMARY KEY,
      username   TEXT,
      first_name TEXT,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );

    -- v0.3.0 → v0.7.0 migration: bot's own trading wallet, encrypted at rest.
    -- v0.7.0 changed from single global row (id=1) to per-user (chat_id PK) so
    -- each Telegram subscriber can have their own trading wallet and other
    -- subscribers can't see its address. Plaintext key never appears on disk;
    -- only ciphertext + IV + auth tag. Decryption is per-chatId via
    -- walletManager.
    CREATE TABLE IF NOT EXISTS wallet (
      chat_id         INTEGER PRIMARY KEY,
      ciphertext      BLOB NOT NULL,
      iv              BLOB NOT NULL,
      tag             BLOB NOT NULL,
      last4           TEXT NOT NULL,
      address         TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      set_by_username TEXT
    );
  `);

  // v0.8.0 (added by feature: win/loss tracking + wallet balance):
  // idempotent column adds for older DBs that pre-date these fields.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so we check pragma first.
  const posCols = d.prepare(`PRAGMA table_info(positions)`).all().map((c) => c.name);
  if (!posCols.includes('pnl_percent')) {
    d.exec(`ALTER TABLE positions ADD COLUMN pnl_percent REAL;`);
  }
  if (!posCols.includes('hold_ms')) {
    d.exec(`ALTER TABLE positions ADD COLUMN hold_ms INTEGER;`);
  }
  // v0.8.7.15: add chat_id column for per-user position isolation.
  // Existing rows get NULL chat_id (legacy pre-isolation data). The
  // global aggregate queries still work; per-user queries just skip them.
  if (!posCols.includes('chat_id')) {
    d.exec(`ALTER TABLE positions ADD COLUMN chat_id INTEGER;`);
    // For single-user setups (one bot owner watching one wallet), backfill
    // existing rows to the owner's chat_id. Multi-user setups will have
    // NULL chat_id on legacy positions — that's OK, they're historical.
    const subs = d.prepare(`SELECT chat_id FROM subscribers`).all();
    if (subs.length === 1) {
      d.prepare(`UPDATE positions SET chat_id = ? WHERE chat_id IS NULL`).run(subs[0].chat_id);
      console.log(`[db] v0.8.7.15: backfilled positions.chat_id for single-user setup (chat_id=${subs[0].chat_id})`);
    }
    // Add the index AFTER the column exists (CREATE INDEX above only ran
    // for fresh installs where chat_id was in the CREATE TABLE; for
    // upgrades we need to add it here).
    d.exec(`CREATE INDEX IF NOT EXISTS idx_positions_chat ON positions(chat_id);`);
  }

  // ---------------------------------------------------------------------------
  // v0.6.2 migration: rename min_mc_sol / max_mc_sol → min_mc_usd / max_mc_usd.
  // MC bounds now live in USD (TradeWiz parity: "MC (USD)"). One-time,
  // idempotent — re-running is a no-op because the old key no longer exists.
  //
  // PATCH v0.7.2-freshinstall: this block USED TO live at the top of
  // initSchema() (before the CREATE TABLE settings statement). On a fresh
  // install, the SELECT crashed with "no such table: settings". Moved here
  // and wrapped in try/catch so fresh installs and upgrades both work.
  // ---------------------------------------------------------------------------
  try {
    const mcOldMin = d.prepare(`SELECT key FROM settings WHERE key = 'min_mc_sol'`).get();
    const mcOldMax = d.prepare(`SELECT key FROM settings WHERE key = 'max_mc_sol'`).get();
    if (mcOldMin || mcOldMax) {
      console.log('[db] migrating settings: min/max_mc_sol → min/max_mc_usd');
      if (mcOldMin) d.prepare(`UPDATE settings SET key = 'min_mc_usd' WHERE key = 'min_mc_sol'`).run();
      if (mcOldMax) d.prepare(`UPDATE settings SET key = 'max_mc_usd' WHERE key = 'max_mc_sol'`).run();
    }
  } catch (e) {
    // Fresh install — no legacy keys to migrate. Safe to ignore.
  }

  // ---------------------------------------------------------------------------
  // One-shot migration: if the legacy single-row wallet table is present,
  // move the row to the new per-user schema (using set_by_chat_id as the new
  // PK) and replace the table. Safe to run on every boot — it no-ops if the
  // legacy columns no longer exist.
  // ---------------------------------------------------------------------------
  const walletCols = getDb().prepare(`PRAGMA table_info(wallet)`).all().map((c) => c.name);
  if (walletCols.includes('id') && walletCols.includes('set_by_chat_id')) {
    // OLD shape: id PK, set_by_chat_id. Read it before we drop.
    const legacy = getDb()
      .prepare(`SELECT * FROM wallet WHERE id = 1`)
      .get();
    // Replace the table with the new per-user schema. The CREATE TABLE IF
    // NOT EXISTS at the top of initSchema() was a no-op because the old
    // table already existed, so we need to drop & recreate here.
    getDb().exec(`DROP TABLE IF EXISTS wallet;`);
    getDb().exec(`
      CREATE TABLE wallet (
        chat_id         INTEGER PRIMARY KEY,
        ciphertext      BLOB NOT NULL,
        iv              BLOB NOT NULL,
        tag             BLOB NOT NULL,
        last4           TEXT NOT NULL,
        address         TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        set_by_username TEXT
      );
    `);
    if (legacy && legacy.set_by_chat_id != null) {
      getDb()
        .prepare(
          `INSERT INTO wallet (chat_id, ciphertext, iv, tag, last4, address,
                               created_at, updated_at, set_by_username)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          legacy.set_by_chat_id,
          legacy.ciphertext,
          legacy.iv,
          legacy.tag,
          legacy.last4,
          legacy.address,
          legacy.created_at,
          legacy.updated_at,
          legacy.set_by_username
        );
      console.log(
        `[db] migrated legacy single-row wallet → chat_id=${legacy.set_by_chat_id} (address ...${legacy.last4})`
      );
    } else if (legacy) {
      console.log(
        '[db] legacy wallet row had no set_by_chat_id — wallet dropped. ' +
          'Re-add it via /start → 🔑 Wallet.'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // v0.8.7.15 migration: per-user settings + per-user pause.
  //
  // Background: v0.2.0 stored all settings in a single global `settings` table
  // (key, value). v0.7.0 added `subscribers` and per-user wallet, but settings
  // were still global — so /pause from any user paused for everyone, and
  // setting fixed_buy_sol from user A changed it for user B too.
  //
  // Fix: new `user_settings(chat_id, key, value)` table. On first boot with
  // the new code, we copy every row of the legacy `settings` table into
  // user_settings for each existing subscriber. Each user starts with the
  // same baseline, but from there they can diverge.
  //
  // Pause state: was `bot_meta.paused` (global). Migrated to a special
  // user_settings row with key='_pause' for unified handling.
  //
  // Idempotency: marked complete via bot_meta._settings_migrated_v2 = 'true'.
  // Re-runs are no-ops.
  // ---------------------------------------------------------------------------
  const migrationDone = d
    .prepare(`SELECT value FROM bot_meta WHERE key = '_settings_migrated_v2'`)
    .get();
  if (!migrationDone) {
    const subscribers = d.prepare(`SELECT chat_id FROM subscribers`).all();
    const legacyRows = d
      .prepare(`SELECT key, value, updated_at FROM settings`)
      .all();
    const now = Date.now();

    if (subscribers.length === 0) {
      // No subscribers yet — migration is a no-op. Mark complete so we don't
      // re-check on every boot. New subscribers will get default settings.
      d.prepare(
        `INSERT OR REPLACE INTO bot_meta (key, value, updated_at) VALUES ('_settings_migrated_v2', 'true', ?)`
      ).run(now);
      console.log(
        '[db] v0.8.7.15 settings migration: 0 subscribers — skipping (defaults will apply to future users).'
      );
    } else {
      const insert = d.prepare(
        `INSERT OR IGNORE INTO user_settings (chat_id, key, value, updated_at) VALUES (?, ?, ?, ?)`
      );
      let totalCopies = 0;
      const tx = d.transaction((subs, rows, ts) => {
        for (const sub of subs) {
          for (const row of rows) {
            insert.run(sub.chat_id, row.key, row.value, ts);
            totalCopies++;
          }
        }
      });
      tx(subscribers, legacyRows, now);

      // Migrate global pause state. v0.8.7.15 fix: the global pause was
      // a BUG (user A pressing /pause paused everyone). On migration, we
      // DON'T propagate the global pause state — each subscriber starts
      // UNPAUSED, which matches the original intent ("I want to pause MY
      // own bot, not everyone else's"). If a user genuinely wants to be
      // paused, they can /pause after the migration runs.
      //
      // Legacy bot_meta.paused row is left in place for forensic purposes.
      // Note: encode boolean as JSON 'false' string (matches userSettingsDb.set
      // which JSON.stringify()s the value before INSERT).
      for (const sub of subscribers) {
        insert.run(sub.chat_id, '_pause', 'false', now);
      }

      d.prepare(
        `INSERT OR REPLACE INTO bot_meta (key, value, updated_at) VALUES ('_settings_migrated_v2', 'true', ?)`
      ).run(now);

      console.log(
        `[db] v0.8.7.15 settings migration: ${legacyRows.length} keys × ${subscribers.length} subscribers = ${totalCopies} rows copied to user_settings. ` +
          `Global pause was a bug — all subscribers default to UNPAUSED.`
      );

      // Keep legacy `settings` rows around for read-only fallback during the
      // transition period (v0.8.7.15+ reads user_settings first). Do NOT drop
      // — if something reads `settings` directly (custom scripts, debugging),
      // the data is still there. Future major version can drop it.
    }
  }
}

// =============================================================================
// watched_wallets (v0.6.1: per-user, owned by chat_id)
// =============================================================================
// copy_count: number of times the bot has copied this wallet's trade.
// last_copy_at: ms epoch of the last successful copy (used for "X minutes ago"
//               displays in /wallets and notifier messages).
//
// All public methods are scoped to a chat_id so the watchlist stays private
// in multi-user mode. The Helius monitor uses `listAll()` to get the union
// of unique addresses to poll — that's the only place ownership is
// deliberately ignored.
// =============================================================================
export const walletsDb = {
  /** Add (or no-op) a wallet for the given user. */
  add({ chatId, address, label = null }) {
    if (chatId == null) throw new Error('walletsDb.add: chatId is required');
    const now = Date.now();
    return getDb()
      .prepare(
        `INSERT OR IGNORE INTO watched_wallets (chat_id, address, label, added_at) VALUES (?, ?, ?, ?)`
      )
      .run(chatId, address, label, now);
  },
  /** Remove a wallet, but only if it belongs to this user. Returns # rows deleted. */
  remove({ chatId, address }) {
    if (chatId == null) throw new Error('walletsDb.remove: chatId is required');
    return getDb()
      .prepare(`DELETE FROM watched_wallets WHERE chat_id = ? AND address = ?`)
      .run(chatId, address).changes;
  },
  /** List this user's wallets. */
  list(chatId) {
    if (chatId == null) throw new Error('walletsDb.list: chatId is required');
    return getDb()
      .prepare(`SELECT * FROM watched_wallets WHERE chat_id = ? ORDER BY added_at DESC`)
      .all(chatId);
  },
  /** Union of all unique addresses across all users — for the Helius monitor. */
  listAll() {
    return getDb()
      .prepare(`SELECT DISTINCT address FROM watched_wallets`)
      .all()
      .map((r) => r.address);
  },
  /** Fetch the first row matching `address` (any owner). Returns the owning chatId. */
  get(address) {
    return getDb()
      .prepare(`SELECT * FROM watched_wallets WHERE address = ? LIMIT 1`)
      .get(address);
  },
  /**
   * v0.8.0: list ALL owners of `address` (every user who added it).
   * Used by the monitor/notifier to fan out signals to all watchers
   * of the same wallet (was: only the first owner — privacy bug).
   */
  listOwners(address) {
    return getDb()
      .prepare(`SELECT * FROM watched_wallets WHERE address = ? ORDER BY added_at ASC`)
      .all(address);
  },
  touchAll() {
    return getDb()
      .prepare(`UPDATE watched_wallets SET last_checked = ?`)
      .run(Date.now()).changes;
  },
  touchOne(address) {
    return getDb()
      .prepare(`UPDATE watched_wallets SET last_checked = ? WHERE address = ?`)
      .run(Date.now(), address).changes;
  },
  /** Per-user count. */
  count(chatId) {
    if (chatId == null) throw new Error('walletsDb.count: chatId is required');
    return getDb()
      .prepare(`SELECT COUNT(*) as c FROM watched_wallets WHERE chat_id = ?`)
      .get(chatId).c;
  },
  // --- v0.6.0: copy-trade stats ---
  // Atomic increment + stamp. Single UPDATE so two concurrent trades can't
  // race. Returns the new count (or 0 if the wallet was removed mid-trade).
  markCopied(address) {
    const now = Date.now();
    return getDb()
      .prepare(
        `UPDATE watched_wallets
         SET copy_count = copy_count + 1, last_copy_at = ?
         WHERE address = ?`
      )
      .run(now, address).changes;
  },
  incrementCopyCount(address) {
    return getDb()
      .prepare(`UPDATE watched_wallets SET copy_count = copy_count + 1 WHERE address = ?`)
      .run(address).changes;
  },
  setLastCopyAt(address, ts = Date.now()) {
    return getDb()
      .prepare(`UPDATE watched_wallets SET last_copy_at = ? WHERE address = ?`)
      .run(ts, address).changes;
  },
  // Returns { copy_count, last_copy_at } for one wallet, or null if not found.
  getStats(address) {
    const row = getDb()
      .prepare(`SELECT copy_count, last_copy_at FROM watched_wallets WHERE address = ? LIMIT 1`)
      .get(address);
    if (!row) return null;
    return { copy_count: row.copy_count, last_copy_at: row.last_copy_at };
  },
  // Per-user aggregate. Without chatId, sums across all users.
  totalCopies(chatId = null) {
    const row = chatId == null
      ? getDb().prepare(`SELECT COALESCE(SUM(copy_count), 0) AS total FROM watched_wallets`).get()
      : getDb()
          .prepare(`SELECT COALESCE(SUM(copy_count), 0) AS total FROM watched_wallets WHERE chat_id = ?`)
          .get(chatId);
    return row.total || 0;
  },
};

// =============================================================================
// positions
// =============================================================================
export const positionsDb = {
  /**
   * Open a new position. v0.8.7.15: chatId is REQUIRED so each user's
   * positions are isolated. Trades are tied to the Telegram user who set
   * up the watchlist (and whose wallet is being debited).
   */
  open({ chatId, mint, devWallet, entrySig, entrySol, entryTokens = null }) {
    if (chatId == null) throw new Error('positionsDb.open: chatId is required');
    const now = Date.now();
    return getDb()
      .prepare(`
        INSERT INTO positions (chat_id, mint, dev_wallet, entry_sig, entry_time, entry_sol, entry_tokens, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
      `)
      .run(chatId, mint, devWallet, entrySig, now, entrySol, entryTokens, now);
  },
  close(id, { exitSig, exitSol, pnlSol, pnlPercent = null, holdMs = null }) {
    return getDb()
      .prepare(`
        UPDATE positions
        SET exit_sig = ?, exit_time = ?, exit_sol = ?, pnl_sol = ?,
            pnl_percent = COALESCE(?, pnl_percent),
            hold_ms = COALESCE(?, hold_ms),
            status = 'CLOSED'
        WHERE id = ?
      `)
      .run(exitSig, Date.now(), exitSol, pnlSol, pnlPercent, holdMs, id);
  },
  fail(id, reason) {
    return getDb()
      .prepare(`UPDATE positions SET status = 'FAILED', fail_reason = ?, exit_time = ? WHERE id = ?`)
      .run(reason, Date.now(), id);
  },
  byId(id) {
    return getDb().prepare(`SELECT * FROM positions WHERE id = ?`).get(id);
  },
  openForMint(mint, chatId) {
    // v0.8.7.15: per-user. Each subscriber's open positions on this mint are
    // counted independently, so user A's buys don't cap user B's buys.
    // chatId is REQUIRED.
    if (chatId == null) throw new Error('positionsDb.openForMint: chatId is required');
    return getDb()
      .prepare(`SELECT * FROM positions WHERE mint = ? AND status = 'OPEN' AND chat_id = ?`)
      .all(mint, chatId);
  },
  openForDev(devWallet, chatId = null) {
    // v0.8.7.15: optional chatId for per-user filtering. If null, returns all
    // open positions for that dev wallet across all users (used by monitors).
    if (chatId == null) {
      return getDb()
        .prepare(`SELECT * FROM positions WHERE dev_wallet = ? AND status = 'OPEN'`)
        .all(devWallet);
    }
    return getDb()
      .prepare(`SELECT * FROM positions WHERE dev_wallet = ? AND status = 'OPEN' AND chat_id = ?`)
      .all(devWallet, chatId);
  },
  openAll(chatId = null) {
    // v0.8.7.15: optional chatId. Default (null) = all users (used by
    // monitor / cleanup jobs). Per-user view filters to one subscriber.
    if (chatId == null) {
      return getDb().prepare(`SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_time DESC`).all();
    }
    return getDb()
      .prepare(`SELECT * FROM positions WHERE status = 'OPEN' AND chat_id = ? ORDER BY entry_time DESC`)
      .all(chatId);
  },
  recent(limit = 20, chatId = null) {
    // v0.8.7.15: optional chatId for per-user history.
    if (chatId == null) {
      return getDb()
        .prepare(`SELECT * FROM positions ORDER BY created_at DESC LIMIT ?`)
        .all(limit);
    }
    return getDb()
      .prepare(`SELECT * FROM positions WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(chatId, limit);
  },
  realizedPnlSince(sinceMs, chatId = null) {
    // v0.8.7.15: optional chatId for per-user daily PnL. Default (null) =
    // global aggregate across all users.
    if (chatId == null) {
      const row = getDb()
        .prepare(`
          SELECT COALESCE(SUM(pnl_sol), 0) as total,
                 COUNT(*) as n
          FROM positions
          WHERE status = 'CLOSED' AND exit_time >= ?
        `)
        .get(sinceMs);
      return { total: row.total, count: row.n };
    }
    const row = getDb()
      .prepare(`
        SELECT COALESCE(SUM(pnl_sol), 0) as total,
               COUNT(*) as n
        FROM positions
        WHERE status = 'CLOSED' AND chat_id = ? AND exit_time >= ?
      `)
      .get(chatId, sinceMs);
    return { total: row.total, count: row.n };
  },
  /**
   * Total SOL spent on entry for positions opened by one user since `sinceMs`.
   * v0.8.7.15: per-user. Each subscriber's daily cap is enforced independently.
   * chatId is REQUIRED — global "today spent" is the leak we're fixing.
   */
  spentSince(chatId, sinceMs) {
    if (chatId == null) throw new Error('positionsDb.spentSince: chatId is required');
    const row = getDb()
      .prepare(`
        SELECT COALESCE(SUM(entry_sol), 0) as total,
               COUNT(*) as n
        FROM positions
        WHERE chat_id = ? AND created_at >= ?
      `)
      .get(chatId, sinceMs);
    return row.total || 0;
  },

  // ---------------------------------------------------------------------
  // v0.8.0: win/loss tracking (referenced from charon/src/learning/summary.js)
  // ---------------------------------------------------------------------
  // Aggregates over CLOSED positions only. pnl_sol > 0  → win, < 0 → loss.
  // pnl_percent is computed when missing using pnl_sol / entry_sol.
  //
  //   winStats()        — global (all users, all watched wallets)
  //   winStats(chatId)  — scoped to one user via the dev_wallet → watched_wallets
  //                       join, so per-user addwallet isolation is preserved
  //
  // Returns:
  //   {
  //     totalClosed, wins, losses, breakeven,
  //     winRate,                  // 0..100
  //     totalPnlSol,
  //     totalPnlPercent,
  //     avgPnlPercent,
  //     avgHoldMs,
  //     best: [{ mint, pnlSol, pnlPercent, exitTime }],
  //     worst: [{ mint, pnlSol, pnlPercent, exitTime }],
  //   }
  winStats(chatId = null) {
    // Compute pnl_percent on the fly if the column is null (older rows).
    // Use entry_sol > 0 guard to avoid div-by-zero.
    const baseQuery = chatId == null
      ? `SELECT id, mint, entry_sol, pnl_sol, pnl_percent, hold_ms, exit_time
         FROM positions WHERE status = 'CLOSED' AND pnl_sol IS NOT NULL`
      : `SELECT p.id, p.mint, p.entry_sol, p.pnl_sol, p.pnl_percent, p.hold_ms, p.exit_time
         FROM positions p
         JOIN watched_wallets w ON w.address = p.dev_wallet
         WHERE p.status = 'CLOSED' AND p.pnl_sol IS NOT NULL AND w.chat_id = ?`;
    const rows = chatId == null
      ? getDb().prepare(baseQuery).all()
      : getDb().prepare(baseQuery).all(chatId);

    let wins = 0, losses = 0, breakeven = 0;
    let totalPnlSol = 0, totalPnlPercent = 0, totalHoldMs = 0, holdN = 0;
    for (const r of rows) {
      const pnlSol = Number(r.pnl_sol || 0);
      // Derive pnl_percent if not stored: (pnl / entry) * 100
      const pnlPct = r.pnl_percent != null
        ? Number(r.pnl_percent)
        : (r.entry_sol > 0 ? (pnlSol / Number(r.entry_sol)) * 100 : 0);
      totalPnlSol += pnlSol;
      totalPnlPercent += pnlPct;
      if (r.hold_ms != null) { totalHoldMs += Number(r.hold_ms); holdN += 1; }
      if (pnlSol > 0) wins += 1;
      else if (pnlSol < 0) losses += 1;
      else breakeven += 1;
    }
    const totalClosed = rows.length;
    const winRate = totalClosed ? (wins / totalClosed) * 100 : null;

    const sorted = [...rows].sort((a, b) => Number(b.pnl_sol || 0) - Number(a.pnl_sol || 0));
    const proj = (r) => {
      const pnlSol = Number(r.pnl_sol || 0);
      const pnlPct = r.pnl_percent != null
        ? Number(r.pnl_percent)
        : (r.entry_sol > 0 ? (pnlSol / Number(r.entry_sol)) * 100 : 0);
      return {
        id: r.id,
        mint: r.mint,
        pnlSol,
        pnlPercent: pnlPct,
        exitTime: r.exit_time,
      };
    };

    return {
      totalClosed,
      wins,
      losses,
      breakeven,
      winRate,                                       // 0..100, null if no trades
      totalPnlSol,
      totalPnlPercent,
      avgPnlPercent: totalClosed ? totalPnlPercent / totalClosed : null,
      avgHoldMs: holdN ? totalHoldMs / holdN : null,
      best: sorted.slice(0, 5).map(proj),
      worst: sorted.slice(-5).reverse().map(proj),
    };
  },
};

// =============================================================================
// signals (append-only audit log)
// =============================================================================
export const signalsDb = {
  log({ type, wallet = null, mint = null, data = null }) {
    return getDb()
      .prepare(`
        INSERT INTO signals (timestamp, type, wallet, mint, data_json)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(Date.now(), type, wallet, mint, data ? JSON.stringify(data) : null);
  },
  recent(limit = 50, typeFilter = null) {
    if (typeFilter) {
      return getDb()
        .prepare(`SELECT * FROM signals WHERE type = ? ORDER BY id DESC LIMIT ?`)
        .all(typeFilter, limit);
    }
    return getDb().prepare(`SELECT * FROM signals ORDER BY id DESC LIMIT ?`).all(limit);
  },
};

// =============================================================================
// safety_log
// =============================================================================
export const safetyDb = {
  log({ type, details = null }) {
    return getDb()
      .prepare(`INSERT INTO safety_log (timestamp, type, details) VALUES (?, ?, ?)`)
      .run(Date.now(), type, details);
  },
  recent(limit = 50) {
    return getDb().prepare(`SELECT * FROM safety_log ORDER BY id DESC LIMIT ?`).all(limit);
  },
};

// =============================================================================
// subscribers (multi-user)
// =============================================================================
export const subscribersDb = {
  add({ chatId, username = null, firstName = null }) {
    if (chatId == null) return null;
    const now = Date.now();
    return getDb()
      .prepare(`
        INSERT INTO subscribers (chat_id, username, first_name, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_seen = excluded.last_seen
      `)
      .run(chatId, username, firstName, now, now);
  },
  remove(chatId) {
    return getDb().prepare(`DELETE FROM subscribers WHERE chat_id = ?`).run(chatId).changes;
  },
  list() {
    return getDb().prepare(`SELECT * FROM subscribers ORDER BY last_seen DESC`).all();
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM subscribers`).get().c;
  },
};

// =============================================================================
// bot_meta (generic key-value store for runtime state)
// =============================================================================
export const metaDb = {
  get(key) {
    const row = getDb().prepare(`SELECT value FROM bot_meta WHERE key = ?`).get(key);
    return row?.value ?? null;
  },
  set(key, value) {
    return getDb()
      .prepare(`
        INSERT INTO bot_meta (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, String(value), Date.now());
  },
  delete(key) {
    return getDb().prepare(`DELETE FROM bot_meta WHERE key = ?`).run(key).changes;
  },
  all() {
    return getDb().prepare(`SELECT * FROM bot_meta ORDER BY key`).all();
  },
};

// =============================================================================
// settings (DB-backed key/value, JSON-encoded values)
// =============================================================================
export const settingsDb = {
  get(key) {
    const row = getDb()
      .prepare(`SELECT value, updated_at FROM settings WHERE key = ?`)
      .get(key);
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value), updated_at: row.updated_at };
    } catch {
      return { value: row.value, updated_at: row.updated_at };
    }
  },
  set(key, value) {
    const encoded = JSON.stringify(value);
    return getDb()
      .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, encoded, Date.now());
  },
  delete(key) {
    return getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key).changes;
  },
  all() {
    const rows = getDb().prepare(`SELECT * FROM settings ORDER BY key`).all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = { value: JSON.parse(row.value), updated_at: row.updated_at };
      } catch {
        result[row.key] = { value: row.value, updated_at: row.updated_at };
      }
    }
    return result;
  },
  count() {
    return getDb().prepare(`SELECT COUNT(*) as c FROM settings`).get().c;
  },
};

// =============================================================================
// user_settings (v0.8.7.15: per-Telegram-subscriber settings)
//
// Replaces `settingsDb` for all production code. Each user has their own
// copy of every setting, so changes from one subscriber don't leak to others.
// chat_id is REQUIRED for all read/write operations — the API will throw if
// it's missing, since "global settings" is the bug we're fixing, not a
// supported mode.
// =============================================================================
export const userSettingsDb = {
  /** Get one setting for one user. Returns {value, updated_at} or null. */
  get(chatId, key) {
    if (chatId == null) throw new Error('userSettingsDb.get: chatId is required (per-user isolation)');
    if (key == null) throw new Error('userSettingsDb.get: key is required');
    const row = getDb()
      .prepare(`SELECT value, updated_at FROM user_settings WHERE chat_id = ? AND key = ?`)
      .get(chatId, key);
    if (!row) return null;
    try {
      return { value: JSON.parse(row.value), updated_at: row.updated_at };
    } catch {
      return { value: row.value, updated_at: row.updated_at };
    }
  },
  /** Upsert one setting for one user. */
  set(chatId, key, value) {
    if (chatId == null) throw new Error('userSettingsDb.set: chatId is required');
    if (key == null) throw new Error('userSettingsDb.set: key is required');
    const encoded = JSON.stringify(value);
    return getDb()
      .prepare(`
        INSERT INTO user_settings (chat_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(chatId, key, encoded, Date.now());
  },
  /** Delete one setting for one user (resets to env/default). */
  delete(chatId, key) {
    if (chatId == null) throw new Error('userSettingsDb.delete: chatId is required');
    if (key == null) throw new Error('userSettingsDb.delete: key is required');
    return getDb()
      .prepare(`DELETE FROM user_settings WHERE chat_id = ? AND key = ?`)
      .run(chatId, key).changes;
  },
  /** All settings for one user as a key→{value,updated_at} object. */
  all(chatId) {
    if (chatId == null) throw new Error('userSettingsDb.all: chatId is required');
    const rows = getDb()
      .prepare(`SELECT key, value, updated_at FROM user_settings WHERE chat_id = ? ORDER BY key`)
      .all(chatId);
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = { value: JSON.parse(row.value), updated_at: row.updated_at };
      } catch {
        result[row.key] = { value: row.value, updated_at: row.updated_at };
      }
    }
    return result;
  },
  /** Count distinct users with at least one setting. */
  userCount() {
    return getDb()
      .prepare(`SELECT COUNT(DISTINCT chat_id) as c FROM user_settings`)
      .get().c;
  },
};

// =============================================================================
// wallet (encrypted bot trading key, single row id=1)
// =============================================================================
// Thin read-only accessors. All write paths go through walletManager.js so
// the encryption/decryption logic stays in one place. These helpers exist
// for status displays and tests that need to inspect ciphertext metadata
// without triggering a decryption.
// =============================================================================
export const walletDb = {
  exists() {
    return !!getDb().prepare(`SELECT 1 FROM wallet WHERE id = 1`).get();
  },
  meta() {
    const row = getDb()
      .prepare(
        `SELECT last4, address, created_at, updated_at, set_by_chat_id, set_by_username
         FROM wallet WHERE id = 1`
      )
      .get();
    if (!row) return null;
    return row;
  },
  raw() {
    // Returns the encrypted blob. NEVER log this — it IS the secret at rest.
    return getDb()
      .prepare(`SELECT ciphertext, iv, tag, last4, address FROM wallet WHERE id = 1`)
      .get();
  },
};
