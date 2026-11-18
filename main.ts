// V-Bounce: a dip-bounce mean-reversion bot for cbBTC/USDC.
//
// Trades the agent-fun/bars-replay/v1 protocol (one 1-minute cbBTC/USDC
// bar per batch) through the kit's TypeScript shim in vendor/ (a
// byte-for-byte copy of the kit SDK, so it carries no authorship).
//
// Idea: BTC spends most of a day chopping inside a range, then snaps back
// after a sharp hourly dip. The bot waits for a real dip, demands proof
// the dip is over (a bounce off the low), and then rides the snap-back
// with a take-profit, a stop-loss and a trailing stop armed once the trade
// is in profit. It never shorts, never uses leverage, holds at most one
// position, and trades with the whole cash balance when it does trade.
//
// Entry (flat only, all maths in bigints on raw price units, no floats):
//   - Look at the 60 one-minute bars before the current bar. Let HI be
//     their highest high and LO their lowest low.
//   - ARM when the current close falls at least DROP_BPS below HI: the
//     market has dropped hard within the hour.
//   - BUY (full cash) once armed and the current close has bounced at
//     least BOUNCE_BPS above LO: the dip found a floor and turned.
//   - A fresh dip is needed after every exit (armed resets on entry and
//     on exit), so a falling market cannot make the bot buy the same dip
//     twice.
//   - No new entries in the final hour of the 1440-bar window: a position
//     opened that late has almost no time to earn back the ~36 bps a full
//     round trip costs, and would mostly be flattened at the end for a
//     loss.
//
// Exit (while holding; entryClose is the close of the bar the buy was
// decided on, peakClose the highest close seen since entry):
//   - STOP: close 1.5% under entryClose.
//   - TAKE: close 2.0% over entryClose.
//   - TRAIL: once the close is 1.0% over entryClose, exit when the close
//     falls 0.5% below peakClose. This banks a profit when a bounce stalls
//     below the take-profit, and still rides a bigger rally up to it.
//
// Determinism: every decision is a pure function of the bars seen so far
// and the fills reported in the batches. No clock, no environment, no
// randomness, no files, no network. Two executions on the same data send
// the same orders.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Rolling window for the dip/bounce reference, in one-minute bars.
const WINDOW_BARS = 60;
// Arm the entry when the close is this far (bps) under the 60-bar high.
const DROP_BPS = 100n;
// Buy once armed and the close is this far (bps) over the 60-bar low.
const BOUNCE_BPS = 30n;
// Take profit / stop loss, in bps over / under the entry close.
const TAKE_BPS = 200n;
const STOP_BPS = 150n;
// Trailing stop: arms at this gain over entry, exits this far under the peak.
const TRAIL_ARM_BPS = 100n;
const TRAIL_BPS = 50n;
// Max slippage on any order, in bps from the latest close. One-minute
// moves on this pool are well under 1%, so a fill past this is a gap the
// bot would rather skip (the order is rejected and the entry re-arms).
const MAX_SLIP_BPS = 100;
// Scored window length and the no-new-entry tail, in bars.
const TOTAL_BARS = 1440;
const FINAL_HOUR_BARS = 60;
const BPS = 10000n;

class VBounce {
  // Raw closes/highs/lows (price-scale bigints) of every bar seen,
  // warm-up bars included, in arrival order.
  private closes: bigint[] = [];
  private highs: bigint[] = [];
  private lows: bigint[] = [];
  // Entry state.
  private armed = false;
  private entryClose: bigint | null = null;
  private peakClose: bigint | null = null;
  // True while an order sent on the previous batch is unconfirmed.
  private pendingBuy = false;
  private pendingSell = false;

  private record(batch: Batch): void {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        this.closes.push(BigInt(bar.c));
        this.highs.push(BigInt(bar.h));
        this.lows.push(BigInt(bar.l));
      }
    }
  }

  private sellAll(state: BarsState): OrderInput[] {
    const holding = state.positions.get(SYMBOL);
    if (holding === undefined || holding.qty <= 0n) return [];
    this.pendingSell = true;
    return [{ side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: MAX_SLIP_BPS }];
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    this.record(batch);
    // Warm-up batches build history only: orders on them are rejected.
    if (state.warmingUp) return [];
    if (this.closes.length < WINDOW_BARS + 1) return [];

    const holding = state.positions.get(SYMBOL);
    const isHolding = holding !== undefined && holding.qty > 0n;
    if (this.pendingBuy) {
      // The buy was confirmed (position open) or rejected (still flat).
      if (!isHolding) {
        this.entryClose = null;
        this.peakClose = null;
      }
      this.pendingBuy = false;
    }
    if (this.pendingSell) this.pendingSell = false;

    const close = this.closes[this.closes.length - 1];

    if (isHolding) {
      if (this.entryClose === null) {
        // A position we did not open (cannot happen in this replay, but
        // stay safe): anchor exits to this close.
        this.entryClose = close;
        this.peakClose = close;
      }
      if (this.peakClose !== null && close > this.peakClose) this.peakClose = close;
      const entry = this.entryClose;
      const peak = this.peakClose as bigint;
      if (close * BPS <= entry * (BPS - STOP_BPS)) {
        this.armed = false;
        this.entryClose = null;
        this.peakClose = null;
        return this.sellAll(state);
      }
      if (close * BPS >= entry * (BPS + TAKE_BPS)) {
        this.armed = false;
        this.entryClose = null;
        this.peakClose = null;
        return this.sellAll(state);
      }
      if (close * BPS >= entry * (BPS + TRAIL_ARM_BPS) && close * BPS <= peak * (BPS - TRAIL_BPS)) {
        this.armed = false;
        this.entryClose = null;
        this.peakClose = null;
        return this.sellAll(state);
      }
      return [];
    }

    // Flat: a position just closed (or a buy just rejected).
    this.entryClose = null;
    this.peakClose = null;

    // No new entries in the final hour of the scored window.
    const scoredIndex = state.seq - state.warmupBars;
    if (scoredIndex >= TOTAL_BARS - FINAL_HOUR_BARS) return [];

    const winHigh = this.highs.slice(-WINDOW_BARS - 1, -1).reduce((a, b) => (a > b ? a : b));
    const winLow = this.lows.slice(-WINDOW_BARS - 1, -1).reduce((a, b) => (a < b ? a : b));
    if (!this.armed && close * BPS <= winHigh * (BPS - DROP_BPS)) this.armed = true;
    if (this.armed && close * BPS >= winLow * (BPS + BOUNCE_BPS)) {
      this.armed = false;
      this.entryClose = close;
      this.peakClose = close;
      const amount = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (amount < minNotional) {
        this.entryClose = null;
        this.peakClose = null;
        return [];
      }
      this.pendingBuy = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIP_BPS }];
    }
    return [];
  }
}

const bot = new VBounce();
await runBars(bot);
