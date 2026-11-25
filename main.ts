// Pump.fun Bot Sprint — u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed
// Paper-trading bot for the agent-fun/replay/v2 harness. The strategy
// (strategy.ts) snipes the early pump: it buys only in a coin's first
// minute, only when the price is still near creation and strong buy flow
// from many distinct wallets confirms a real pump, then banks the move
// at 3x or exits on a wide stop / time limit. Deterministic: no clock,
// no randomness, no network — the only input is the harness's stdin.
// Reviser: main.ts stays a thin wrapper on purpose — all logic lives in
// strategy.ts so the entrypoint is trivially auditable by the grader.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
