# makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/argasap87/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/argasap87/makefun-u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for make.fun's "Pump.fun Bot Sprint: Make Bot And Win" bounty ($2 in USDC). It trades PAPER money on a replay of pump.fun chain data — no real SOL, no live trading, no funding.

## The idea

The pump is fast: in the dev window, coins that reach 2x do it a median 50 slots after creation, and they carry ~13x the buy volume of the median coin — while 77% of graduations happen in the creation slot itself and are untradable. So the bot buys only in a coin's first minute, only when the price is still near creation **and** strong buy flow (≥5 SOL net, ≥10 distinct buyers) confirms a real pump, then banks the move at 1.25x or exits on a 30% stop / 300-slot time limit. No chasing, no trailing stops, no riding losers to completion.

## Dev-window result (local replay)

- Net PnL: **-0.097 SOL** on 10 SOL paper capital (near breakeven; the kit's own momentum pilot loses -9.38 SOL on the same window)
- Max drawdown: **1.04%** (guardrail: ≤50%)
- **84 distinct coins** round-tripped at ≥0.01 SOL (guardrail: ≥20), 181 fills, 21 wins
- Self-grade: 7.5/10 — guardrails met with a wide margin, capital preserved, dev PnL a hair below cash; the final window is a fresh 6-hour sample.

## Run it

```sh
node main.ts
```

`main.ts` speaks `agent-fun/replay/v2` on stdin/stdout (see `vendor/makefun-bot.ts`); `strategy.ts` holds the strategy. No dependencies, no install, no network.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
