# Architecture

This document describes how SnipeTrenchBot fits together: the data flow,
the modules, the database schema, and the design decisions behind each
one. If you want to extend the bot, start here.

---

## High-level flow

SnipeTrenchBot implements a **reverse copy-trade** flow: when a watched
wallet **sells** its own token, the bot **buys** that token (contrarian
entry), holds for `HOLD_MS`, then **sells** to scalp the bounce.

```
   target wallet
   (dev)                  Helius           Executor (DRY_RUN or LIVE)
    │                       │                       │
    │ create(X) ─────► poll(tx) ────► TOKEN_CREATED │ recordTokenCreated
    │                       │                       │
    │ sell(X)   ─────► poll(tx) ────► SELL_DETECTED │
    │                       │                       │
    │                       │   event               │
    │                       └─────────────────────► │
    │                                               │ guardTrade() ──► safety log
    │                                               │ quote SOL→X (buy)
    │                                               │ (DRY_RUN: log only)
    │                                               │ wait HOLD_MS (1s default)
    │                                               │ quote X→SOL (sell)
    │                                               │ (DRY_RUN: log only)
    │                                               │ record position + PnL
    │                                               │
    │                                  notifier ──► │ 📊 Copy #N + 🔔 Telegram
```

### Why "reverse"?

Traditional copy-trading follows the leader's actions (leader buys →
follower buys). SnipeTrenchBot inverts that — a dev's exit is the bot's
entry signal, betting on the post-dump bounce in thin pump.fun liquidity.
The 1-second hold is a scalp, not an investment.

### Filters
Before the buy, the token must pass the active filter set
(`src/filters.js`, configured via the settings menu): unrenounced mint,
unburned LP, MC range, age range, platform exclusions (pump.fun
internal transfers, etc.). The SELL_DETECTED event is dropped if any
filter fails — no buy, no Telegram notification beyond the audit log.

Two long-running components:

1. **HeliusMonitor** — a polling loop. Every `POLL_INTERVAL_MS`, it walks
   the `watched_wallets` table and calls Helius for each. New transactions
   are classified as `TOKEN_CREATED` or `SELL_DETECTED` and emitted.

2. **TelegramBot** — telegraf long-poll. Listens for user commands and
   sends notifications.

The orchestrator (index.js) wires them together: monitor events go to
the executor, executor results go to the notifier, notifier sends to
Telegram.

---

## Module breakdown

### `src/config.js`

Loads `.env`, validates required fields, exposes a frozen `config` object
plus a `validation` summary. **No other module reads `process.env`
directly** — they import `config` and read from it. This makes the
config surface auditable in one place.

Validation runs at module load time. If required fields are missing,
`config._valid` is `false` and `index.js` exits with a clear error.

### `src/db.js`

Thin wrapper around `better-sqlite3`. Synchronous API (no Promises) —
better-sqlite3 is fast and the database is local, so there's no benefit
to async. Four tables:

| Table            | Purpose                                              |
|------------------|------------------------------------------------------|
| `watched_wallets`| Wallets the user added via `/addwallet`              |
| `positions`      | One row per buy. Status OPEN / CLOSED / FAILED.     |
| `signals`        | Append-only log of every detected + executed signal  |
| `safety_log`     | Every safety event (pause, cap, daily loss)          |

Schema is created idempotently on first open via `CREATE TABLE IF NOT
EXISTS`. There are no migrations — v0.1.0 is the first version, so the
schema is the schema.

### `src/safety.js`

Pure logic. `guardTrade({solAmount})` returns `{allowed, reason, dryRun}`.
Three checks, in order:

1. **Manual pause** — set via `/pause` Telegram command, in-memory.
2. **Per-trade cap** — `solAmount > MAX_SOL_PER_TRADE` → deny.
3. **Daily loss cap** — sum of `pnl_sol` for positions closed today
   (UTC day) where the position is `CLOSED` and the sum is more negative
   than `-DAILY_LOSS_CAP_SOL` → deny.

Every denial is logged to `safety_log` so you can audit why a trade was
skipped. In DRY_RUN mode, every approval is also logged for traceability.

### `src/heliusMonitor.js`

`HeliusMonitor extends EventEmitter`. The polling loop:

```js
async _tick() {
  for each wallet in watched_wallets:
    txs = await helius.fetchTxs(wallet)
    for each new tx (not in seen set):
      event = classifyTx(tx, wallet)  // TOKEN_CREATED or SELL_DETECTED
      if event:
        this.emit('event', event)
        signalsDb.log(event)
}
```

Classification rules (see file for full code):

- **TOKEN_CREATED** — `tx.source === 'PUMP_FUN'` AND fee payer is the
  wallet AND the wallet is the recipient of a new token mint in the
  transaction's token transfers.
- **SELL_DETECTED** — the wallet is the `fromUserAccount` of a token
  transfer AND the `toUserAccount` of a native SOL transfer in the same
  transaction.

The seen-signature Set prevents reprocessing. On a long-running bot this
Set grows without bound; for a portfolio demo with few wallets, this is
fine. A production version would store seen signatures in SQLite and
prune old ones.

### `src/jupiterMetis.js`

Just an HTTP client. `getQuote()` calls the configured Jupiter endpoint
with `inputMint`, `outputMint`, `amount`, and `slippageBps`. Returns the
raw quote or an error object (no exceptions for HTTP errors — caller
decides what to do).

`buildSwapTransaction()` POSTs to the same base URL's `/swap` endpoint
with the quote and `userPublicKey`. Returns a base64-encoded transaction
that the executor deserializes, signs, and submits.

The module is **Jupiter-API-agnostic** — it works with `v6`, `swap/v1`,
or `metis.jup.io` because the request shape is the same. The endpoint
is selected by `JUPITER_API_URL`.

### `src/executor.js`

The trade engine. `executeSignal(event)` is called for every event the
monitor emits. It:

1. Skips `TOKEN_CREATED` events (just records the mint in an in-memory
   map so we know the dev created it).
2. For `SELL_DETECTED`:
   - Verify the dev created this token (we have a record).
   - Call `guardTrade()` to check safety limits.
   - Get a buy quote from Jupiter.
   - Open a `positions` row.
   - Build, sign, submit the buy transaction.
   - Wait `HOLD_MS`.
   - Get a sell quote for the tokens we just bought.
   - Build, sign, submit the sell transaction.
   - Close the `positions` row with the realized PnL.

In DRY_RUN, every step is logged with the amounts that would have been
traded, but no transaction is signed.

The bot's `Keypair` is loaded once at `initExecutor()` time. The
executor does **not** hold the private key in any persistent state — it
lives in memory only, and is GC'd on process exit.

### `src/notifier.js`

Sends messages to Telegram via the attached Telegraf instance. Always
echoes to stdout as a fallback (so DRY_RUN-only deployments still see
output). Each message includes a timestamp and is HTML-formatted for
Telegram.

The notifier is the **only** place Telegram-specific code lives. If you
wanted to add Discord or Slack support, you'd swap this module.

### `src/telegramBot.js`

Telegraf-based command interface. All commands are gated by an
`authMiddleware` that only allows the configured `TELEGRAM_CHAT_ID`. A
stranger who finds your bot cannot add their wallets to your list.

Commands are stateless — they read from / write to the DB, and call
into `safety.js` for pause/resume. The bot doesn't hold any per-user
state; this is a single-owner design.

---

## Database schema

```sql
CREATE TABLE watched_wallets (
  address      TEXT PRIMARY KEY,    -- Solana base58 address
  label        TEXT,                -- optional user-supplied label
  added_at     INTEGER NOT NULL,    -- ms epoch
  last_checked INTEGER NOT NULL DEFAULT 0  -- ms epoch
);

CREATE TABLE positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mint         TEXT NOT NULL,       -- token mint
  dev_wallet   TEXT NOT NULL,       -- dev who created the token
  entry_sig    TEXT,                -- buy tx signature
  entry_time   INTEGER NOT NULL,    -- ms epoch
  entry_sol    REAL NOT NULL,       -- SOL spent on buy
  entry_tokens REAL,                -- expected tokens (from quote outAmount)
  exit_sig     TEXT,                -- sell tx signature
  exit_time    INTEGER,
  exit_sol     REAL,                -- SOL received on sell
  pnl_sol      REAL,                -- exit_sol - entry_sol
  status       TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'FAILED')),
  fail_reason  TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  INTEGER NOT NULL,
  type       TEXT NOT NULL,    -- TOKEN_CREATED | SELL_DETECTED | BUY | SELL | BUY_DENIED
  wallet     TEXT,
  mint       TEXT,
  data_json  TEXT             -- full event JSON
);

CREATE TABLE safety_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  INTEGER NOT NULL,
  type       TEXT NOT NULL,    -- DRY_RUN | CAP_HIT | DAILY_LOSS | PAUSE | ERROR
  details    TEXT
);
```

There are no foreign keys. `positions.mint` and `signals.mint` are plain
TEXT columns. This is intentional — SQLite FK enforcement adds complexity
and the data is read-mostly.

---

## Detection rules in detail

### Token creation

Helius's Enhanced Transactions API returns parsed transactions. For a
Pump.fun token creation:

- `tx.source === 'PUMP_FUN'`
- `tx.transaction.message.accountKeys[0]` is the fee payer (the creator)
- A new mint is created — it appears in `tx.tokenTransfers` as a
  destination of a zero-amount? transfer (Helius normalizes the
  "mint to" event into a transfer record where the dev receives the
  initial supply)

The exact Helius return shape can change between API versions. The
detection in `heliusMonitor.js` is intentionally conservative: it
requires **all three** signals to match (source, fee-payer, token
transfer to dev). If Helius changes its shape, this is the place to
update.

### Sell detection

Pump.fun bonding-curve sells are SWAP instructions. A sell is identified
by:

- The wallet is the `fromUserAccount` of an SPL token transfer
  (positive `tokenAmount`)
- The same wallet is the `toUserAccount` of a native SOL transfer
  (positive `amount` in lamports)

This catches both bonding-curve sells and external DEX sells (Raydium,
etc.) once the token has migrated.

### Why we only trade tokens we recorded as created

A dev can sell tokens they didn't create. The bot ignores those sells.
This is enforced by `isRecentToken()` in `executor.js` which checks the
in-memory `tokenMintByDev` map. The map is populated by
`TOKEN_CREATED` events and is process-local — if you restart the bot,
the map is empty and you start fresh.

If you want to be more forgiving (e.g., trade a sell even if the
creation event was missed), add a persistent record in `db.js` and
adjust `isRecentToken()`. The current default is **strict** — only
tokens we saw the dev create.

---

## Extending the bot

### Add a new command

Edit `src/telegramBot.js`. Add a `bot.command('mycommand', ...)` block
above the `bot.on('text', ...)` line. Restart the bot.

### Add a new event type

1. Add detection logic in `heliusMonitor.js` (a new `isXxx()` function
   and a branch in `classifyTx`).
2. Add a case in `executor.executeSignal()` if the event should trigger
   a trade.
3. Add a notifier method in `notifier.js` for the Telegram message.

### Switch to a different swap venue

`jupiterMetis.js` is the only file that talks to Jupiter. Replace it
with a different aggregator (Raydium, Phoenix, etc.) and the rest of the
bot is unchanged. The interface is: `getBuyQuote({solAmount, outputMint})`
and `getSellQuote({tokenRawAmount, inputMint})`, both returning the raw
quote object.

### Add a real-money wallet to fund the bot

1. Run `npm run generate-wallet`.
2. Paste the printed private key into `.env` as `BOT_WALLET_PRIVATE_KEY`.
3. Send a small amount of SOL to the printed public address.
4. Set `DRY_RUN=false`.
5. Restart the bot.

### Run on a server

```bash
# Install pm2
npm install -g pm2

# Start the bot
pm2 start index.js --name snipetrench

# Watch logs
pm2 logs snipetrench

# Survive reboot
pm2 startup
pm2 save
```

---

## Performance and rate limits

### Helius

Free tier: 100,000 credits/month, ~10 req/sec. Each poll makes one
request per wallet. With 10 wallets and `POLL_INTERVAL_MS=5000`, you
spend ~5,000 credits/day on polling alone — well within free tier.

Enhanced Transactions API credits vary by transaction complexity; a
simple Pump.fun swap is ~1 credit, a complex tx with many transfers is
~5 credits.

### Jupiter

Public v6 API is free and rate-limited to ~10 RPS. The bot makes at
most 2 quote requests + 1 swap request per trade. Trades are triggered
by human-scale events (a dev selling), so RPS is never a concern.

For higher throughput, switch `JUPITER_API_URL` to `api.jup.ag/swap/v1`
and add a `JUPITER_API_KEY`. The newer API is host-aware and supports
private RPC submission for cheaper transactions.

### Telegram

Telegram's bot API is rate-limited per chat. The bot sends at most a
few messages per minute (one per signal, one per trade step, one per
denial). Well within limits.

---

## Security model

### What the bot can do

- Sign and submit Solana transactions from `BOT_WALLET_PRIVATE_KEY`
- Read all transactions for any wallet you put in the watchlist
  (Helius Enhanced API is public-read)

### What the bot cannot do

- Touch wallets other than `BOT_WALLET_PRIVATE_KEY`
- Read your Telegram messages (only listens to the configured chat)
- Make outbound network calls except to Helius, Jupiter, and Telegram

### What you must do to stay safe

- **Never commit `.env`.** It's in `.gitignore`, but double-check.
- **Restrict file permissions.** `chmod 600 .env`.
- **Use a dedicated wallet.** Don't reuse a wallet that holds your
  long-term holdings. Generate with `npm run generate-wallet`.
- **Use a strong VPS or run on hardware you control.** The bot holds a
  hot private key in memory.
- **Monitor for unexpected activity.** Watch the Telegram notifications
  and check `data/snipetrench.db` periodically.
