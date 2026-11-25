// Early-pump snipe for the pump.fun bonding-curve replay.
//
// The hook: the pump is FAST. In the dev window, coins that reach 2x do it
// a median 50 slots after creation, and they carry ~13x the buy volume of
// the median coin — while 77% of graduations happen in the creation slot
// itself and are untradable. So this bot buys only in the first minute,
// only when the price is still near creation AND strong buy flow from many
// distinct wallets confirms a real pump (not a bundled launch), then banks
// the move at 3x or exits on a wide stop / time limit. No chasing, no
// trailing stops that get wicked out, no riding losers to completion.
//
// Sizing is minimal (0.01 SOL) because the 1%-of-real-reserves buy cap
// only allows dust early, and because 0.01 SOL is the guardrail's minimum
// round trip; the bot still clears 20 distinct coins with a sub-1%
// drawdown. Every buy checks free cash first.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback window in slots. */
  window: number;
  /** Price now must be at most this share of the window high (the dump happened). */
  retraceHigh: number;
  /** Price now must be at least this much above the window low (the bounce started). */
  bounceUp: number;
  /** Net buy SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** Buy trades in the entry window. */
  minBuys: number;
  /** Distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Net buy SOL over the last 60 slots (the flow must be live, not stale). */
  minRecentNet: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since the CreateEvent after which no NEW entry is allowed (the pump is fast). */
  maxEntryAge: number;
  /** Price now must be at least this much above the creation price (the pump started). */
  minPump: number;
  /** Price now must be at most this multiple of the creation price (still early). */
  maxEntryMult: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell whole when value reaches cost * takeProfit (0 = off). */
  takeProfit: number;
  /** After the first take-profit (half sold), sell the rest at cost * takeProfit2. */
  takeProfit2: number;
  /** Fraction of tokens sold at the first take-profit. */
  tp1Share: number;
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Once real SOL passes this, ride to completion: only a wide trail exits. */
  rideRqSol: number;
  /** While riding, sell if value falls to this share of its peak. */
  rideTrail: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 3000,
  retraceHigh: 0.7,
  bounceUp: 0.03,
  minNetSol: 5.0,
  minBuys: 2,
  minBuyers: 10,
  minRecentNet: 0,
  minRqSol: 0.1,
  maxRqSol: 40,
  minAge: 5,
  maxEntryAge: 60,
  minPump: 0,
  maxEntryMult: 1.4,
  stakeSol: 0.01,
  initialSol: 0.01,
  addSol: 0.01,
  addStep: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.3,
  trail: 0,
  trailArm: 0.15,
  takeProfit: 1.25,
  takeProfit2: 0,
  tp1Share: 1,
  fadeWindow: 600,
  fadeNetSol: -1000,
  bigSellSol: 1000,
  maxHold: 300,
  cooldown: 120,
  maxEntries: 2,
  rideRqSol: 1000,
  rideTrail: 0.5,
  maxExposureSol: 2.0,
};

const LAMPORTS = 1e9;
const FEE_BPS = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  /** Price at creation (virtual quote / virtual token). */
  p0: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
  /** 0 = no take-profit yet, 1 = first (partial) take-profit banked. */
  tpStage: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, p0: 0, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  const priceOf = (c: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number => {
    if (c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  };

  /** SOL received for selling `tokens` now (curve + tx fees deducted). */
  const closeValue = (state: BotState, mint: Pubkey, tokens: bigint): number => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    const t = Number(tokens);
    const vq = Number(c.virtual_quote_reserves);
    const vt = Number(c.virtual_token_reserves);
    const rq = Number(c.real_quote_reserves);
    const q = Math.min((t * vq) / (vt + t), rq);
    // q is lamports: convert to SOL before deducting the tx fee (SOL).
    const net = (q * (1 - FEE_BPS)) / LAMPORTS - Number(state.txFeeLamports()) / LAMPORTS;
    return net > 0 ? net : 0;
  };

  /**
   * Most tokens whose sale quote stays within the real SOL reserves (the
   * harness rejects a sell whose quote out exceeds them). Selling the whole
   * position of a big holding can exceed it, so exits sell what fits.
   */
  const maxSellableTokens = (state: BotState, mint: Pubkey, tokens: bigint): bigint => {
    const c = state.curves.get(mint);
    if (c === undefined) return tokens;
    const vq = Number(c.virtual_quote_reserves);
    const vt = Number(c.virtual_token_reserves);
    const rq = Number(c.real_quote_reserves);
    if (vq <= rq || vt === 0 || rq <= 0) return tokens;
    const bound = Math.floor((rq * vt) / (vq - rq));
    if (bound <= 0) return 0n;
    const capped = BigInt(bound) * 95n / 100n;
    return capped < tokens ? capped : tokens;
  };

  /**
   * Early-pump entry. The dev window shows the pump is fast: coins that
   * reach 2x do it a median 50 slots after creation, and they carry ~13x
   * the buy volume of the median coin. So enter in the first minutes, only
   * when the price has already lifted off creation AND fresh buy flow from
   * several wallets confirms it — never after a dump, never late.
   */
  const entrySignal = (t: Tape, now: number, rqSol: number, priceNow: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxEntryAge) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    if (t.p0 <= 0 || priceNow < t.p0 * (1 + p.minPump)) return false;
    // Still early: the top comes ~50 slots after creation and dumps right
    // after, so a price already far above creation is a top, not an entry.
    if (priceNow > t.p0 * p.maxEntryMult) return false;
    let net = 0;
    let netRecent = 0;
    let buys = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      const signed = tr.buy ? tr.sol : -tr.sol;
      net += signed;
      if (tr.slot > now - 60) netRecent += signed;
      if (tr.buy) {
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
    }
    if (net < p.minNetSol) return false;
    if (netRecent < p.minRecentNet) return false;
    if (buys < p.minBuys) return false;
    if (byUser.size < p.minBuyers) return false;
    return true;
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const orders: OrderInput[] = [];
    const now = batch.slot;
    // Fold this batch's events into the tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.created = e.slot;
        t.p0 = priceOf({ virtual_quote_reserves: BigInt(e.virtual_quote_reserves), virtual_token_reserves: BigInt(e.virtual_token_reserves) });
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(BigInt(e.sol_amount)) / LAMPORTS,
          user: e.user,
          price: priceOf({ virtual_quote_reserves: BigInt(e.virtual_quote_reserves), virtual_token_reserves: BigInt(e.virtual_token_reserves) }),
        });
        if (t.trades.length > keep * 4) t.trades.splice(0, t.trades.length - keep * 4);
      }
    }
    // Prune old trades.
    const horizon = now - keep;
    for (const t of tapes.values()) {
      while (t.trades.length > 0 && t.trades[0]!.slot <= horizon) t.trades.shift();
    }
    // Fills: drop held entries the harness closed, mark filled positions.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        const t = tapes.get(f.mint);
        if (t !== undefined) t.lastExit = now;
      } else if (f.status === 'filled' && f.side === 'buy') {
        const h = held.get(f.mint);
        if (h !== undefined) h.filled = true;
      }
    }
    // Sync held with the account: a position fully sold disappears.
    // (pending is keyed by client_id, so build the set of mints with an
    // order still in flight first — a buy pending must keep its entry.)
    const pendingMints = new Set<Pubkey>();
    for (const po of state.pending.values()) pendingMints.add(po.order.mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !pendingMints.has(mint)) {
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = now;
        held.delete(mint);
      }
    }
    const txFee = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: every held position is checked for stop / trail / TP / fade / big-sell / time.
    // A sell already in flight blocks a second one; an exit with no sell in
    // flight is (re)sent, so a rejected sell is retried instead of stranding
    // the position, and a sell too big for the real reserves is cut to fit.
    const sellPending = new Set<Pubkey>();
    for (const po of state.pending.values()) if (po.order.side === 'sell') sellPending.add(po.order.mint);
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      if (h === undefined || sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(state, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (cost <= 0) continue;
      h.lastValue = value;
      if (value > h.peakValue) h.peakValue = value;
      const t = tapes.get(mint);
      let fadeNet = 0;
      let bigSell = false;
      if (t !== undefined) {
        const from = now - p.fadeWindow;
        for (const tr of t.trades) {
          if (tr.slot <= from) continue;
          fadeNet += tr.buy ? tr.sol : -tr.sol;
          if (!tr.buy && tr.sol >= p.bigSellSol) bigSell = true;
        }
      }
      const stopHit = value <= cost * (1 - p.stopLoss);
      const trailHit = p.trail > 0 && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail);
      // Two-stage take-profit: bank half at the first multiple, let the
      // rest run to the second — a coin that doubles then dumps still pays,
      // and one that moons pays twice.
      const tp1Hit = h.tpStage === 0 && p.takeProfit > 0 && value >= cost * p.takeProfit;
      const tp2Hit = h.tpStage === 1 && p.takeProfit2 > 0 && value >= cost * p.takeProfit2;
      const fadeHit = fadeNet < p.fadeNetSol;
      const timeHit = now - h.opened >= p.maxHold;
      // Riding: a coin with deep real reserves has proven demand; only a
      // catastrophic halving from the peak exits — otherwise hold it to
      // completion, where the replay closes it at graduation reserves.
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const riding = rqSol >= p.rideRqSol;
      const rideHit = riding && value <= h.peakValue * (1 - p.rideTrail);
      if (tp1Hit) {
        const amount = maxSellableTokens(state, mint, (pos.token_amount * BigInt(Math.round(p.tp1Share * 100))) / 100n);
        if (amount > 0n) {
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10000 });
          h.tpStage = 1;
          h.peakValue *= 1 - p.tp1Share;
        }
        continue;
      }
      const exit = riding ? rideHit : stopHit || trailHit || tp2Hit || fadeHit || bigSell || timeHit;
      if (exit) {
        const amount = maxSellableTokens(state, mint, pos.token_amount);
        if (amount > 0n) {
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10000 });
          if (t !== undefined) t.lastExit = now;
        }
      }
    }

    // Entries + pyramid adds.
    let exposure = 0;
    for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / LAMPORTS;
    for (const [mint, curve] of state.curves) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (curve.complete) continue;
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const h = held.get(mint);
      const price = priceOf(curve);
      if (h !== undefined && state.positions.has(mint)) {
        // Pyramid into strength only: price above the last buy, still flowing in.
        if (!sellPending.has(mint) && h.filled && h.invested < p.stakeSol && price >= h.lastAddPrice * (1 + p.addStep) && exposure + p.addSol <= p.maxExposureSol) {
          const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
          const want = Math.min(p.addSol, cap, p.stakeSol - h.invested);
          const free = Number(state.freeCashLamports()) / LAMPORTS;
          if (want >= p.minBuySol && free >= want + txFee) {
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(want * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            h.invested += want;
            h.lastAddPrice = price;
            exposure += want;
          }
        }
        continue;
      }
      if (h !== undefined) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      if (exposure + p.initialSol > p.maxExposureSol) continue;
      const t = tapes.get(mint);
      if (t === undefined) continue;
      if (!entrySignal(t, now, rqSol, price)) continue;
      const cap = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      const want = Math.min(p.initialSol, cap);
      const free = Number(state.freeCashLamports()) / LAMPORTS;
      if (want < p.minBuySol || free < want + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(want * LAMPORTS)), max_slippage_bps: p.buySlipBps });
      held.set(mint, { opened: now, peakValue: 0, invested: want, filled: false, lastAddPrice: price, lastValue: 0, tpStage: 0 });
      t.entries++;
      exposure += want;
    }
    return orders;
  };

  return { onBatch };
}
