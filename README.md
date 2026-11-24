# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/Vins1206/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/Vins1206/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper-trading bot for the
[make.fun Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
bounty. It trades 10 SOL of paper money on a replay of 24 hours of pump.fun
bonding-curve activity and is scored on net PnL on a fresh final window the
house collects after entries close. A paid place needs net PnL above holding
cash (above 0 SOL after every fee).

## Strategy

Most curves pump and then dump; only a few run. The bot looks for the coins
that do run, with a **confirmed first-print breakout**:

1. **Snapshot the first +10% print.** For every new curve, the bot records
   the very trade where its price first prints +10% over the create price
   (per trade, not per batch — a batch's later trades already show a bigger,
   worse launch), along with the real SOL reserves, the distinct buyer count
   and whether the creator had sold by then.
2. **Wait for confirmation.** Buying the print itself fills 2 slots later at
   the burst top and the price reverts straight into the stop loss, so the bot
   waits 25 slots and only buys if the coin still holds the print price, the
   buyer base is still concentrated (at most 4 distinct buyers at the print,
   at most 6 by confirmation) and the creator has not sold.
3. **Small size, capped by the curve.** Each first buy is at most 0.10 SOL
   and at most 1% of the curve's real SOL reserves at confirmation (young
   curves hold little real SOL, so the 1% cap usually binds at ~0.02 SOL).
   One entry per coin, at most 2 new entries per batch, at most 5 open
   positions.
4. **Pyramid into strength only.** Adds 0.05 SOL when the price is 10% above
   the last buy and net flow over the tape is still positive, up to 0.30 SOL
   per coin.
5. **Exits.** Take profit at +30% on cost, stop loss at −20%, a trailing stop
   that arms at +20% and sells on a 10% fall from the peak, and a hard
   300-slot maximum hold — confirmed prints bleed slowly after ~200 slots,
   so the early exit keeps most of the fee drag off the losers. Buys use a
   5% slippage cap: a fill that would land more than 5% above the decision
   price is refused outright.

## Implementation

A single file, `main.ts`, zero dependencies, Node stdlib only. It speaks the
replay protocol directly on stdin/stdout (`hello`, one `batch` per slot,
`done`) and replies with exactly one `{"type":"reply","seq","orders":[...]}` per
batch. No network, no clock, no environment, no randomness — iteration is
always over insertion-ordered maps fed by the batch stream, so the two graded
executions produce byte-identical action logs.

## Local grading

From the unpacked kit directory (the kit is downloaded from the bounty page):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree --save <out>
```

## Dev-window results (house frozen dev window, 128,058 events, 1,222 mints)

| Variant | Net PnL (SOL) | Coins | Round trips | Win rate | Guardrails |
| --- | --- | --- | --- | --- | --- |
| Momentum (TP 1.28 / SL 0.88) | −0.994 | 323 | — | — | met |
| Dip-buy (30–45% dip) | −0.510 | 102 | — | — | met |
| Launch sniper, age ≤ 300 | −0.333 | 294 | — | — | met |
| First-print, instant entry | −0.045 | 53 | 59 | 8.5% | met |
| First-print + 25-slot confirmation, hold 300 | **−0.005** | 21 | 22 | 18% | met |

The confirmation step is the whole edge: buying the print itself loses
−0.045 SOL because the 2-slot fill lands at the burst top; waiting 25 slots
for the coin to prove it holds the level cuts the losers from −0.041 to
−0.025 SOL while keeping the winners (+0.020 SOL across 4 coins, best
+0.017 SOL). The entry is still slightly negative on the dev window — the
90% bootstrap interval is −0.030…+0.027 SOL — so the final window decides it.

## License

MIT — see [LICENSE](LICENSE).
