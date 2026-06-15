# Risk Discussion

This document is non-exhaustive. **Using this bot to trade real money
can result in total loss of the funds in the bot wallet.** Read the
whole thing.

---

## 1. The strategy itself is risky

The bot's strategy is: when a dev wallet sells its own token, the bot
buys and exits 1 second later. This is a **micro-scalp**, not investing.
The thesis is that the immediate price impact of the dev's sell is
temporary and a quick buy can capture the bounce.

In practice:

- The dev's sell may have permanent price impact (the dev is selling
  because they think the price is at or above fair value).
- The 1-second hold gives the bot very little time to be right. Most
  blocks on Solana are ~400ms; one block of adverse price movement can
  erase the entire expected profit.
- Other bots and human snipers will see the same signal and may trade
  in the same direction, increasing slippage.
- The bot is competing with MEV searchers who can front-run the buy
  transaction (see below).

**Expected outcome**: the bot will win some trades and lose others. On
most networks, latency-sensitive micro-scalps have a negative expected
value for retail participants.

### Mitigations in this bot

- `MAX_SOL_PER_TRADE` caps loss per trade
- `DAILY_LOSS_CAP_SOL` caps loss per day
- `SLIPPAGE_BPS` prevents the bot from accepting catastrophic fills
- DRY_RUN mode lets you observe without risking capital

---

## 2. Front-running and MEV

Solana has a much smaller MEV ecosystem than Ethereum, but it is not
zero. The most relevant risks for this bot:

### Front-running by searchers

If the dev's sell transaction is in the public mempool, a sophisticated
operator can see it, build a competing transaction, and submit it with
a higher priority fee to land first. For a "buy right after the dev
sells" strategy, this is mostly a non-issue (the dev is selling, not
buying) but it can affect the bot's sell: a searcher can see the bot's
sell transaction, front-run it with their own sell, and cause the bot
to receive less SOL.

### Sandwich attacks

A searcher can sandwich the bot's buy between two of their own
transactions: a buy just before (driving the price up) and a sell just
after (driving it down). The bot buys high, the searcher sells high,
the bot sells low. The bot's slippage tolerance is the upper bound on
this loss.

### Jito bundles

If you switch to `JUPITER_API_URL=https://metis.jup.io`, Jupiter routes
the trade through a private mempool and Jito bundle, which mitigates
front-running at the cost of a slightly higher fee. The default v6
endpoint does **not** have this protection.

### Mitigations

- Use Metis if MEV is a concern (it costs a small amount of SOL per
  trade for the protection)
- Keep `SLIPPAGE_BPS` low (5% is a wide sandwich window)
- Avoid trading during periods of high MEV activity (large token
  launches, market-wide events)

---

## 3. Smart contract risk

Every trade goes through:

- The Pump.fun bonding curve (or Raydium if migrated)
- Jupiter's routing contract
- SPL Token program

Each of these is a program on Solana and each can have bugs. The Pump.fun
contract has been audited but Pump.fun tokens themselves are minted by
the dev with arbitrary metadata — a malicious dev can include code in
the token's transfer hook (if enabled) that does unexpected things.

### Mitigations

- Jupiter is a well-established aggregator with multiple audits. The
  risk is small but non-zero.
- The bot does not approve unlimited token allowances (it uses
  transaction-per-trade). The exposure window is single-block.
- The bot holds the bought tokens for 1 second — there's no long-tail
  risk from approving allowances.

---

## 4. Operational risks

### Private key compromise

The bot's private key is in `.env`. If your machine is compromised, an
attacker can drain the wallet. Mitigations:

- Run on a dedicated, hardened VPS
- Use `chmod 600 .env`
- Don't store `.env` in a synced folder (Dropbox, OneDrive)
- Use a separate wallet for the bot (don't reuse a wallet that holds
  long-term funds)
- Consider a hardware wallet integration (out of scope for v0.1.0)

### Process crash mid-trade

The bot's trade flow is:

1. Open position row in DB
2. Sign and submit BUY
3. Wait `HOLD_MS`
4. Sign and submit SELL
5. Update position row

If the process crashes between steps 2 and 4, the position is OPEN in
the DB but the bot has tokens. The bot does not currently recover from
this state — the position stays OPEN and the tokens sit in the wallet.

### Network failure

If the RPC endpoint is down, the bot can't sign transactions. If
Jupiter is down, the bot can't get quotes. Both have public status
pages. The bot will log errors and continue trying; it does not stop
trading on transient errors.

### Clock drift

`HOLD_MS` is measured by `setTimeout` on the local clock. If the local
clock jumps (NTP sync, VM resume from suspension), the hold time may
be longer or shorter than configured. Not a meaningful risk for
1-second holds.

---

## 5. Market risks

### Liquidity

The bot buys with `MAX_SOL_PER_TRADE` SOL. On a freshly-launched
Pump.fun token with low liquidity, even a small buy can move the
price significantly. The bot will get a worse fill than the quote
suggests.

### Volatility

Pump.fun tokens can drop 50%+ in seconds. The 1-second hold means the
bot may sell into a worse price than it bought. This is the dominant
risk of the strategy.

### Time-of-day patterns

Pump.fun launch activity is not uniform — there are peak hours (US
trading hours) and quiet hours. The bot does not adjust for this.

---

## 6. Bot bugs

This is v0.1.0. There are likely bugs. The categories:

### Race conditions

The polling loop fetches the same wallet's transactions on each tick.
If a new transaction appears in the same tick that we're processing
an old one, the in-memory seen-set may not catch it (depending on
order). Mitigated by `seenSignatures` being a per-wallet Set that is
checked before processing.

### Off-by-one in HOLD_MS

`setTimeout(r, HOLD_MS)` waits at least `HOLD_MS`, not exactly
`HOLD_MS`. On a busy event loop, it may wait significantly longer. The
default of 1000ms is forgiving; if you set it to 100ms, expect
unpredictable behavior.

### Decimal handling

The bot assumes the bought token uses Jupiter's raw unit conventions
in the quote. This is correct for the swap, but the `entry_tokens`
column in `positions` is the raw unit count, not the human-readable
token count. Display logic in `notifier.js` doesn't account for token
decimals. The PnL calculation is in SOL, which is unit-correct.

### Detection miss

If Helius changes the API response shape, the bot's classifier may
miss events. The conservative detection rules (require all three
signals for a token creation) are designed to minimize false positives
at the cost of some false negatives.

---

## 7. Legal and regulatory

This bot operates on public blockchains. The legality of automated
trading bots varies by jurisdiction. You are responsible for:

- Compliance with local securities regulations
- Tax reporting on realized gains/losses
- KYC/AML requirements if applicable

The authors of this software make no representations about its
legality in any jurisdiction.

---

## 8. What "safe" looks like

If you decide to run this bot with real money, here is a configuration
that minimizes risk while still being useful:

```bash
# Conservative defaults
DRY_RUN=false
MAX_SOL_PER_TRADE=0.005       # 0.005 SOL per trade
SLIPPAGE_BPS=300              # 3% slippage
HOLD_MS=1000                  # 1 second (default)
DAILY_LOSS_CAP_SOL=0.02       # Pause after 0.02 SOL daily loss
JUPITER_API_URL=https://metis.jup.io  # MEV-protected routing
```

Fund the bot wallet with **0.1 SOL** to start. This is enough for ~20
trades plus gas. When the wallet runs low, top up. When you've decided
the strategy is unprofitable, sweep the remaining balance out and stop
the bot.

---

## 9. When to stop using the bot

Stop using the bot immediately if:

- You see a large unexpected loss in `/status` or `/recent`
- The bot starts logging unfamiliar errors
- Your wallet is drained unexpectedly
- The bot's `seenSignatures` set grows to consume significant memory
  (currently unbounded; check with `process.memoryUsage()`)
- You stop trusting the security of the host machine

The bot does not have a "self-destruct" feature. To stop it, kill the
process (`Ctrl+C` or `pm2 stop snipetrench`). The remaining tokens in
the wallet will sit there until you manually sweep them.
