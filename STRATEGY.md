# Kalshi Betting Playbook — living document

Goal: $1,000 → $5,000 over the 2026 World Cup. Bear case acknowledged: we can lose the roll. This doc is reviewed and updated after every matchday by heartbeat. The strategy is allowed to change; the discipline is not.

**Mandate (Anita, Jun 12, 2026):** total freedom to change anything — params, caps, brakes, market types. Goals in order: make money, be consistent, self-improve. Her words: "I am counting on you." Every change logged here + in git. Freedom is not an excuse for impulse: changes still require settled-bet evidence, because that IS the make-money strategy.

## The five levers to the bull case
1. **Volume.** 104 matches. Bet every real edge (5pt+ vs market). Pass on everything else. Expect to bet maybe 30-40% of matches.
2. **Compounding.** Bankroll input to Kelly = live balance, not the original $1000. Update KALSHI_BANKROLL after every settle.
3. **Fat-edge markets.** Priority order: (a) TIE markets — retail underprices draws, (b) KXWCSCORE exact scores — lazy pricing, 5-10x payouts, my scoreline model is literally what AgentCup trains, (c) 3-way winner only when the blend diverges hard.
4. **Lineup window.** Confirmed XIs land ~60-75 min before kickoff. The Kalshi retail book reprices slowly. Bet within 15 min of lineup confirmation when news is material (star benched, weakened XI).
5. **Moonshot sleeve.** Max 10% of bankroll across open longshot positions (10c or less, blend says 2x+ the market). These are the 5x engine. Sized small, taken often.

## Hard rules (the discipline)
- No bet under 5pts blended edge. The market is right most of the time.
- Models scattered (stdev of panel probs > ~12pts) = no bet regardless of edge. Scatter is real uncertainty.
- Never exceed conviction caps. Never chase a loss with an unsized bet.
- Every bet logged with all five model probs. Every settle updates trust weights.
- Daily loss brake: if down 15% of bankroll in a day, stop betting until next matchday review.

## The two-way loop (core principle, Anita Jun 12)
The $ results and the predictions grade each other:
- **Bets grade picks.** A lost bet = my probability was wrong, full stop. Points can flatter a bad prob (right winner, wrong calibration); money can't. Every settled bet writes a calibration note into the AgentCup ledger.md with market price vs my prob.
- **Picks grade bets.** My live Brier from picks feeds the blend trust weights. Calibrated picking earns bigger stakes; sloppy picking shrinks them automatically.

## Self-improvement loop (heartbeat)
After every matchday (or daily during group stage):
1. Run `node kalshi.js ledger` — P&L, win rate, model trust shifts.
2. Ask: did edges I passed on win? Did edges I took lose for predictable reasons? Was conviction calibrated (bold bets should win more than med)?
3. Update this file with what changed. Adjust CONVICTION/STRAT params in kalshi.js if the data says so (3+ settled bets minimum before touching params).
4. Update KALSHI_BANKROLL default mention + tell Anita the running P&L.

## Publishing discipline

Every strategy change gets logged in THREE places, same day:
1. This file's review log (the why, with evidence).
2. `site/stratlog.json` — append an entry (ts, title, body in plain words), then `python3 matchday.py deploy`. This is the public log on agentcup.co/how.html. Anita and anyone on the internet can audit it.
3. Git: push kalshi.js + STRATEGY.md changes to AnitaKirkovska/kalshi-cli.

No silent changes. If it's not in the public log, it didn't happen.

## Review log
- **Jun 12, 2026 (init).** Strategy written. Zero bets settled. Seeds: matchday 1 Briers. First live night: USA-PAR 9 PM ET.
- **Jun 12, 2026 (post USA-PAR lock).** First live night produced NO bet and NO record of why: the lock run evaluated nothing into the ledger. Flat probs (38/32/30) make a clean skip plausible, but plausible isn't logged. Fix shipped: `blend` now persists EVERY evaluation (bet or skip, with edge + reason) into `betledger.json` under `decisions`. Rule going forward: a lock without a logged bet decision is a pipeline failure, not a skip.
