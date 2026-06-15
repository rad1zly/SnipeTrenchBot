# Changelog

All notable changes to SnipeTrenchBot are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project adheres to [Semantic Versioning](https://semver.org/).

## [0.7.1] - 2026-06-15

### Changed — market cap bounds are now in USD (TradeWiz parity)

User-facing setting labels and the runtime check switched from SOL to
USD to match the TradeWiz reference UI ("Min MC (USD)" / "Max MC (USD)").
Buy sizes, fees, and spending limits are still denominated in SOL.

- **Keys renamed** (`src/settings.js` CATALOG): `min_mc_sol` →
  `min_mc_usd`, `max_mc_sol` → `max_mc_usd`.
- **UI label** (`src/settingsMenu.js`, `src/settings.js`): "Min MC (SOL)"
  / "Max MC (SOL)" → "Min MC (USD)" / "Max MC (USD)".
- **DB migration** (`src/db.js` init): one-time idempotent rename — any
  existing `min/max_mc_sol` rows in `settings` are renamed in place to
  the new keys. No data loss; no user action required.
- **Runtime check** (`src/filters.js` `checkMarketCap`): computes MC in
  SOL as before, then multiplies by a 60s-cached SOL→USDC Jupiter quote
  before comparing to the user's USD bounds.
- **New helper** (`src/filters.js` `getSolPriceUsd()`): global 60s cache
  for SOL price. Cached separately from per-mint filter cache since SOL
  price is one number, not per-token. If the Jupiter SOL→USDC quote
  fails, the MC filter passes (fail-open) — same pattern as every
  other filter.
- **New config** (`src/config.js`): `USDC_MINT` constant
  (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) for the SOL→USDC
  quote.
- **Tests** (`scripts/smoke-test.js`): key references updated.
- **Docs** (`README.md`): settings table + on-chain filter paragraph.

## [0.7.0] - 2026-06-15

### Changed — watchlist is now per-user (privacy)

Multi-user no longer shares a single global watchlist. Every row in
`watched_wallets` is now owned by a `chat_id`, and queries for
list/display/count are scoped to the caller's chat.

- **Schema migration** (`src/db.js` init): on first boot, the old
  global `watched_wallets` table is detected via `PRAGMA table_info`,
  snapshotted to `watched_wallets_legacy_global`, and dropped. The
  new table has `id INTEGER PK AUTOINCREMENT`, `chat_id INTEGER NOT
  NULL`, `UNIQUE(chat_id, address)`, plus indexes on both columns.
- **walletsDb API**: `add`, `remove`, `list`, `count`, `totalCopies`
  now take `chatId`. Added `listAll()` (DISTINCT addresses) for the
  Helius monitor and `get(address)` to look up the owner.
- **Helius monitor** (`src/heliusMonitor.js`): polls `listAll()` so
  the blockchain is polled once per unique address, not once per
  (user × address). Events are tagged with the owning `chatId` so
  downstream handlers know who to notify.
- **Notifier** (`src/notifier.js`): added `notifyOne(chatId, text)`
  for private delivery. Trade events (`tokenCreated`, `sellDetected`,
  `tradeStep`, `tradeClosed`, `tradeDenied`) now route to the
  wallet owner only, not broadcast. System events (`info`, `error`)
  still broadcast.
- **Telegram UI** (`src/telegramBot.js`): main menu, status,
  wallets list, and copy count are all per-user. The
  `/subscribers` admin command was removed — exposing other users'
  chat IDs is no longer acceptable in a privacy-respecting design.
  `/help` updated to mention private watchlists.
- **Index startup** (`index.js`): `🟢 Bot started` no longer shows
  a global wallet count (misleading in per-user mode); instead
  shows `Subscribers: N`.

### Migration notes for existing users

- The old single-table watchlist was snapshot to
  `watched_wallets_legacy_global` and dropped. **Wallets were not
  auto-assigned** to any user — owners will need to re-add their
  addresses via `/addwallet` in Telegram. The legacy snapshot is
  kept for forensic recovery.
- The `subscribers` table is unchanged; only the watchlist schema
  changed.

## [0.6.0] - 2026-06-15

### Added — per-wallet copy-trade stats

Tracked two new columns on `watched_wallets` so users can see how often
the bot has copied a given dev:

- `copy_count INTEGER NOT NULL DEFAULT 0` — number of times the bot has
  executed a copy-trade for this wallet.
- `last_copy_at INTEGER NOT NULL DEFAULT 0` — ms epoch of the most
  recent copy.

Stats surface in:
- `/wallets` (per-wallet line) and main menu status bar (`Copies: N`).
- The startup `🟢 Bot started` notification (`Total copies so far: N`).
- The `[monitor]` log line on each fresh poll.
- The `🔔 DEV SELL DETECTED` notification — prepended with
  `📊 Copy #N for this wallet` so hot wallets are obvious.

Update path: `walletsDb.markCopied(address)` is called inside
`executor.js` immediately after a successful BUY, after the position
is opened and the BUY signal is logged. The update is atomic
(`UPDATE ... SET copy_count = copy_count + 1, last_copy_at = ?`) so two
concurrent trades for the same wallet cannot race. A stats-DB hiccup
never blocks the trade — the buy is already committed at that point.

### Migration

Run `node scripts/migrate-001-copy-stats.js` once on existing databases.
The script is idempotent (skips columns that already exist) and
forward-only. The new columns have `DEFAULT 0` so existing rows
automatically get `copy_count=0, last_copy_at=0` after the ALTER.

### Files changed

- `src/db.js` — added two columns to `CREATE TABLE watched_wallets`;
  added `markCopied`, `incrementCopyCount`, `setLastCopyAt`, `getStats`,
  `totalCopies` helpers.
- `src/executor.js` — calls `walletsDb.markCopied(dev)` after BUY_OK;
  logs `WALLET_STATS_BUMPED` with the new count.
- `src/heliusMonitor.js` — `poll` event payload now includes
  `copyCount` so the index.js log line can show it.
- `src/notifier.js` — `sellDetected()` prepends
  `📊 Copy #N for this wallet` (and `last: …` timestamp when present).
- `src/telegramBot.js` — `buildWalletsText()` shows `copies: N · last: …`
  per row + aggregate `Total copies: N` header; `buildMainText()` adds
  a `Copies: N` column to the status bar.
- `index.js` — startup notification includes `Total copies so far: N`;
  poll log line shows `(copies so far: N)`.
- `scripts/migrate-001-copy-stats.js` — **new**. Idempotent column-add
  migration. Run once after pulling this version.
- `README.md` — new "Copy-trade stats (v0.6.0+)" section.

## [0.5.3] - 2026-06-15

### Fixed — `auto_sell` setting missing from CATALOG

- The README, CHANGELOG (v0.1.1), and `safety.snapshot()` all reference an
  `auto_sell` setting, but it was absent from `src/settings.js → CATALOG`.
  `settings.get('auto_sell')` therefore returned `null`, leaving the
  snapshot's `autoSell` field perpetually `null` and the docs' promise
  of "22 settings" unmet.
- **Fix**: added `auto_sell` to the CATALOG as `type: 'bool', category:
  'trade', label: 'Auto Sell', default: true`. The bool toggle renders
  on the flat Copy Trade screen alongside the other Trade settings.
- The executor's buy → hold → sell flow is unchanged (it always sells
  after `HOLD_MS`). `auto_sell` is currently a UI-visible + snapshot-
  reportable toggle; the v0.1.1 "leave position OPEN" semantics is
  still deferred. Default `true` matches the current behavior.

### Files changed
- `src/settings.js` — added one entry to the CATALOG (`auto_sell`).
  No other code path required changes; the safety module's
  `snapshot()` already called `settings.get('auto_sell')`.

## [0.5.2] - 2026-06-15

### TradeWiz visual parity — flat single-screen settings + bulk wallet add

- **🎯 Copy Trade button replaces ⚙️ Settings on the main menu.** Opens a
  TradeWiz-style flat single-screen settings view (all 22 settings on one
  scrollable Telegram message) instead of the 5-sub-menu drill-down.
  Trade / Filters / Token / Time / Advanced are now section dividers in
  one screen, not separate sub-menus.
- **2-column paired layout.** Related settings (Max MC / Min MC, Max Token
  Age / Min Token Age, Buy Slippage / PUMP Slippage, Buy Priority Fee /
  Buy Tip, Unrenounced / Unburned, Exclude Internal / Exclude External,
  Start Time / End Time) are rendered side-by-side on the keyboard.
  Bool toggles are single-column with a 🟢/🟠 icon prefix.
- **Footer `« Main` / `↻ Refresh` / `+ Save`** on the flat settings screen,
  matching TradeWiz layout.
- **Unrestricted ranges.** Min/Max MC, Min/Max Token Age, SOL Spending
  Limit, Buy Priority Fee, Buy Tip no longer cap at 1000 / 1440 / 100.
  Users can type any positive number — `0.001` to `1,000,000,000` works.
  Set to `0` / `none` / `unlimited` / `off` to disable.
- **Bulk add wallet.** `/addwallet` and the inline ➕ Add Wallet flow now
  accept multiple addresses at once, separated by commas OR newlines.
  Each address may be followed by a label. One summary message reports
  `Added N / Already in watchlist M / Skipped K (invalid)`.
- **`/copytrade` command** added as the canonical name for the settings
  screen. `/settings` kept as a backwards-compat alias.
- **`menu:trade` / `menu:filters` / `menu:token` / `menu:time` /
  `menu:advanced` callbacks** still route correctly (fall back to the
  flat menu) so old messages don't dead-end.

### Files changed
- `src/settingsMenu.js` — full rewrite. Now exports `renderFlat`,
  `buildFlatText`, `buildFlatKeyboard`, `handleSetCallback`,
  `handlePendingText`. Single-screen view, 2-column paired layout, footer.
- `src/settings.js` — removed `max:` bounds on `min_mc_sol`, `max_mc_sol`,
  `min_token_age_min`, `max_token_age_min`, `sol_spending_limit`.
- `src/telegramBot.js` — main menu: `⚙️ Settings` → `🎯 Copy Trade`.
  Added `/copytrade` command. Added `bulkAddWalletsFromText` and
  `bulkAddResultMessage` helpers. Updated `/addwallet` and inline
  add-wallet flow to use bulk parsing. Removed old `categoryMenu` /
  per-category callbacks.

## [0.5.1] - 2026-06-15

### Changed — TradeWiz visual parity

- **Toggle button color** — the per-bool `set:toggle:KEY` button now
  uses the TradeWiz color convention: `🟢 <Label>` when the value is
  ON, `🟠 <Label>` when OFF. Previously the OFF state used a black
  circle (`⚫`) which read as "broken" rather than "off"; the orange
  dot matches the visual language of TradeWiz Bot_Merlin.
- **Value indicator** in the sub-menu text — the `formatValue` for
  bools now returns `✅ Yes` (ON) / `🟠 No` (OFF) instead of
  `✅ Yes` / `❌ No`. Same reason: orange = off, green = on.
- **Footer row on category screens** — every Trade / Filters / Token
  / Time / Advanced screen now has a 3-button footer matching
  TradeWiz's button layout:
  ```
  [← Back]  [↻ Refresh]  [+ Save]
  ```
  The `+ Save` button is a no-op (settings are auto-persisted on tap
  or input) but the affordance is there so the user gets the same
  "Save and close" closure they expect from TradeWiz.
- **Cleaned up label prefixes** — the catalog previously had `🟠
  Auto Sell` and `🟠 Anti-MEV Buy` labels (the orange circle was in
  the label name itself). The orange is now in the value column
  (`🟠 No`) only, and the label reads `Auto Sell` / `Anti-MEV Buy`
  for cleaner rendering.

## [0.5.0] - 2026-06-15

### Added — Encrypted trading-wallet via Telegram UI (no .env)

- **`/wallet` command and 🔑 Wallet inline button** — the bot's own
  trading private key is no longer read from `.env`. The user now sets
  it directly in the bot via an inline-keyboard sub-menu, encrypted at
  rest in SQLite. Accessible from:
  - The main menu (4th row, right column: `🔑 Wallet`)
  - The `/wallet` command (sends a fresh message with the same menu)
  - Help text and the autocomplete command list
- **AES-256-GCM encryption at rest** — new `src/walletManager.js`
  module. The plaintext key is encrypted in memory, persisted as
  `(ciphertext, iv, tag)` blobs in a new `wallet` SQLite table (single
  row, `id = 1`). The encryption key is derived from
  `scryptSync(WALLET_PEPPER || 'default', machine-id, 32)` with
  N=16384, r=8, p=1. No plaintext is ever written to disk, logs, or
  Telegram messages.
- **Telegram message auto-delete** — when the user sends the private
  key, the bot:
  1. Validates format (Base58 32-100 chars, or JSON array of 32-64 bytes)
  2. Calls `ctx.deleteMessage()` on the user's key message
     (Telegram allows this for bot-received messages in private chat)
  3. Calls `telegram.deleteMessage()` on the bot's own "send your
     key" prompt message
  4. Replies with a confirmation that shows only the public address
     and last 4 chars — never the key
  The full key lifetime in the bot's process is the encrypt() call
  (sub-millisecond).
- **Pending-set state map** in `walletMenu.js` — `chatId → {startedAt,
  promptMsgId}` with a 5-minute TTL. Mirrors the existing
  `pendingAddWallet` and `pendingEdit` flows. The `bot.on('text')`
  handler dispatches to `wm.handlePendingWalletText(ctx)` after
  `sm.handlePendingText(ctx)` and the add-wallet handler. `/cancel`
  aborts.
- **Private-chat-only guard** — the set flow refuses to run in
  group/channel chats. The user gets a clear "⚠️ Wallet can only be
  set in a private chat (DM)" message instead of eating the key.
- **Replace and Remove flows** — `cmd:set_wallet` handles both
  first-set and replace; `cmd:remove_wallet` shows a confirm dialog
  (`✅ Yes, remove` / `❌ Cancel`) before deleting the row. The DB
  upserts on conflict so replace works without a manual delete.
- **Defensive logging** — `walletManager.scrub(text)` exported as a
  utility that redacts any 40-88 char base58 string or 30+ element
  JSON array from log output. Available for future log surfaces;
  current code paths only log `last4` / public address so scrubbing
  is defense in depth.
- **`/start` menu shows wallet status** — the main menu's first text
  block now includes a `Wallet: <code>5AbC…XyZ</code> (...XyZ)` line.
  When no wallet is set in LIVE mode, a yellow `⚠️ No trading wallet
  — tap 🔑 Wallet to set one` warning is appended.
- **`/status` command** — now reads from `walletManager.getStatus()`
  and shows `NOT SET — /start → 🔑 Wallet` in red when applicable,
  otherwise `5AbC…XyZ (last 4: XyZ)`.
- **Startup log** — `index.js` logs `Trading wallet: …XyZ
  (encrypted at rest)` when set, or `⚠️ NOT SET — set via /start →
  🔑 Wallet` when not. The same line is included in the startup
  Telegram notification.
- **`WALLET_PEPPER` (optional) in `.env`** — combined with machine-id
  to derive the encryption key. Leave empty for machine-bound
  encryption (the DB is useless on another host). Set for portable
  encryption (move the DB to a new VPS, decrypt with the same
  pepper). See `.env.example` for the full discussion.

### Changed

- **`BOT_WALLET_PRIVATE_KEY` removed from `.env` and config** — the
  config field is gone entirely. If a user still has the line in
  their `.env`, it is silently ignored (no warning, to keep the
  startup output clean). `.env.example` and `.env` have been
  rewritten to point at the new `/wallet` flow.
- **`executor.js` `initExecutor`** — in LIVE mode, loads the
  encrypted wallet via `walletManager.getKeypair()`. If the wallet
  is not set, it logs a warning and sets `botKeypair = null`. The
  executor does NOT crash at boot — instead, `submitSwap` throws a
  readable error at first trade pointing the user at `/start →
  🔑 Wallet`. The user can set the wallet without restarting the
  bot (decryption happens lazily on demand).
- **`/help` text and command list** — added `/wallet` line and a
  `Security:` bullet mentioning AES-256-GCM encryption and
  auto-deletion of the key message.
- **Main menu layout** — `🔑 Wallet` button moved to row 4 (was
  `❓ Help`); `❓ Help` moved to its own row with `🔄 Refresh`.
  Rationale: the wallet is a security-sensitive action, deserving
  a prominent position.
- **`buildMainText` / `executor.status()`** — both now derive wallet
  info from `walletManager.getStatus()` instead of the in-memory
  `botKeypair`. They never log the key, only the public address +
  last 4.

### Security

- **No plaintext key on disk** — at-rest encryption only. The
  `wallet` table row contains `(ciphertext BLOB, iv BLOB, tag BLOB,
  last4 TEXT, address TEXT, created_at, updated_at, set_by_chat_id,
  set_by_username)`. Without the machine-id (and WALLET_PEPPER if
  set) the ciphertext is unrecoverable.
- **No plaintext key in logs** — `initExecutor` logs only the last 4
  chars. The decrypted plaintext exists in `walletManager.decrypt()`
  local scope and is consumed by `Keypair.fromSecretKey()` within
  microseconds; it never enters a `console.log` or string
  interpolation path.
- **No plaintext key in Telegram** — confirmation messages show
  only the public address + last 4. The user's key message is
  deleted; the bot's prompt is deleted.
- **Replace is upsert, not append** — only one wallet row exists
  (`id = 1` PK constraint). Old ciphertext is overwritten on replace.
- **Remove is a hard DELETE** — the row is gone after `cmd:do_remove_wallet`.
  The bot can no longer sign transactions until a new wallet is
  set. `submitSwap` fails with a clear error.
- **Group-chat refusal** — wallet cannot be set in group/channel
  chats. Reduces accidental paste-into-wrong-chat risk.
- **Multi-user trust boundary documented** — `README.md` now
  explicitly states that in LIVE mode, any subscriber can replace
  the trading key via `/wallet` → Replace. The implicit trust
  boundary is "anyone who knows the bot token".

### Notes for upgraders

- **Existing users with `BOT_WALLET_PRIVATE_KEY` in `.env`**: that
  line is now ignored. On first run after the upgrade, the bot
  will warn `LIVE mode — no wallet set` at startup. Tap `/start`
  → 🔑 Wallet → ➕ Set Wallet in Telegram to migrate the key
  into the encrypted DB. Then delete the `BOT_WALLET_PRIVATE_KEY`
  line from your `.env` (no longer read).
- **DB migration**: not required. The `wallet` table is created
  on first DB open via `CREATE TABLE IF NOT EXISTS`. Existing
  `watched_wallets`, `positions`, `signals`, `safety_log`,
  `subscribers`, and `settings` rows are untouched.
- **The encrypted wallet is bound to the host** unless you set
  `WALLET_PEPPER` in `.env`. If you back up only the DB file
  (without the host's machine-id) you cannot decrypt — this is
  intentional. Set `WALLET_PEPPER` if you want portable backups.
- **`/cancel` works in all three pending-text flows**: settings
  edit, add-wallet, and set-wallet.

## [0.4.0] - 2026-06-15

### Added — Telegram command autocomplete, Wallets UI, and Add-Wallet flow

- **Telegram command autocomplete (`setMyCommands`)** — at launch, the bot
  calls `bot.telegram.setMyCommands(BOT_COMMANDS)` with 15 commands + short
  descriptions. Result: when a user types `/` in the chat, Telegram's
  autocomplete popup shows the full list. Users no longer need to memorize
  or read the help text to discover commands. The list is registered
  globally (default scope) so it works for every subscriber without per-chat
  setup.
- **`/settings` command** — direct text-access to the Settings sub-menu
  (was previously only reachable via the inline-keyboard `⚙️ Settings`
  button on the main menu). Same payload: top-level menu with 5
  categories (Trade / Filters / Token / Time / Advanced).
- **`/wallets` command** — direct text-access to the Wallets screen
  with the `➕ Add Wallet` inline button. Same UX as tapping the main-menu
  `💼 Wallets` button.
- **➕ Add Wallet inline button** — on the Wallets screen, tap `➕ Add
  Wallet` to enter a pending-add state (5-minute TTL). The bot replies
  with a force-reply prompt asking for the Solana address (and optional
  label). The next text message from the same chat is parsed as
  `<address> [label]`, validated with `isValidSolanaAddress`, and
  committed to `walletsDb`. On success the Wallets screen re-renders
  with the new entry visible. Same validation as the legacy
  `/addwallet <addr> [label]` command.
- **`pendingAddWallet` state map** in `telegramBot.js` — `chatId →
  { startedAt }` keyed by chat, parallel to the `pendingEdit` map in
  `settingsMenu.js`. The `bot.on('text')` handler checks this map
  BEFORE the pending-settings-edit check, so the two flows are
  independent. `/cancel` aborts both.

### Changed

- **Main menu re-layout** — removed the duplicate `👁 Watchlist` and
  `💰 Wallets` buttons (they pointed at the same screen and confused
  users). Replaced with a single `💼 Wallets (N)` button whose label
  shows the live count, and `🛟 Safety` moved into its slot. Help button
  now sits alongside Positions. Refresh sits alone on the bottom row.
- **Terminology: "Watchlist" → "Wallets"** — applied consistently
  across `buildMainText`, `buildHelpText`, `/help` text, `/listwallets`
  output, and inline button labels. Internally the `watched_wallets`
  SQLite table and `walletsDb` exports are unchanged (no migration
  needed). The user-facing wording now matches the mental model: "this
  is the list of wallets I added; I tap the menu to see them or add
  more."
- **`/listwallets` is now a legacy alias** — the command still works
  for backward compatibility, but delegates to the same `buildWalletsText`
  + `walletsMenu()` UI as `/wallets` and the inline button. No more
  plain-text dump — users get the menu with the `➕ Add Wallet` button.
- **`buildHelpText` (menu version) and `/help` command output** — both
  now reference `/wallets` and `/settings`, mention the 5 sub-menu
  categories, and include a tip: "type / in chat to see the autocomplete
  command list." (Drives discovery of the new `setMyCommands` list.)
- **Bot startup log** — `launchWith409Retry` now logs
  `setMyCommands: registered N commands` on success (or a non-fatal
  warning on failure). On 409 it still logs the retry-attempt line and
  waits progressively longer (15s → 150s, 10 attempts, ~13 min total).

### Fixed

- **Confusing dual "Watchlist" / "Wallets" buttons** — were both wired
  to the same callback handler, so tapping either produced identical
  output. The duplicate button has been removed; the remaining
  `💼 Wallets (N)` shows the count inline.
- **No discoverable command list** — Telegram's `/` autocomplete was
  empty before this release, so users could only discover commands
  via `/help` text or the inline menu. `setMyCommands` now populates
  the popup globally.

### Notes

- The DB schema did not change. `watched_wallets` is still the canonical
  table name (the rename is purely UI wording). If you have scripts
  that read `walletsDb` directly, they keep working.
- `pendingAddWallet` state is in-memory only — restarting the bot
  clears it. Acceptable because the add-wallet flow is short (under 5
  min) and the command form `/addwallet <addr>` remains available as
  a stateless alternative.
- The `setMyCommands` call is best-effort: a network blip won't block
  bot launch, it just logs a warning. The command list is also
  re-registered on every launch, so refreshing the list is automatic
  — no separate `setcommands` admin command needed.

## [0.3.0] - 2026-06-15

### Added — TradeWiz-style multi-user settings menu

- **Multi-user broadcast mode** — any Telegram user who sends `/start`
  is auto-added to a `subscribers` SQLite table. All notifications
  broadcast to every subscriber. No `TELEGRAM_CHAT_ID` required, no
  owner-only auth. Use `/stop` to unsubscribe.
- **`subscribers` table** in SQLite (`chat_id`, `username`, `first_name`,
  `first_seen`, `last_seen`). On `/start`, `username` and `first_name`
  are captured for the admin view (`/subscribers`).
- **Inline-keyboard main menu** on `/start` — 7 buttons:
  Settings / Status / Watchlist / Positions / Safety / Help / Pause
  (or Resume when paused). All navigation edits the same message in
  place — no chat spam.
- **5 sub-menus** under Settings, accessed via inline buttons:
  - **💰 Trade** — `fixed_buy_sol`, `buy_limit_per_token`, `slippage_bps`,
    `pump_slippage_bps`, `buy_priority_fee_sol`, `buy_tip_sol`, `auto_sell`,
    `anti_mev`, `auto_retry` (9 settings).
  - **🔍 Filters** — `unrenounced_only`, `unburned_only`, `exclude_internal`,
    `exclude_external`, `min_mc_sol`, `max_mc_sol`, `min_token_age_min`,
    `max_token_age_min` (8 settings).
  - **🪙 Token** — `sol_spending_limit` (1 setting).
  - **⏰ Time** — `start_time`, `end_time` (UTC HH:MM, 2 settings).
  - **🔧 Advanced** — `tag`, `hold_ms` (2 settings).
- **Total: 22 runtime-mutable settings**, all persisted in SQLite
  (`settings` table, JSON-encoded), with env-var and built-in defaults
  fallback. Changes take effect immediately — no restart.
- **Three setting types** with distinct UX:
  - **Bool** — one-tap toggle; button label flips between `🟢 ON` /
    `⚫ OFF` after every tap.
  - **Number** — tap to open a "Send new value" prompt (force-reply).
    Out-of-range inputs bounce back with a hint. Nullable limits
    accept `none` / `unlimited` / `off` to clear.
  - **Text / Time** — same force-reply flow with type-specific
    validation (e.g. `HH:MM` regex for time-window).
- **Source indicator** next to every value in the sub-menus:
  `🟢 DB` = value overridden in settings table, `🟡 env` = value
  from `.env`, `⚪ default` = factory default. Lets the user see at
  a glance which layer is currently in effect.

### Changed

- **`telegramBot.js` callback router** — now handles `menu:*` (navigate),
  `cmd:*` (run command) AND `set:*` (toggle/edit a setting). Sub-menus
  are rendered by `src/settingsMenu.js` instead of inlined text.
- **`bot.on('text')` handler** — first checks for a pending settings
  edit via `sm.handlePendingText(ctx)` and consumes the message before
  falling through to the "Unknown command" reply. Means a user can
  tap `Buy Limit per Token`, type `2`, and the menu redraws with
  the new value without a single intermediate "Unknown command" line.
- **`/stop` command** — unsubscribes the sender (was already present
  in v0.1.1; documented here for the multi-user refactor).
- **`/subscribers` command** — admin view of every chat that has
  `/start`'d, with last-seen timestamps. New in this version.
- **`/status` output** — now reports `Subscribers: N` alongside the
  existing executor and safety fields.

### Fixed

- **Duplicate `CREATE TABLE` statements** in `db.js` for `bot_meta`
  and `settings` (legacy from the v0.2.0 single-owner attempt). Cleaned
  to one canonical definition per table; `IF NOT EXISTS` made the
  old SQL a no-op, so no migration step is required.
- **`settings.spentSolToday()`** — was referenced by `safety.js` Rule 3
  (daily-spend cap) but not yet exported. Added; uses
  `positionsDb.spentSince(startOfUtcToday)` which was already present.

### Notes

- This version **supersedes the v0.2.0 single-owner design** that
  was described in the previous CHANGELOG. The single-owner pattern
  (one `chat_id` via `bot_meta.owner_chat_id`) was deemed too
  restrictive for the user's use case (monitoring from phone + desktop).
  Multi-user broadcast with optional per-user `/stop` is strictly
  more flexible with no security regression (DRY_RUN=true is the
  default, LIVE mode still requires `BOT_WALLET_PRIVATE_KEY` in
  `.env`).
- The schema in `db.js` is forward-compatible: the old `bot_meta` and
  `settings` tables are present (in case anyone upgraded from v0.2.0
  with stale data), but the runtime only uses `subscribers` (for auth)
  and `settings` (for runtime-mutable config).

## [0.2.0] - 2026-06-14

### Added

- **Owner auto-capture on first `/start`** — the bot no longer
  requires `TELEGRAM_CHAT_ID` in `.env`. Whichever user sends `/start`
  first becomes the owner; their `chat_id` is persisted in the new
  `bot_meta` SQLite table. Subsequent users get "⛔ Unauthorized".
  The owner can re-bind with `/resetowner` (useful when switching
  devices).
- **New `bot_meta` table** in SQLite (key-value: `owner_chat_id`,
  timestamp on each write).
- **`/resetowner` command** — clears the persisted owner so the next
  `/start` from any user claims ownership.

### Changed

- `config.js` — `TELEGRAM_CHAT_ID` empty in `.env` is now a **warning**,
  not an error. The bot starts in a "not-yet-activated" state and
  waits for the first `/start` to set the owner.
- `telegramBot.js` — `authMiddleware` reads from `bot_meta` with
  `.env` as fallback. `/start` handler renders the settings main
  menu (via `settingsMenu.renderMainMenu()`) and shows a one-time
  "you are now the owner" banner on first activation.
- `notifier.js` — no change to its public API, but the runtime
  `process.env.TELEGRAM_CHAT_ID` is now hot-updated by `setOwner()`
  so the first post-`/start` notifications reach the right chat.

### Backward compatibility

- Users who already had `TELEGRAM_CHAT_ID` in `.env` keep working:
  the env value is used as the owner until someone explicitly
  `/start`s the bot (which then overwrites the DB entry).
- Existing `bot_meta` rows are untouched (new key only).

## [0.1.1] - 2026-06-14

### Added

- **`/settings` inline-keyboard menu** — 19 TradeWiz-style settings
  organized in 5 submenus (Trade / Filters / Token / Advanced / Time
  Window). All settings persist in SQLite, mutable at runtime, no
  restart required.
- **New `src/settings.js` module** — DB-backed key/value store with
  type coercion, per-key bounds validation, and a `spentSolToday()`
  helper for the daily spending cap.
- **New `src/settingsMenu.js` module** — Telegraf inline-keyboard
  builder. Submenu rendering, toggle buttons, prompt-state machine
  for "Set…" flows, and a `↺ Reset` button per customized key.
- **New `src/filters.js` module** — opt-in on-chain token filters
  with 30s per-mint caching (so Helius isn't spammed):
  - `unrenounced_only` — read mint account, skip if mint authority is null
  - `unburned_only` — top-holder dominance heuristic to detect LP-burned (migrated) tokens
  - `min_mc_sol` / `max_mc_sol` — derive MC from Jupiter quote + mint supply
  - `min_token_age_min` / `max_token_age_min` — compare `TOKEN_CREATED` timestamp
  - `exclude_internal` / `exclude_external` — pump.fun vs Raydium/etc. (best-effort, needs `event.programIds`)
- **New `settings` table** in SQLite (`db.js`): `(key TEXT PRIMARY KEY,
  value TEXT, updated_at INTEGER)`. Migration runs on next `node index.js`.
- **Anti-MEV toggle** — when on, the effective `JUPITER_API_URL`
  switches to `https://metis.jup.io` on the fly, then restores when
  toggled off.
- **Auto-retry wrapper** — `submitSwapWithRetry({ maxAttempts })`
  with exponential backoff (500ms, 1.5s, 3s, ...). Set via
  `auto_retry` in `/settings` → Advanced.
- **Time window gate** — `start_time` / `end_time` (UTC) in
  `/settings` → Time Window. Out-of-hours signals are logged as
  `OUT_OF_HOURS` and skipped. Wraps midnight.
- **Spending cap** — `sol_spending_limit` (SOL/day) in
  `/settings` → Trade. Rejects new buys once the day's total
  entry-SOL hits the cap.
- **Buy limit per token** — `buy_limit_per_token` (1, 2, or 3) in
  `/settings` → Trade. Counts open + closed positions per mint.
- **Auto-sell toggle** — `auto_sell` in `/settings` → Trade. When
  off, position stays OPEN after the hold window; manual close is
  deferred to v0.2.0.
- **New `/safety` output fields**: spending cap, spent today,
  buy limit/token, auto-sell, auto-retry, anti-MEV, time window.
- **`/status` output** now includes `effectiveJupiterUrl` and the
  full `activeFilters` object.

### Changed

- `executor.js` — `executeSignal()` now reads trade params from
  settings instead of env vars directly. Time window + filter
  gates run before the safety guard.
- `jupiterMetis.js` — `base()` resolves through `effectiveJupiterUrl()`
  instead of `config.JUPITER_API_URL`.
- `telegramBot.js` — added `/settings` command, `callback_query`
  router for `s:*` data, and prompt-state consumption in the
  `text` handler.
- `README.md` — added a full Settings menu section with category
  tree, defaults, and step-by-step usage.

### Fixed

- **Pre-existing bug in `db.js`**: `CREATE INDEX ... ON safety(type)`
  referenced the wrong table name (should be `safety_log`). Fixed.
- **No retry on transient RPC errors** — previously, a network blip
  during `submitSwap` would mark the position FAILED. Now wrapped in
  `submitSwapWithRetry` with exponential backoff.

### Backward compatibility

- All defaults are DRY_RUN-safe. Out of the box, the bot behaves
  identically to v0.1.0 — every new filter is off, every new cap
  is disabled.
- The `settings` table is created on first run; existing v0.1.0
  databases are migrated in place (no schema version bump needed).
- No new env vars required. All 19 settings have sensible
  hard-coded defaults that fall back from `.env` if present.

## [0.1.0] - 2026-06-14

### Added

- **Initial release** of the trimmed-down copy-trading bot.
- Watchlist management via Telegram (`/addwallet`, `/removewallet`,
  `/listwallets`).
- Helius Enhanced Transactions API poller for watched wallets.
- Detection of `TOKEN_CREATED` events on Pump.fun.
- Detection of `SELL_DETECTED` events (wallet sends SPL token and
  receives SOL in the same transaction).
- Copy-trade executor: on SELL_DETECTED, buy via Jupiter, hold
  `HOLD_MS` ms (default 1000), sell via Jupiter.
- Safety module: `DRY_RUN` gate, `MAX_SOL_PER_TRADE` cap,
  `DAILY_LOSS_CAP_SOL` cap, manual pause via `/pause`.
- SQLite persistence via `better-sqlite3` for watchlist, positions,
  signals, and safety log.
- Telegram notifications for every signal and trade step.
- Wallet generation script (`scripts/generate-wallet.js`).
- Comprehensive documentation: `README.md`, `ARCHITECTURE.md`,
  `RISK.md`, `LICENSE` (MIT + trading disclaimer).
- `npm run check` for syntax-checking all source files.

### Notes

- This is a re-scope of the original `SnipeTrench` project. The
  earlier bundle/cluster detection work is paused and lives in a
  separate folder (`../SnipeTrench/`).
- The default `JUPITER_API_URL` is `https://quote-api.jup.ag/v6`.
  For MEV-protected routing, switch to `https://metis.jup.io`.
- All trades are subject to the safety caps. With the defaults, the
  bot can lose at most 0.01 SOL per trade and 0.05 SOL per day.
