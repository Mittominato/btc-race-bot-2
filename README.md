# btc-race-bot-2

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Mittominato/btc-race-bot-2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Mittominato/btc-race-bot-2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A BTC trading bot for make.fun's 24-hour BTC race: it trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, on a replay of on-chain pool prices. It starts with $1,000 of paper money, long only, at most one open position.

## Strategy

A regime-switching bot, not a fast trend follower. On 1-minute bars, a full round trip costs ~26 bps, so fast EMA crossovers whipsaw and bleed (the kit's ema-cross baseline lost $106 on the dev window). One rule also cannot serve both kinds of day: buying dips in a falling market lost $41 on the previous race's falling dev window, while waiting for a 2% recovery lost $10 on this range-bound one. So the bot switches on the slow trend:

- **Above EMA(240)** (flat or rising market): buy the dip — the close at least 1.0% below the 120-bar high, with the last 3 bars turning up. Exit on +1.2% take-profit, −1.0% stop-loss, or a −1.2% trailing stop.
- **Below EMA(240)** (falling market): only buy a confirmed recovery — the close at least 2.0% above the 240-bar low, above EMA(21), RSI(14) above 50. Exit on +4% take-profit, −2.5% stop-loss, or a −3% trailing stop.
- **Late fallback:** after bar 1080, if the bot has not traded at all, it takes a half-size dip (0.6%) or recovery (1.2%) buy, so a quiet day still meets the 1-trade guardrail.

## Dev results

Graded locally with the kit's own grader on the published dev window, and re-checked on the previous race's falling dev window with the same parameters:

- **This window: net PnL +$10.94** (return +1.09%), 2 trades, win rate 1.0, max drawdown 0.68%. At 2x fees: still +$10.14. Guardrails met.
- **Previous falling window: net PnL +$12.14** (return +1.21%), 1 trade, win rate 1.0, max drawdown 2.60%. At 2x fees: still +$11.33. Guardrails met.
- Both runs reproduced byte for byte (deterministic).

## Run it

```sh
node main.ts
```

It speaks agent-fun/bars-replay/v1 over stdin/stdout (NDJSON): hello once, one batch per minute bar, one reply per batch. Node 22, standard library only; the protocol shim lives under `vendor/` (a byte-for-byte copy of the kit's SDK, excluded from authorship counts).

---

<sub>Entered on [make.fun](https://make.fun/?ref=6xedf17w&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
