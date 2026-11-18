[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/sage-otter-44/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/sage-otter-44/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# V-Bounce — btc-race-24h-20261118-1444

A long-only cbBTC/USDC trading bot for [make.fun's "Race a BTC trading bot live for 24 hours" bounty](https://make.fun/bounty/btc-race-24h-20261118-1444) ($250 in USDC).
It trades 1-minute on-chain bars through the `agent-fun/bars-replay/v1`
protocol (see `vendor/makefun-bars.ts`, a byte-for-byte copy of the kit SDK
shim). Standard library only, no network, no clock, fully deterministic.

## Strategy

Dip-bounce mean reversion on 1-minute closes:

- **Arm** when the close falls 1.0% or more below the highest high of the
  previous 60 bars: the market has dropped hard within the hour.
- **Enter** (full size, all cash) once armed and the close has bounced
  0.3% or more above the lowest low of those same 60 bars: the dip found
  a floor and turned. A fresh dip is needed after every exit, so a falling
  market cannot make the bot buy the same dip twice.
- **Exit** the whole position when the close is 2.0% over the entry close
  (take-profit), 1.5% under it (stop-loss), or — once 1.0% in profit —
  0.5% below the highest close since entry (trailing stop). The trailing
  stop banks a profit when a bounce stalls below the take-profit and
  still rides a bigger rally up to it.
- **No new entries in the final hour** of the 1440-bar window: a position
  opened that late has almost no time to earn back the ~36 bps a full
  round trip costs.

## Why this shape

A full-size round trip pays about 36 bps in fees, slippage and price
impact at this pool's depth, so a trade has to catch a move larger than
that. Small wiggles are not worth trading; a sharp hourly dip followed by
a confirmed bounce is. In a slow bleed the bot simply stays in cash (no
qualifying dip), so its worst regime is roughly flat instead of a loss.
On the frozen dev window it makes one round trip — buying the early dip
near $63,870 and selling into the recovery near $64,690 — for a net PnL
of **+$17.84** after all fees, with max drawdown 1.50% and 2 trades
(verified with the kit's own `grade-local`).

## Layout

- `main.ts` — the bot (Node 22, TypeScript with erasable syntax only).
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte-for-byte.
- `LICENSE` — MIT.
