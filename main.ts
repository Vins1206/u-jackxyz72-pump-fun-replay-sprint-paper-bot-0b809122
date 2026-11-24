// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// A first-print breakout bot for pump.fun bonding curves, written from
// scratch for this competition. It speaks the replay protocol directly on
// stdin / stdout (hello, batch..., done) with no dependencies and no
// network.
//
// Idea: most curves pump and then dump, and only a few migrate — but the
// coins that do run first print a clean +10% breakout from their create
// price, driven by a concentrated few buyers. The bot snapshots each
// curve at the very trade where its price first prints +10% (per-trade,
// not per-batch: a batch's later trades already show a bigger, worse
// launch), then waits 50 slots before judging it: buying the print
// itself fills 2 slots later at the burst top and the price reverts
// straight into the stop loss, so a coin is only bought if it still
// holds the print price after the wait, with a concentrated buyer base
// and a creator who has not sold. Entries are small, losers are cut at
// -20%, and winners run to +30% or a trailing stop. One entry per coin
// keeps the fee bill (about 2.7% of stake per round trip) from eating
// the edge, and the fast loser-cuts recycle the 5 open-position slots
// across the coins that qualify, which is also what the 20-coin minimum
// bar needs.
//
// Deterministic by construction: no clock, no environment, no randomness.
// Iteration is always over insertion-ordered maps fed by the batch stream,
// so the two graded executions produce byte-identical action logs.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

// --- tuning knobs (chosen on the dev window with grade-local, see README) ---
const STAKE_LAMPORTS = 100_000_000n; // 0.10 SOL first buy, before the 1% cap
const ADD_LAMPORTS = 50_000_000n; // 0.05 SOL pyramid add into a coin still climbing
const MAX_STAKE_LAMPORTS = 300_000_000n; // 0.30 SOL most into one coin (pyramid adds)
const MIN_BUY_LAMPORTS = 5_000_000n; // 0.005 SOL smallest buy: young curves hold little real SOL, so the 1% cap binds hard
const BUY_SLIPPAGE_BPS = 500; // 5%: a first-print buy that would fill >5% above the print is a burst top — refuse it
const SELL_SLIPPAGE_BPS = 10_000; // sells always go out
const WINDOW_TRADES = 30; // tape window for the entry signal
const MAX_BUYERS_FIRST_PRINT = 4; // concentrated breakout: at most 4 distinct buyers at the first +10% print
const FIRST_PRINT_RUNUP = 1.1; // the first +10% print from the create price
const CONFIRM_SLOTS = 25; // after the first +10% print, wait 25 slots: burst tops revert within 2; a coin that still holds the print price has a real bid behind it
const CONFIRM_HOLD = 1.0; // ...price at confirm time must be at or above the print price
const MAX_BUYERS_AT_CONFIRM = 6; // ...and the buyer base must not have exploded meanwhile
const MIN_REAL_SOL = 500_000_000n; // 0.5 SOL real reserves at entry (unused floor; size check governs)
const ADD_PRICE_STEP = 1.1; // pyramid when the price is 10% above the last buy
const ADD_MIN_NET_SOL = 50_000_000n; // ...while net flow over the tape is still positive
const TAKE_PROFIT = 1.3; // sell whole position at +30% on cost
const STOP_LOSS = 0.8; // ...or at -20%
const TRAIL_ARM = 1.2; // trailing stop arms at +20%
const TRAIL_DROP = 0.9; // ...then sells on a 10% fall from the peak
const MAX_HOLD_SLOTS = 300; // hard time limit per position: confirmed prints bleed slowly after ~200 slots, so take the early exit
const FADE_TRADES = 15; // fade exit looks at the last 15 trades
const FADE_NET_SOL = -10000000000n; // effectively off for sniper holds
const COOLDOWN_SLOTS = 800; // wait after an exit before re-entering a coin
const MAX_ENTRIES_PER_COIN = 1; // one first-print buy per coin, ever
const MAX_NEW_PER_BATCH = 2;

type U64 = string;

interface Trade {
  slot: number;
  price: number; // SOL per token, after the trade
  sol: bigint; // signed SOL: +buy, -sell
  isBuy: boolean;
  user: string;
}

interface Curve {
  mint: string;
  createdSlot: number | null;
  creator: string;
  createPrice: number;
  /** Distinct buyers since creation (never shrinks): the breakout filter
      judges the whole launch, not just the last 30 trades. */
  buyersAll: Set<string>;
  /** Whether the creator has ever sold on this curve. */
  creatorSoldEver: boolean;
  /** The first +10% print has been seen and decided (buy or pass, never
      revisited): waiting for a bigger size only buys later, worse prints. */
  breakoutDecided: boolean;
  /** Snapshot taken at the very trade where the price first printed +10%
      over the create price: price, real SOL, distinct buyers then, whether
      the creator had sold by then, and how many trades had printed. */
  firstPrint: {
    slot: number;
    price: number;
    realSol: bigint;
    buyers: number;
    creatorSold: boolean;
    trades: number;
  } | null;
  price: number; // latest lamports per token (virtual quote / virtual token)
  realSol: bigint;
  complete: boolean;
  trades: Trade[]; // last WINDOW_TRADES trades, in order
  high: number; // highest price inside the tape window
  entries: number; // entries bought on this coin so far
  cooldownUntil: number;
  lastBuyPrice: number;
  lastBuySlot: number;
  spent: bigint; // SOL spent on the current position (approx, from fills)
  peakRatio: number; // best mark value / cost seen while holding
  heldSinceSlot: number;
}

interface Position {
  mint: string;
  tokens: bigint;
  cost: bigint;
}

interface Order {
  side: "buy" | "sell";
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
  client_id?: string;
}

const curves = new Map<string, Curve>();
let hello: any = null;
let orderSeq = 0;

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function getCurve(mint: string): Curve {
  let c = curves.get(mint);
  if (!c) {
    c = {
      mint,
      createdSlot: null,
      creator: "",
      createPrice: 0,
      buyersAll: new Set<string>(),
      creatorSoldEver: false,
      breakoutDecided: false,
      firstPrint: null,
      price: 0,
      realSol: 0n,
      complete: false,
      trades: [],
      high: 0,
      entries: 0,
      cooldownUntil: 0,
      lastBuyPrice: 0,
      lastBuySlot: 0,
      spent: 0n,
      peakRatio: 0,
      heldSinceSlot: 0,
    };
    curves.set(mint, c);
  }
  return c;
}

function pushTrade(c: Curve, t: Trade): void {
  c.trades.push(t);
  if (c.trades.length > WINDOW_TRADES) c.trades.splice(0, c.trades.length - WINDOW_TRADES);
  c.high = 0;
  for (const x of c.trades) if (x.price > c.high) c.high = x.price;
}

function tapeStats(c: Curve): {
  buys: number;
  buyers: Set<string>;
  netSol: bigint;
  buySol: bigint;
  maxBuyerSol: bigint;
  startPrice: number;
} {
  let buys = 0;
  const buyers = new Set<string>();
  let netSol = 0n;
  let buySol = 0n;
  const perBuyer = new Map<string, bigint>();
  for (const t of c.trades) {
    netSol += t.sol;
    if (t.isBuy) {
      buys++;
      buyers.add(t.user);
      buySol += t.sol;
      perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0n) + t.sol);
    }
  }
  let maxBuyerSol = 0n;
  for (const v of perBuyer.values()) if (v > maxBuyerSol) maxBuyerSol = v;
  return { buys, buyers, netSol, buySol, maxBuyerSol, startPrice: c.trades.length > 0 ? c.trades[0].price : 0 };
}

function recentNetSol(c: Curve, n: number): bigint {
  let net = 0n;
  const ts = c.trades.slice(-n);
  for (const t of ts) net += t.sol;
  return net;
}

function decide(state: {
  cash: bigint;
  positions: Map<string, Position>;
  pendingBuyMints: Set<string>;
  slot: number;
  maxOpen: number;
  maxOrders: number;
  maxBuyBps: number;
  txFee: bigint;
}): Order[] {
  const orders: Order[] = [];
  let free = state.cash;
  // Pending buys already reserve cash in the harness's account view? No:
  // account.cash is pre-fill, so subtract what is already in flight.
  // (The caller passes cash already net of pending via freeCashLamports.)
  let openSlots = state.maxOpen - state.positions.size - state.pendingBuyMints.size;
  let newEntries = 0;

  // --- exits first: free slots and lock in gains before buying more ---
  for (const [mint, pos] of state.positions) {
    const c = curves.get(mint);
    if (!c || c.price <= 0 || pos.cost === 0n) continue;
    const value = BigInt(Math.floor(Number(pos.tokens) * c.price)); // lamports: priceOf is lamports per token (virtual quote is in lamports)
    const ratio = Number(value) / Number(pos.cost);
    if (ratio > c.peakRatio) c.peakRatio = ratio;
    const held = state.slot - c.heldSinceSlot;
    let exit = false;
    if (ratio >= TAKE_PROFIT) exit = true;
    else if (ratio <= STOP_LOSS) exit = true;
    else if (c.peakRatio >= TRAIL_ARM && ratio <= c.peakRatio * TRAIL_DROP) exit = true;
    else if (held >= MAX_HOLD_SLOTS) exit = true;
    else if (ratio < 1.05 && recentNetSol(c, FADE_TRADES) <= FADE_NET_SOL) exit = true;
    if (exit) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
        client_id: `x${++orderSeq}`,
      });
      c.cooldownUntil = state.slot + COOLDOWN_SLOTS;
      c.peakRatio = 0;
      openSlots++;
      free -= state.txFee;
    }
  }

  // --- entries and pyramid adds ---
  // Candidates in first-seen order (insertion order = deterministic).
  for (const c of curves.values()) {
    if (orders.length >= state.maxOrders) break;
    if (c.complete || c.price <= 0) continue;
    const pos = state.positions.get(c.mint);
    const pendingBuy = state.pendingBuyMints.has(c.mint);

    if (pos && !pendingBuy) {
      // Pyramid into strength only.
      if (
        c.spent < MAX_STAKE_LAMPORTS &&
        c.price >= c.lastBuyPrice * ADD_PRICE_STEP &&
        recentNetSol(c, WINDOW_TRADES) >= ADD_MIN_NET_SOL &&
        c.realSol >= MIN_REAL_SOL
      ) {
        const cap = (c.realSol * BigInt(state.maxBuyBps)) / BPS;
        let amount = ADD_LAMPORTS;
        if (amount > cap) amount = cap;
        if (amount > MAX_STAKE_LAMPORTS - c.spent) amount = MAX_STAKE_LAMPORTS - c.spent;
        if (amount >= MIN_BUY_LAMPORTS && free >= amount + state.txFee) {
          orders.push({
            side: "buy",
            mint: c.mint,
            quote_lamports: amount.toString(),
            max_slippage_bps: BUY_SLIPPAGE_BPS,
            client_id: `b${++orderSeq}`,
          });
          free -= amount + state.txFee;
          c.spent += amount;
          c.lastBuyPrice = c.price;
          c.lastBuySlot = state.slot;
        }
      }
      continue;
    }
    if (pos || pendingBuy) continue;
    if (newEntries >= MAX_NEW_PER_BATCH) continue;
    if (openSlots <= 0) continue;
    if (c.entries >= MAX_ENTRIES_PER_COIN) continue;
    if (state.slot < c.cooldownUntil) continue;
    if (c.createdSlot === null) continue;
    // First-print breakout entry, judged once, from the snapshot taken at
    // the trade where the price first printed +10% over the create price —
    // but only after the print has held for CONFIRM_SLOTS: buying the print
    // itself fills 2 slots later at the burst top and the price reverts
    // straight into the stop loss. A coin that still holds the print price
    // after the wait is bought at the (current, settled) price instead.
    const fp = c.firstPrint;
    if (fp === null) continue;
    if (c.breakoutDecided) continue;
    if (state.slot < fp.slot + CONFIRM_SLOTS) continue; // not decided yet — keep waiting
    c.breakoutDecided = true;
    if (fp.trades < 3) continue;
    if (fp.buyers < 2 || fp.buyers > MAX_BUYERS_FIRST_PRINT) continue;
    if (fp.creatorSold) continue;
    if (c.price < fp.price * CONFIRM_HOLD) continue; // reverted below the print — the burst was a top
    if (c.buyersAll.size > MAX_BUYERS_AT_CONFIRM) continue;
    if (c.creatorSoldEver) continue;
    const cap = (c.realSol * BigInt(state.maxBuyBps)) / BPS;
    let amount = STAKE_LAMPORTS;
    if (amount > cap) amount = cap;
    if (amount < MIN_BUY_LAMPORTS) continue;
    if (free < amount + state.txFee) continue;
    orders.push({
      side: "buy",
      mint: c.mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
      client_id: `b${++orderSeq}`,
    });
    free -= amount + state.txFee;
    openSlots--;
    newEntries++;
    c.entries++;
    c.spent = amount;
    c.lastBuyPrice = c.price;
    c.lastBuySlot = state.slot;
    c.heldSinceSlot = state.slot;
    c.peakRatio = 0;
  }
  return orders;
}

async function main(): Promise<void> {
  const chunks: string[] = [];
  // Read stdin line by line without any dependency.
  let buffer = "";
  const pending = new Map<string, bigint>(); // client_id -> buy lamports in flight
  const positions = new Map<string, Position>();
  let cash = 0n;

  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line === "") continue;
      const msg = JSON.parse(line);
      if (msg.type === "hello") {
        hello = msg;
        cash = BigInt(msg.capital.lamports);
      } else if (msg.type === "batch") {
        const slot: number = msg.slot;
        // Fills first: drop resolved orders, refresh account.
        for (const f of msg.fills ?? []) {
          pending.delete(f.client_id);
          pendingMintByClient.delete(f.client_id);
        }
        cash = BigInt(msg.account.cash_lamports);
        positions.clear();
        for (const p of msg.account.positions ?? []) {
          const tokens = BigInt(p.token_amount);
          if (tokens > 0n) positions.set(p.mint, { mint: p.mint, tokens, cost: BigInt(p.cost_lamports) });
        }
        // Marks refresh prices for held / pending curves.
        for (const m of msg.marks ?? []) {
          const c = getCurve(m.mint);
          c.price = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
          c.realSol = BigInt(m.real_quote_reserves);
        }
        // Events in chain order.
        for (const e of msg.events ?? []) {
          const c = getCurve(e.mint);
          if (e.event === "CreateEvent") {
            c.createdSlot = e.slot;
            c.creator = e.creator;
            c.price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
            c.createPrice = c.price;
            c.realSol = 0n;
          } else if (e.event === "TradeEvent") {
            c.price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
            c.realSol = BigInt(e.real_quote_reserves);
            if (e.is_buy) c.buyersAll.add(e.user);
            if (e.user === c.creator && !e.is_buy) c.creatorSoldEver = true;
            pushTrade(c, {
              slot: e.slot,
              price: c.price,
              sol: e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount),
              isBuy: e.is_buy,
              user: e.user,
            });
            // Snapshot the first +10% print, per trade, as it happens.
            if (
              c.firstPrint === null &&
              c.createPrice > 0 &&
              c.price >= c.createPrice * FIRST_PRINT_RUNUP
            ) {
              c.firstPrint = {
                slot: e.slot,
                price: c.price,
                realSol: c.realSol,
                buyers: c.buyersAll.size,
                creatorSold: c.creatorSoldEver,
                trades: c.trades.length,
              };
            }
          } else if (e.event === "CompleteEvent") {
            c.complete = true;
          }
        }
        // Track held-since and spent for positions that just appeared.
        for (const [mint] of positions) {
          const c = curves.get(mint);
          if (c && c.heldSinceSlot === 0) c.heldSinceSlot = slot;
        }
        const pendingBuyMints = new Set<string>();
        for (const cid of pending.keys()) {
          const mint = pendingMintByClient.get(cid);
          if (mint) pendingBuyMints.add(mint);
        }
        const txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
        let free = cash;
        for (const p of pending.values()) free -= p + txFee;
        const orders = decide({
          cash: free,
          positions,
          pendingBuyMints,
          slot,
          maxOpen: hello.caps.max_open_positions,
          maxOrders: hello.caps.max_orders_per_batch,
          maxBuyBps: hello.caps.max_order_bps_of_real_reserve,
          txFee,
        });
        for (const o of orders) {
          if (o.side === "buy") {
            pending.set(o.client_id!, BigInt(o.quote_lamports!));
            pendingMintByClient.set(o.client_id!, o.mint);
          }
        }
        const reply = JSON.stringify({ type: "reply", seq: msg.seq, orders });
        process.stdout.write(reply + "\n");
      } else if (msg.type === "done") {
        return;
      }
    }
  }
}

// client_id -> mint for buys still in flight.
const pendingMintByClient = new Map<string, string>();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
