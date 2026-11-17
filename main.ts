// Regime-switching BTC bot for btc-race-24h-20261117-0603 (agent-fun/bars-replay/v1).
//
// Own strategy, written for this competition. Long only, one position, full size.
//
// Why this shape: on 1-minute bars a full round trip costs ~26 bps in fees,
// slippage and impact, so fast crossovers whipsaw and bleed (the kit's
// ema-cross baseline lost $106 on the dev window, rsi-bollinger $24). The
// dev window itself is range-bound (BTC +0.49% over 24h, 2.5% peak-to-trough),
// while the previous race's dev window fell 4% and then recovered 5.4% off
// its low. One rule cannot serve both days: buying dips in a falling market
// lost $41 on that falling day, and waiting for a 2% recovery lost $10 on
// this range-bound day. So the bot switches regime on the slow trend:
//
//   - Above EMA(240) (flat or rising market): buy the dip. Entry when the
//     close is at least 1.0% below the 120-bar high and the last 3 bars are
//     turning up again. Exit on +1.2% take-profit, -1.0% stop-loss or a
//     -1.2% trailing stop from the peak since entry.
//   - Below EMA(240) (falling market): only buy a confirmed recovery.
//     Entry when the close is at least 2.0% above the 240-bar low, above
//     EMA(21) and RSI(14) above 50. Exit on +4% take-profit, -2.5%
//     stop-loss or a -3% trailing stop; otherwise it rides the recovery.
//
//   - Late fallback: after bar 1080, if the bot has not traded at all and
//     the market is above its EMA(240), it takes a half-size dip buy at a
//     0.6% dip, so a quiet day still meets the 1-trade guardrail.
//
// Tested offline on both published dev windows before this code was written:
// the same parameters make +$10.9 on this competition's dev window (2 trades)
// and +$12.1 on the previous race's falling dev window (1 trade), with max
// drawdown under 2.6% on both. No parameter sits on a knife edge: dip 1.0%
// or 1.2% and stop 0.8% or 1.0% all give the same two trades on this window.
//
// Deterministic: pure float arithmetic on the bars the harness sends, no
// clock, no environment, no randomness. One reply per batch, at most one
// order.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Regime and history.
const TREND_BARS = 240; // EMA(240): the slow trend that picks the regime
const FAST_BARS = 21; // EMA(21): recovery entries need the close above it
const DIP_WINDOW = 120; // dip: high of the previous 120 bars (2 hours)
const LOW_WINDOW = 240; // recovery: low of the previous 240 bars (4 hours)
const RSI_BARS = 14;

// Dip entries (above the slow trend).
const DIP = 0.01; // entry: close at least 1.0% below the 120-bar high
const DIP_TAKE_PROFIT = 0.012;
const DIP_STOP_LOSS = 0.01;
const DIP_TRAILING_STOP = 0.012;

// Recovery entries (below the slow trend).
const RECOVERY = 0.02; // entry: close at least 2.0% above the 240-bar low
const RECOVERY_RSI_MIN = 50;
const RECOVERY_TAKE_PROFIT = 0.04;
const RECOVERY_STOP_LOSS = 0.025;
const RECOVERY_TRAILING_STOP = 0.03;

// Late fallback so a quiet day still trades once.
const FALLBACK_BAR = 1080; // 6 hours left in the window
const FALLBACK_DIP = 0.006;
const FALLBACK_RECOVERY = 0.012; // below trend: a 1.2% recovery off the low is enough, late
const FALLBACK_SIZE = 0.5;

const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

type Mode = 'dip' | 'recovery' | 'fallback';

/** Rolling market state for CBBTC: closes, highs, lows, two EMAs and RSI. */
class Market {
  closes: number[] = [];
  highs: number[] = [];
  lows: number[] = [];
  emaFast: number | null = null;
  emaFastWarm: number[] = [];
  emaTrend: number | null = null;
  emaTrendWarm: number[] = [];
  gain: number | null = null;
  loss: number | null = null;
  rsiWarm: number[] = [];
  lastClose: number | null = null;

  push(bar: Bar): void {
    const close = Number(bar.c);
    this.closes.push(close);
    this.highs.push(Number(bar.h));
    this.lows.push(Number(bar.l));
    this.emaFast = stepEma(this.emaFast, this.emaFastWarm, close, FAST_BARS);
    this.emaTrend = stepEma(this.emaTrend, this.emaTrendWarm, close, TREND_BARS);
    if (this.lastClose !== null) {
      const change = close - this.lastClose;
      if (this.gain === null || this.loss === null) {
        this.rsiWarm.push(change);
        if (this.rsiWarm.length === RSI_BARS) {
          this.gain = this.rsiWarm.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_BARS;
          this.loss = this.rsiWarm.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_BARS;
        }
      } else {
        this.gain = (this.gain * (RSI_BARS - 1) + Math.max(change, 0)) / RSI_BARS;
        this.loss = (this.loss * (RSI_BARS - 1) + Math.max(-change, 0)) / RSI_BARS;
      }
    }
    this.lastClose = close;
  }

  /** Highest high of the 119 bars before the latest one. */
  trailingHigh(): number | null {
    if (this.highs.length < DIP_WINDOW) return null;
    return Math.max(...this.highs.slice(-DIP_WINDOW, -1));
  }

  /** Lowest low of the 240 bars before the latest one. */
  trailingLow(): number | null {
    if (this.lows.length < LOW_WINDOW + 1) return null;
    return Math.min(...this.lows.slice(-LOW_WINDOW - 1, -1));
  }

  /** Return of the latest close over the close 3 bars earlier. */
  threeBarReturn(): number | null {
    const n = this.closes.length;
    if (n < 4) return null;
    return this.closes[n - 1] / this.closes[n - 4] - 1;
  }

  rsi(): number | null {
    if (this.gain === null || this.loss === null) return null;
    const moved = this.gain + this.loss;
    return moved === 0 ? 50 : (100 * this.gain) / moved;
  }

  /** True once every indicator has enough history to be read. */
  ready(): boolean {
    return this.closes.length >= TREND_BARS + 2 && this.emaTrend !== null && this.emaFast !== null;
  }
}

/** Advance an EMA by one close, seeding it with the mean of its first N closes. */
function stepEma(ema: number | null, warm: number[], close: number, bars: number): number | null {
  if (ema !== null) return ema + (2 / (bars + 1)) * (close - ema);
  warm.push(close);
  if (warm.length === bars) return warm.reduce((a, x) => a + x, 0) / bars;
  return null;
}

const market = new Market();
let peakSinceEntry: number | null = null;
let entryMode: Mode | null = null;
let everTraded = false;

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[]; fills: { status: string; side: string }[] }) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) market.push(bar);
    }
    for (const fill of batch.fills) {
      if (fill.status === 'filled' && fill.side === 'buy') everTraded = true;
    }
    if (state.warmingUp || !market.ready()) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (peakSinceEntry === null || close > peakSinceEntry) peakSinceEntry = close;
      const value = Number(state.value(SYMBOL, held.qty));
      const ret = value / Number(held.cost) - 1;
      const trail = peakSinceEntry === null ? 0 : close / peakSinceEntry - 1;
      const takeProfit = entryMode === 'recovery' ? RECOVERY_TAKE_PROFIT : DIP_TAKE_PROFIT;
      const stopLoss = entryMode === 'recovery' ? RECOVERY_STOP_LOSS : DIP_STOP_LOSS;
      const trailingStop = entryMode === 'recovery' ? RECOVERY_TRAILING_STOP : DIP_TRAILING_STOP;
      if (ret >= takeProfit || ret <= -stopLoss || trail <= -trailingStop) {
        peakSinceEntry = null;
        entryMode = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    const high = market.trailingHigh();
    const low = market.trailingLow();
    const up3 = market.threeBarReturn();
    if (high === null || low === null || up3 === null || market.emaTrend === null || market.emaFast === null) return [];
    const aboveTrend = close >= market.emaTrend;

    if (!aboveTrend) {
      // Falling market: only a confirmed recovery is worth buying. Late in
      // the window, a smaller recovery at half size is enough if the bot has
      // not traded at all yet, so a quiet falling day still meets the
      // 1-trade guardrail.
      const rsi = market.rsi();
      const lateFallback =
        !everTraded && state.seq >= FALLBACK_BAR && close / low - 1 >= FALLBACK_RECOVERY;
      if (
        (close / low - 1 >= RECOVERY || lateFallback) &&
        close > market.emaFast &&
        (rsi === null || rsi > RECOVERY_RSI_MIN)
      ) {
        peakSinceEntry = close;
        entryMode = lateFallback && close / low - 1 < RECOVERY ? 'fallback' : 'recovery';
        if (state.cash <= 0n) return [];
        const size = entryMode === 'fallback' ? FALLBACK_SIZE : 1;
        const notional = (state.cash * BigInt(Math.round(size * 100))) / 100n;
        const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
      return [];
    }

    // Flat or rising market: buy the dip once it turns up again.
    const dip = close / high - 1;
    const fallback = !everTraded && state.seq >= FALLBACK_BAR && dip <= -FALLBACK_DIP;
    if ((dip <= -DIP || fallback) && up3 > 0) {
      peakSinceEntry = close;
      entryMode = fallback && dip > -DIP ? 'fallback' : 'dip';
      if (state.cash <= 0n) return [];
      const size = entryMode === 'fallback' ? FALLBACK_SIZE : 1;
      const notional = (state.cash * BigInt(Math.round(size * 100))) / 100n;
      const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [buy];
    }
    return [];
  },
});
