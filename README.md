# SnipeTrenchBot

> **Reverse copy-trade** bot for Solana, controlled from Telegram. Watches
> Pump.fun dev wallets, executes a Jupiter **BUY** the moment a watched
> wallet **SELLs** its own token, holds for 1 second, and exits.
> **Documentation-first, safety-first.**

This is the trimmed-down, single-purpose version of the larger SnipeTrench
project. The earlier tracker/cluster-detection work lives in a separate
folder and is paused — this repo is the one that trades.

---

## 🔁 What is "reverse copy-trade"?

Traditional copy-trading follows the leader: if the target **buys**, the
follower **buys**. SnipeTrenchBot inverts that — it uses a target wallet's
exit as an *entry signal*:

```
Target wallet         Bot
─────────────         ───
create(X)  ────────►  (record X as a known dev-token)
sell(X)    ────────►  buy(X)         ← contrarian entry, snipe the dump
... 1 second ...
                     sell(X)        ← scalp exit
```

The thesis is momentum + thin liquidity: a dev's own sell often dumps the
chart by 30-80% in seconds, but if there are still buyers in the book
(a real community, not just snipers), the price recovers in the same
minute. The 1-second hold captures the bounce, the second sell is the
exit. This is a **scalp, not an investment** — see [RISK.md](RISK.md).

---

## ⚠️ Read this first

This bot **executes real financial transactions** on Solana when configured
to do so. Pump.fun tokens are extremely volatile and most lose value within
hours. The 1-second hold pattern is a scalp, not an investment.

**Do not fund the bot wallet with more than you can lose in one session.**

Defaults are set so that the bot can only lose `MAX_SOL_PER_TRADE` per
trade and `DAILY_LOSS_CAP_SOL` per day. With the defaults, that is 0.01
SOL per trade and 0.05 SOL per day — adjust to your risk tolerance.

See [RISK.md](RISK.md) for a full discussion.

---

## What it does

```
 ┌──────────┐    /addwallet      ┌──────────────┐
 │   You    │ ─────────────────► │   Wallets   │
 │ Telegram │                    │  (SQLite)    │
 └────┬─────┘                    └──────┬───────┘
      │                                │
      │  start/stop/status             │  poll every N seconds
      │                                ▼
      │                       ┌──────────────────┐
      │                       │  Helius Monitor  │
      │                       │  (Enhanced Tx)   │
      │                       └─────────┬────────┘
      │                                 │  event
      │                                 ▼
      │   notifications    ┌──────────────────────┐
      │ ◄──────────────────┤  Executor            │
      │                    │  1. Quote (buy)      │
      │                    │  2. Sign + submit    │
      │                    │  3. Wait HOLD_MS     │
      │                    │  4. Quote (sell)     │
      │                    │  5. Sign + submit    │
      │                    └──────────┬───────────┘
      │                               │
      │                               ▼
      │                       ┌──────────────┐
      └──────────────────────►│  Jupiter     │
            notifications    │  (v6 / Metis)│
                              └──────────────┘
```

The bot only ever trades **tokens it saw a watched wallet create**. If
wallet `A` creates token `X`, then later `A` sells `X`, the bot buys `X`
with `MAX_SOL_PER_TRADE` SOL, holds `HOLD_MS` (default 1 second), and
sells. The expected PnL is the spread between buy and sell quotes minus
Jupiter's fee and slippage.

---

## 📊 Reverse copy-trade stats (v0.6.0+)

Each watched wallet tracks two stats so you can see how often the bot
has sniped a given dev's exit:

- `copy_count` — total number of times the bot has executed a reverse
  copy-trade for this wallet since it was added to the watchlist. A
  "copy" here is one full buy-then-sell cycle triggered by a SELL_DETECTED.
- `last_copy_at` — ms epoch of the most recent reverse copy.

These are visible in:

- `/wallets` (per-wallet line) and the main menu status bar (aggregate
  "Copies" count).
- The startup notification (`🟢 Bot started` message) — shows the total
  copies so far across the whole watchlist.
- The `[monitor]` log line on each poll — shows the wallet's running
  copy_count.
- The `🔔 DEV SELL DETECTED` notification — prepended with
  `📊 Copy #N for this wallet` so you can see hot wallets at a glance.

Stats are updated atomically (`UPDATE ... SET copy_count = copy_count + 1`)
inside the executor's BUY_OK path, after the position is opened and the
BUY signal is logged — so a stats-DB hiccup never blocks the trade.

---

## Quick start

### 1. Install

```bash
cd SnipeTrenchBot
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — see "Configuration" below for what is required.
```

The minimum you need to set in `.env`:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `HELIUS_API_KEY` — from [helius.dev](https://helius.dev) (free)

> `TELEGRAM_CHAT_ID` is **no longer required**. The bot runs in
> multi-user broadcast mode: any user who `/start`s is auto-added to
> a `subscribers` table and receives notifications. Use `/stop` to
> unsubscribe. See "Multi-user mode" below.

For **live trading** you also need:
- `DRY_RUN=false`
- A trading wallet, set via the bot's own UI (see "Trading wallet" below) — **no longer in `.env`**

#### Trading wallet (encrypted at rest, set via Telegram)

The bot's trading private key is **not** stored in `.env`. As of v0.3.0
you set it directly in the bot:

1. Open Telegram, send `/start` to your bot
2. Tap **🔑 Wallet**
3. Tap **➕ Set Wallet**
4. Send your private key (Base58 string or JSON array)
5. The bot encrypts it with **AES-256-GCM** and stores the ciphertext in
   the local SQLite database (`data/snipetrench.db`, table `wallet`,
   single row)
6. Your key message is **automatically deleted from the chat** immediately
   after the bot receives it — Telegram bot API can delete user messages
   in private chats

The encryption key is derived from your host's `machine-id` plus an
optional `WALLET_PEPPER` from `.env`. Without the pepper, the wallet is
bound to the host it was set on (the DB is useless on another machine).
With the pepper, the wallet is portable — useful when you move the bot
to a new VPS. See `.env.example` for the full trade-off discussion.

**To remove the wallet:** `/start` → 🔑 Wallet → 🗑 Remove Wallet. The
encrypted row is deleted and the bot can no longer sign transactions.

**To display the wallet:** the bot shows the public address and last 4
chars in the main menu and `/status`. The full key is never displayed
or logged.

#### Multi-user mode

When the bot starts, no `chat_id` is fixed in `.env`. Instead:

1. **Any user** who sends `/start` is added to the `subscribers`
   SQLite table (`chat_id`, `username`, `first_name`, `last_seen`).
2. **All notifications** (token created, sell detected, trade steps,
   PnL) are broadcast to every subscriber in parallel.
3. **Any subscriber** can run any command — `/addwallet`, `/pause`,
   `/status`, `/settings` (the inline-keyboard menu), `/wallet` to
   set/replace/remove the trading key.
4. `/stop` removes the sender from the subscriber list. `/start`
   again re-subscribes.
5. The `/subscribers` command shows the full list (admin view).

The bot is **DRY_RUN by default**, so even with multiple subscribers
the only "real" thing that can go wrong is them seeing the same
trade notifications — no funds are at risk until `DRY_RUN=false` and
a wallet has been set via `/wallet`. In LIVE mode, anyone who can issue
`/addwallet` can change the watchlist, and anyone can replace the
trading key with `/wallet` → Replace. The implicit trust boundary
is "anyone who knows the bot token". Keep it private.

### 3. Run in DRY_RUN mode (safe)

```bash
npm run start:dry
# or
DRY_RUN=true node index.js
```

You should see the bot come online, send a startup message to your
Telegram chat, and start polling. In DRY_RUN, no transactions are signed
or submitted.

### 4. Add a wallet to the watchlist

Two ways:

**A. Inline button (recommended)** — in your Telegram chat, send `/start`
to get the main menu, tap `💼 Wallets`, then tap `➕ Add Wallet`. The
bot force-replies with a prompt; send the address (and optional label):

```
7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU whale1
```

**B. Slash command** — same effect, fewer taps:

```
/addwallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

Replace the address with the dev wallet you want to copy. The bot will
log every token that wallet creates, and act the moment that wallet
sells one of its own tokens.

### 5. (Optional) Go live

When you are confident the bot behaves correctly:

```bash
# Generate a fresh wallet for the bot
npm run generate-wallet
# Paste the printed private key into .env as BOT_WALLET_PRIVATE_KEY

# Fund the wallet with a small amount of SOL
# (send SOL to the printed public key)

# Switch to LIVE mode
DRY_RUN=false node index.js
```

---

## Telegram commands

Type `/` in the chat — Telegram shows an autocomplete popup with all of
these (registered via `setMyCommands` on every bot launch).

| Command                    | Description                                          |
|----------------------------|------------------------------------------------------|
| `/start`                   | Subscribe + main inline-keyboard menu                |
| `/menu`                    | Re-show the main menu                                |
| `/settings`                | Open the TradeWiz-style settings sub-menu            |
| `/wallets`                 | Show tracked wallets + ➕ Add Wallet button          |
| `/addwallet <addr> [label]`| Add a wallet to track                                |
| `/removewallet <addr>`     | Remove a wallet                                      |
| `/wallet`                  | Set / replace / remove the bot's trading key (encrypted, message auto-deleted) |
| `/pause`                   | Pause trading (new signals logged, not traded)       |
| `/resume`                  | Resume trading                                       |
| `/status`                  | Safety + executor snapshot                           |
| `/positions`               | List currently open positions                        |
| `/recent [n]`              | Last N closed positions (default 10)                 |
| `/safety`                  | Show current safety config                           |
| `/stop`                    | Unsubscribe from broadcasts                          |
| `/subscribers`             | List every chat that has `/start`'d                  |
| `/help`                    | List all commands (same as the menu ❓ button)        |
| `/cancel`                  | Abort any pending text-prompt (settings or wallet)   |

`/listwallets` is a legacy alias for `/wallets`. Any subscriber can use
these commands. There is no owner-only auth.

---

## Settings menu

All 22 runtime settings live behind an inline-keyboard menu. No restart
needed — every change is persisted to SQLite (`settings` table) and
read on the next signal. Defaults live in `src/settings.js → CATALOG`
and can be overridden by env vars in `.env`.

**Layout** — three levels:

```
/start → Main menu
         ┌─────────────────────────────────┐
         │  [⏸  PAUSE / ▶️  START SNIPER ]  │
         │  [⚙️ Settings]   [📊 Status]    │
         │  [💼 Wallets (N)] [🛟 Safety]   │
         │  [💼 Positions]  [🔑 Wallet]   │
         │  [❓ Help]         [🔄 Refresh] │
         └─────────────────────────────────┘
              │
              ▼
[🔑 Wallet] → Trading-wallet sub-menu
              ┌──────────────────────────────────┐
              │  Status: ✅ Set / ⚠️ Not set     │
              │  Address: 5AbC…XyZ (last 4: XyZ) │
              │  Encrypted: AES-256-GCM          │
              │                                  │
              │  [➕ Set / 🔄 Replace Wallet]    │
              │  [🗑 Remove Wallet]              │
              │  [« Back to Main]                │
              └──────────────────────────────────┘
              │ tap ➕ Set →
              ▼
   Bot: "🔐 Send your private key in the next message…"
        (5-min TTL, only works in private chat)
              │ user pastes key →
              ▼
   Bot encrypts + saves to DB
   Bot deletes the user's key message via ctx.deleteMessage()
   Bot deletes its own "send your key" prompt
   Bot replies: "✅ Trading wallet saved! Last 4: XyZ"
              │ tap 🗑 Remove →
              ▼
   Bot: "⚠️ Remove Trading Wallet? [✅ Yes] [❌ Cancel]"
              │ confirm →
              ▼
   Bot: "🗑 Trading wallet removed."
         ┌─────────────────────────────────┐
         │  [💰 Trade]     [🔍 Filters]   │
         │  [🪙 Token]     [⏰ Time]      │
         │  [🔧 Advanced]                  │
         │  [« Back to Main]               │
         └─────────────────────────────────┘
              │
              ▼
[💼 Wallets (N)] → List of tracked wallets
         ┌─────────────────────────────────┐
         │  • 7xKXtg...G3pump  — whale1   │
         │  • 9aBcDe...K7sola              │
         │  ...                            │
         │  [➕ Add Wallet]                 │
         │  [« Back to Main]               │
         └─────────────────────────────────┘
              │
              ▼
[💰 Trade] → All trade settings, one row per setting
         ┌─────────────────────────────────────────────┐
         │  Fixed Buy (SOL): 0.01         🟡 env      │
         │  Buy Limit per Token: 1        ⚪ default   │
         │  Buy Slippage (bps): 500       🟡 env      │
         │  PUMP Slippage (bps): 1500     ⚪ default   │
         │  Buy Priority Fee (SOL): 0.0   ⚪ default   │
         │  Buy Tip 🚀 (SOL): 0.0         ⚪ default   │
         │  🟠 Auto Sell: 🟢 ON            ⚪ default   │
         │  🟠 Anti-MEV Buy: ⚫ OFF         ⚪ default   │
         │  Auto Retry (count): 0         ⚪ default   │
         │  « Back to Settings                         │
         └─────────────────────────────────────────────┘
```

**How to use:**

1. Send `/start` to Telegram — the main menu appears (or just type
   `/` to get the autocomplete list and pick a command directly).
2. Tap **⚙️ Settings** → tap a category (e.g. **💰 Trade**) to see
   every setting in that category with its current value and source
   (🟢 DB / 🟡 env / ⚪ default).
3. Tap any row to change it:
   - **Booleans** (e.g. `🟠 Auto Sell`) toggle instantly — the button
     label flips between `🟢 ON` and `⚫ OFF` after every tap.
   - **Numbers with presets** (e.g. `Buy Limit per Token`) — the bot
     asks "Send the new value" (force-reply). Reply with the number,
     or `none` / `unlimited` / `off` to clear a nullable limit.
     Out-of-range inputs bounce back with a hint.
   - **Free-form text** (e.g. `Tag`) — same force-reply flow.
4. After the new value is saved, the category screen redraws with
   the new value and a fresh `🟢 DB` source tag.
5. Tap **« Back to Settings** / **« Back to Main** to navigate up.

**`/cancel`** aborts any in-progress text prompt. The pending state
also times out after 5 minutes.

**The 22 settings, by category:**

| Category | Setting | Type | Default |
|----------|---------|------|---------|
| 💰 Trade | `fixed_buy_sol` | number | `MAX_SOL_PER_TRADE` env |
| 💰 Trade | `buy_limit_per_token` | number (1-3) | 1 |
| 💰 Trade | `slippage_bps` | number (50-5000) | `SLIPPAGE_BPS` env |
| 💰 Trade | `pump_slippage_bps` | number (100-5000) | 1500 |
| 💰 Trade | `buy_priority_fee_sol` | number (0-0.1) | 0.0 |
| 💰 Trade | `buy_tip_sol` | number (0-0.1) | 0.0 |
| 💰 Trade | `auto_sell` | bool | true |
| 💰 Trade | `anti_mev` | bool | false |
| 💰 Trade | `auto_retry` | number (0-5) | 0 |
| 🔍 Filters | `unrenounced_only` | bool | false |
| 🔍 Filters | `unburned_only` | bool | false |
| 🔍 Filters | `exclude_internal` | bool | false |
| 🔍 Filters | `exclude_external` | bool | false |
| 🔍 Filters | `min_mc_usd` | number (nullable) | null | Min market cap in USD. `null` = unlimited. |
| 🔍 Filters | `max_mc_usd` | number (nullable) | null | Max market cap in USD. `null` = unlimited. |
| 🔍 Filters | `min_token_age_min` | number (nullable) | null |
| 🔍 Filters | `max_token_age_min` | number (nullable) | null |
| 🪙 Token | `sol_spending_limit` | number (nullable) | null |
| ⏰ Time | `start_time` | HH:MM UTC | 00:00 |
| ⏰ Time | `end_time` | HH:MM UTC | 23:59 |
| 🔧 Advanced | `tag` | text (32 chars) | "" |
| 🔧 Advanced | `hold_ms` | number (100-60000) | `HOLD_MS` env |

**Defaults are DRY_RUN-safe:** every filter is off, every cap is
disabled, the time window covers all 24h. You can flip them on
one-by-one via the menu and watch `/status` update without ever
leaving Telegram.

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example)
for the full list with comments. Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DRY_RUN` | `true` | When `true`, no transactions are signed/submitted. **Default is safe mode.** |
| `MAX_SOL_PER_TRADE` | `0.01` | Hard cap on SOL spent per buy, in SOL units. |
| `SLIPPAGE_BPS` | `500` | Slippage tolerance in basis points (500 = 5%). |
| `HOLD_MS` | `1000` | How long to hold the token after buying, in milliseconds. |
| `DAILY_LOSS_CAP_SOL` | `0.05` | Bot auto-pauses when realized daily losses exceed this. |
| `JUPITER_API_URL` | `https://quote-api.jup.ag/v6` | Swap endpoint. Switch to `https://api.jup.ag/swap/v1` for the newer API, or `https://metis.jup.io` for MEV-protected routing. |
| `PRIORITY_FEE_MICROLAMPORTS` | `0` | Priority fee per compute unit. Bump if you want faster landing. |
| `POLL_INTERVAL_MS` | `5000` | How often to poll Helius for new transactions per wallet. |

---

## Project layout

```
SnipeTrenchBot/
├── index.js                # Entry point — wires everything together
├── package.json
├── .env.example            # Copy to .env and edit
├── LICENSE                 # MIT + trading disclaimer
├── README.md               # This file
├── ARCHITECTURE.md         # Detailed design + data flow
├── RISK.md                 # Risk discussion
├── CHANGELOG.md
├── src/
│   ├── config.js           # Env loader + validation (B64: secret prefix)
│   ├── db.js               # SQLite layer (better-sqlite3, 7 tables)
│   ├── safety.js           # DRY_RUN / cap / daily loss / spending / pause
│   ├── heliusMonitor.js    # Wallet poller + event classifier
│   ├── jupiterMetis.js     # Jupiter quote + swap builder (anti-MEV aware)
│   ├── executor.js         # Buy → hold → sell flow (reads settings)
│   ├── notifier.js         # Telegram + console output (multi-user broadcast)
│   ├── telegramBot.js      # Telegraf command handlers + inline-keyboard menu
│   ├── settings.js         # DB-backed runtime settings (22 keys, env fallback)
│   ├── settingsMenu.js     # TradeWiz-style 5-sub-menu UI
│   └── filters.js          # Opt-in on-chain filters (unrenounced, unburned, MC, age)
├── scripts/
│   └── generate-wallet.js  # Print a fresh Solana keypair
├── data/                   # SQLite DB lives here (gitignored)
└── logs/                   # Reserved for future structured logging
```

---

## Development

```bash
# Syntax-check all source files
npm run check

# Run with auto-restart on file changes (install nodemon first)
npx nodemon index.js
```

There is no test suite in v0.3.0. The bot's logic is simple enough that
DRY_RUN mode serves as the integration test — run it for a day, watch the
logs, and confirm the trades it WOULD have made match your expectations
before flipping `DRY_RUN=false`.

---

## Limitations & known issues

- **No reconnection logic** for Telegram — if the bot loses its long-poll
  connection it will exit. Run it under a process manager (pm2, systemd)
  in production.
- **Multi-user = open trust** — any Telegram user who `/start`s the bot
  becomes a subscriber and can run any command (including `/addwallet`
  and `/pause`). Keep the bot token private. For single-operator use
  this is no worse than the old single-owner mode; for shared bots,
  consider adding a chat-id allowlist before going LIVE.
- **No token-decimals handling** — the bot assumes the token has 6
  decimals when displaying. The actual swap uses raw units from the
  Jupiter quote, which is correct, but the "tokens bought" number shown
  in Telegram may be off by `10^6` for tokens with different decimals.
- **Helius polling is sequential** — wallets are polled in order each
  tick. If you watch 100 wallets with `POLL_INTERVAL_MS=5000`, the last
  one may be polled close to 500s after the first.
- **On-chain filters are best-effort** — `unrenounced_only` reads the mint
  account, `unburned_only` checks top-holder dominance (heuristic for
  migrated LPs), and `min/max_mc_usd` derives MC in USD from a Jupiter
  quote (1 token → SOL) × supply, then converts via a 60s-cached SOL→USDC
  Jupiter quote. All are cached per-mint for 30s to avoid RPC spam. If a
  check throws, the filter passes (fail-open) — disable it in `/settings`
  if you suspect the heuristic is wrong.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design discussion
and [RISK.md](RISK.md) for the risk model.

---

## License

MIT — see [LICENSE](LICENSE). **The MIT license does not cover financial
losses.** The trading disclaimer in LICENSE is part of the license terms.
