#!/usr/bin/env node
/*
 * kalshi.js — tiny CLI for the Kalshi trading API (demo by default).
 *
 * Auth: API key ID + RSA private key. Signs (timestamp + METHOD + path)
 * with RSA-PSS / SHA256, base64. No password ever touches the wire.
 *
 * Env:
 *   KALSHI_ENV       "demo" (default) | "prod"
 *   KALSHI_KEY_ID    API key id (uuid)
 *   KALSHI_KEY_PATH  path to the RSA private key .pem/.key file
 *
 * Usage:
 *   node kalshi.js balance
 *   node kalshi.js markets [--series KXWORLDCUP] [--status open] [--limit 50]
 *   node kalshi.js market <TICKER>
 *   node kalshi.js orderbook <TICKER>
 *   node kalshi.js positions
 *   node kalshi.js orders
 *   node kalshi.js bet <TICKER> <yes|no> <count> <price_cents> [--type limit|market]
 *   node kalshi.js cancel <ORDER_ID>
 */
const crypto = require("crypto");
const fs = require("fs");

const ENV = process.env.KALSHI_ENV || "demo";
const BASE = ENV === "prod"
  ? "https://external-api.kalshi.com/trade-api/v2"
  : "https://external-api.demo.kalshi.co/trade-api/v2";
const ROOT_PREFIX = "/trade-api/v2";

const KEY_ID = process.env.KALSHI_KEY_ID;
const KEY_PATH = process.env.KALSHI_KEY_PATH;

function loadKey() {
  if (!KEY_PATH || !fs.existsSync(KEY_PATH)) {
    throw new Error(`private key not found at KALSHI_KEY_PATH=${KEY_PATH}`);
  }
  return crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
}

function sign(key, ts, method, fullPath) {
  // sign the path from API root, no query string
  const pathNoQuery = fullPath.split("?")[0];
  const msg = `${ts}${method}${pathNoQuery}`;
  const sig = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

async function req(method, path, body) {
  const ts = Date.now().toString();
  const signPath = ROOT_PREFIX + path;            // e.g. /trade-api/v2/portfolio/balance
  const headers = { "Content-Type": "application/json" };
  if (KEY_ID && KEY_PATH) {
    const key = loadKey();
    headers["KALSHI-ACCESS-KEY"] = KEY_ID;
    headers["KALSHI-ACCESS-TIMESTAMP"] = ts;
    headers["KALSHI-ACCESS-SIGNATURE"] = sign(key, ts, method, signPath);
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { out[args[i].slice(2)] = args[i + 1]; i++; }
    else out._.push(args[i]);
  }
  return out;
}

// Read live order-book price for one market. The summary fields (yes_bid/ask)
// are deprecated and return null; real prices live in the orderbook.
// yes_dollars = resting bids to buy YES, no_dollars = bids to buy NO.
// Best YES ask = 1 - best NO bid (buying YES == selling NO).
async function priceOf(ticker) {
  const ob = (await req("GET", `/markets/${ticker}/orderbook`)).orderbook_fp || {};
  const yes = ob.yes_dollars || [], no = ob.no_dollars || [];
  const bid = yes.length ? parseFloat(yes[yes.length - 1][0]) : null;
  const noBid = no.length ? parseFloat(no[no.length - 1][0]) : null;
  const ask = noBid != null ? 1 - noBid : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
  return { bid, ask, mid };
}

// ---- Position sizing: fractional Kelly with guardrails -------------------
// Binary contract: buy YES at price p (dollars, 0-1), pays $1 if it hits.
// Full Kelly fraction of bankroll: f* = (q - p) / (1 - p)  where q = our prob.
// We bet a FRACTION of that (default quarter-Kelly) and clamp it hard.
const STRAT = {
  bankroll: parseFloat(process.env.KALSHI_BANKROLL || "985"), // $ total — live settled basis (updated nightly from real balance). $985.32 prod balance after Jun 14 settlements, ignoring the still-open IRI stake.
  minEdge: 0.05,         // need 5+ pts of edge vs market or we don't bet at all
  minBet: 5,             // below $5 it's not worth the slippage
};

// Conviction dial: how hard I press when I feel good about one.
// Each tier sets the Kelly fraction AND the caps. "bold" loosens both so a
// high-conviction play can actually move the needle. This is the "spend more
// on the ones you're comfortable with / make bold bets" knob.
const CONVICTION = {
  low:  { kelly: 0.15, maxFrac: 0.03, maxBet: 50 },   // toe in the water
  med:  { kelly: 0.25, maxFrac: 0.05, maxBet: 100 },  // default, quarter-Kelly
  high: { kelly: 0.40, maxFrac: 0.08, maxBet: 160 },  // I like this one
  bold: { kelly: 0.60, maxFrac: 0.12, maxBet: 250 },  // swing
};

// AgentCup calibration board (lower Brier = sharper caller). Updated as
// matchdays settle. Used to weight an ensemble probability — we trust the
// models that have been calling it better, not a flat average.
const MODELS = {
  grok:   { brier: 0.372 },
  ava:    { brier: 0.387 },
  opus:   { brier: 0.387 },  // Claude seat: Fable 5 (MD1-2) -> Opus 4.8 from Jun 13, OpenRouter dropped Fable
  gpt:    { brier: 0.407 },
  gemini: { brier: 0.419 },
};

// Inverse-Brier-squared blend: a sharp model gets exponentially more say.
// probs = { ava: 0.55, grok: 0.50, ... } for the SAME outcome.
function blendProb(probs) {
  const live = liveBrier();   // ledger-updated weights, seeds until bets settle
  let wsum = 0, psum = 0; const parts = [];
  for (const [m, p] of Object.entries(probs)) {
    const brier = live[m]?.brier ?? MODELS[m]?.brier ?? 0.40;
    const w = 1 / (brier * brier);
    wsum += w; psum += w * p;
    parts.push({ m, p, w });
  }
  const q = psum / wsum;
  for (const x of parts) x.share = x.w / wsum; // normalized trust weight
  return { q, parts };
}

// ---- Bet ledger: every bet recorded, every settlement updates trust ------
// betledger.json lives next to this file. Each entry: ticker, side, contracts,
// price, our blended prob, per-model probs, conviction, outcome (null until
// settled). Settled entries feed recalibration: each model's live Brier is
// recomputed from its actual betting calls, and those weights override the
// static AgentCup seeds in MODELS. The system gets sharper as it settles.
const LEDGER_PATH = require("path").join(__dirname, "betledger.json");
function loadLedger() {
  try { return JSON.parse(require("fs").readFileSync(LEDGER_PATH, "utf8")); }
  catch { return { bets: [] }; }
}
function saveLedger(l) { require("fs").writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2)); }

// Kalshi trading fee, charged on entry only (settlement is free):
//   fee = 0.07 * contracts * price * (1 - price), kept to sub-cent precision.
// Verified against the book: 100 @ 0.28 -> 0.07*100*0.28*0.72 = $1.4112 (book charged 1.4112).
// This is only an estimate for pre-settle display; bank.json reports the REAL fee
// straight from the position endpoint (fees_paid_dollars) when a position is live.
function kalshiFee(contracts, price) {
  return +(0.07 * contracts * price * (1 - price)).toFixed(2);
}

// Live recalibration: Brier from settled ledger bets, blended with the
// AgentCup seed so one fluke doesn't whipsaw the weights early on.
function liveBrier() {
  const l = loadLedger();
  const settled = l.bets.filter(b => b.outcome != null && b.modelProbs);
  const acc = {};
  for (const b of settled) {
    const y = b.outcome ? 1 : 0;
    for (const [m, p] of Object.entries(b.modelProbs)) {
      (acc[m] = acc[m] || []).push((p - y) ** 2);
    }
  }
  const out = {};
  for (const m of Object.keys(MODELS)) {
    const seed = MODELS[m].brier;
    const obs = acc[m];
    if (!obs || !obs.length) { out[m] = { brier: seed, n: 0 }; continue; }
    const live = obs.reduce((a, x) => a + x, 0) / obs.length;
    // weight live evidence by sample size: n/(n+4) live, rest seed
    const k = obs.length / (obs.length + 4);
    out[m] = { brier: +(k * live + (1 - k) * seed).toFixed(3), n: obs.length };
  }
  return out;
}

function sizeBet({ q, p, bankroll = STRAT.bankroll, conviction = "med" }) {
  const c = CONVICTION[conviction] || CONVICTION.med;
  const edge = q - p;                       // our prob minus market price
  if (edge < STRAT.minEdge) {
    return { stake: 0, contracts: 0, edge, conviction, reason: `edge ${(edge*100).toFixed(1)}pts < ${STRAT.minEdge*100}pt threshold` };
  }
  const fullKelly = (q - p) / (1 - p);      // optimal growth fraction
  const frac = Math.max(0, fullKelly) * c.kelly;
  let stake = bankroll * frac;
  const capFrac = bankroll * c.maxFrac;
  let cap = `${conviction} kelly`;
  if (stake > capFrac) { stake = capFrac; cap = `${(c.maxFrac*100).toFixed(0)}% bankroll (${conviction})`; }
  if (stake > c.maxBet) { stake = c.maxBet; cap = `$${c.maxBet} cap (${conviction})`; }
  if (stake < STRAT.minBet) {
    return { stake: 0, contracts: 0, edge, conviction, reason: `sized $${stake.toFixed(2)} < $${STRAT.minBet} min` };
  }
  const contracts = Math.floor(stake / p); // each YES contract costs $p
  return { stake: contracts * p, contracts, edge, fullKelly, frac, cap, conviction };
}

// De-vig a group of mutually-exclusive markets into normalized probabilities.
// Works for ANY Kalshi event: sports, Fed decisions, elections, weather, etc.
async function showImplied(markets, labelOf) {
  const c = (x) => x != null ? (Math.round(x * 100) + "c").padStart(4) : "  - ";
  const rows = [];
  for (const m of markets) {
    const p = await priceOf(m.ticker);
    const label = labelOf ? labelOf(m) : (m.yes_sub_title || m.ticker.split("-").pop());
    rows.push({ label, mid: p.mid });
    console.log(`  ${String(label).padEnd(24)} mid ${c(p.mid)}   bid ${c(p.bid)} / ask ${c(p.ask)}`);
  }
  const sum = rows.reduce((s, x) => s + (x.mid || 0), 0);
  if (sum > 0) {
    console.log(`\n  market implied probabilities (de-vigged):`);
    rows.forEach((x) => console.log(`  ${String(x.label).padEnd(24)} ${(100 * (x.mid || 0) / sum).toFixed(1)}%`));
  } else {
    console.log(`\n  no live pricing yet (book not open)`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const j = (x) => console.log(JSON.stringify(x, null, 2));

  switch (cmd) {
    case "balance": {
      const d = await req("GET", "/portfolio/balance");
      console.log(`[${ENV}] balance: $${(d.balance / 100).toFixed(2)}`);
      break;
    }
    case "markets": {
      const q = new URLSearchParams();
      if (f.series) q.set("series_ticker", f.series);
      if (f.status) q.set("status", f.status);
      q.set("limit", f.limit || "50");
      const d = await req("GET", "/markets?" + q.toString());
      (d.markets || []).forEach((m) =>
        console.log(`${m.ticker.padEnd(28)} ${String(m.yes_bid ?? "-").padStart(3)}/${String(m.yes_ask ?? "-").padEnd(3)}  ${m.title}`)
      );
      console.log(`\n${(d.markets || []).length} markets`);
      break;
    }
    case "event": {
      // event <EVENT_TICKER>  — de-vigged implied probabilities for ANY Kalshi event.
      // Works across every category: sports, Fed, elections, weather, etc.
      // e.g. node kalshi.js event KXWCGAME-26JUN12USAPAR
      //      node kalshi.js event KXPRESPARTY-2028
      const et = f._[0];
      if (!et) throw new Error("usage: event <EVENT_TICKER>");
      const d = await req("GET", `/events/${et}?with_nested_markets=true`);
      const ev = d.event || {};
      const ms = ev.markets || [];
      if (!ms.length) { console.log(`no markets in event ${et}`); break; }
      console.log(`\n${ev.title || et}`);
      await showImplied(ms);
      break;
    }
    case "resolve": {
      // resolve <CODE_A> <CODE_B> [--date YYMMMDD] [--series KXWCGAME]
      // Machine-readable sibling of `odds`: emits JSON mapping each outcome
      // (codeA / codeB / TIE) to its ticker + live ask, so the matchday
      // pipeline can pick the right market to evaluate. Outputs JSON only.
      const series = f.series || "KXWCGAME";
      const [a, b] = f._.map((s) => s.toUpperCase());
      const d = await req("GET", `/markets?series_ticker=${series}&status=open&limit=500`);
      const ms = (d.markets || []).filter((m) =>
        (m.ticker.includes(a + b) || m.ticker.includes(b + a)) &&
        (!f.date || m.ticker.includes(f.date.toUpperCase()))
      );
      const out = { match: `${a}/${b}`, outcomes: {} };
      for (const m of ms) {
        const code = m.ticker.split("-").pop();          // e.g. BRA / MAR / TIE
        const pr = await priceOf(m.ticker);
        out.outcomes[code] = { ticker: m.ticker, ask: pr.ask, bid: pr.bid };
      }
      console.log(JSON.stringify(out));
      break;
    }
    case "odds": {
      // odds <CODE_A> <CODE_B> [--date YYMMMDD] [--series KXWCGAME]
      // Convenience wrapper for World Cup head-to-heads. For anything else use `event`.
      const series = f.series || "KXWCGAME";
      const [a, b] = f._.map((s) => s.toUpperCase());
      const d = await req("GET", `/markets?series_ticker=${series}&status=open&limit=500`);
      const ms = (d.markets || []).filter((m) =>
        (m.ticker.includes(a + b) || m.ticker.includes(b + a)) &&
        (!f.date || m.ticker.includes(f.date.toUpperCase()))
      );
      if (!ms.length) { console.log(`no ${series} market for ${a}/${b}` + (f.date ? ` on ${f.date}` : "")); break; }
      console.log(`\n${ms[0].title}`);
      await showImplied(ms, (m) => m.ticker.split("-").pop());
      break;
    }
    case "size": {
      // size <MARKET_TICKER> <my_prob 0-1> [--bankroll 1000]
      // Pulls the live ask, compares to our probability, recommends a stake.
      // e.g. node kalshi.js size KXWCGAME-26JUN12USAPAR-USA 0.55
      const ticker = f._[0];
      const q = parseFloat(f._[1]);
      if (!ticker || isNaN(q)) throw new Error("usage: size <MARKET_TICKER> <my_prob 0-1> [--bankroll N]");
      const bankroll = f.bankroll ? parseFloat(f.bankroll) : STRAT.bankroll;
      const conviction = f.conviction || "med";
      const pr = await priceOf(ticker);
      const p = pr.ask;  // we'd pay the ask to buy YES
      if (p == null) { console.log(`no live ask on ${ticker} (book not open)`); break; }
      const r = sizeBet({ q, p, bankroll, conviction });
      console.log(`\n${ticker}  [conviction: ${conviction}]`);
      console.log(`  our prob:     ${(q*100).toFixed(1)}%`);
      console.log(`  market ask:   ${(p*100).toFixed(0)}c  (implied ${(p*100).toFixed(1)}%)`);
      console.log(`  edge:         ${(r.edge*100).toFixed(1)} pts`);
      if (r.contracts > 0) {
        console.log(`\n  ✅ BET: ${r.contracts} contracts @ ${(p*100).toFixed(0)}c  =  $${r.stake.toFixed(2)}`);
        console.log(`     (${(r.frac*100).toFixed(1)}% of $${bankroll} bankroll, capped by ${r.cap})`);
        console.log(`     win → +$${(r.contracts*(1-p)).toFixed(2)}   lose → -$${r.stake.toFixed(2)}`);
        console.log(`\n  place: node kalshi.js bet ${ticker} yes ${r.contracts} ${Math.round(p*100)}`);
      } else {
        console.log(`\n  ⛔ NO BET: ${r.reason}`);
      }
      break;
    }
    case "blend": {
      // blend <MARKET_TICKER> --ava 0.55 --grok 0.50 --fable 0.52 [--conviction high]
      // Ensemble probability weighted by AgentCup Brier scores (sharper model =
      // more say), then sized. This is the "trust the models that have been
      // calling it better" knob.
      const ticker = f._[0];
      if (!ticker) throw new Error("usage: blend <MARKET_TICKER> --ava 0.55 --grok 0.50 ... [--conviction med]");
      const probs = {};
      for (const m of Object.keys(MODELS)) if (f[m] != null) probs[m] = parseFloat(f[m]);
      if (!Object.keys(probs).length) throw new Error("give at least one model prob, e.g. --ava 0.55");
      const { q, parts } = blendProb(probs);
      console.log(`\nensemble for ${ticker}:`);
      for (const x of parts.sort((a,b) => b.share - a.share))
        console.log(`  ${x.m.padEnd(7)} ${(x.p*100).toFixed(0).padStart(3)}%  (trust ${(x.share*100).toFixed(0)}%, brier ${MODELS[x.m].brier})`);
      console.log(`  → blended prob: ${(q*100).toFixed(1)}%`);
      // hand off to sizing against the live ask
      const conviction = f.conviction || "med";
      const bankroll = f.bankroll ? parseFloat(f.bankroll) : STRAT.bankroll;
      const pr = await priceOf(ticker);
      if (pr.ask == null) { console.log(`\nno live ask on ${ticker} (book not open)`); break; }
      const r = sizeBet({ q, p: pr.ask, bankroll, conviction });
      console.log(`\n  market ask:   ${(pr.ask*100).toFixed(0)}c   edge: ${(r.edge*100).toFixed(1)} pts   [conviction: ${conviction}]`);
      if (r.contracts > 0) {
        console.log(`  ✅ BET: ${r.contracts} @ ${(pr.ask*100).toFixed(0)}c = $${r.stake.toFixed(2)}  (capped by ${r.cap})`);
        console.log(`     win → +$${(r.contracts*(1-pr.ask)).toFixed(2)}   lose → -$${r.stake.toFixed(2)}`);
        console.log(`\n  place: node kalshi.js bet ${ticker} yes ${r.contracts} ${Math.round(pr.ask*100)}`);
      } else {
        console.log(`  ⛔ NO BET: ${r.reason}`);
      }
      // Persist EVERY evaluation (bet or skip) so no decision is silent.
      {
        const l = loadLedger();
        if (!l.decisions) l.decisions = [];
        l.decisions.push({
          ts: new Date().toISOString(), ticker, q: +q.toFixed(4),
          ask: pr.ask, edge: +r.edge.toFixed(4), conviction,
          decision: r.contracts > 0 ? "bet" : "skip",
          contracts: r.contracts || 0, stake: r.stake || 0,
          reason: r.contracts > 0 ? null : r.reason,
        });
        saveLedger(l);
      }
      break;
    }
    case "log": {
      // log <MARKET_TICKER> <side> <contracts> <price_cents> --q 0.55 [--ava 0.55 --grok 0.50 ...] [--conviction high] [--note "..."]
      // Record a placed bet in the ledger. Per-model probs power recalibration.
      const [ticker, side, n, cents] = f._;
      if (!ticker || !side || !n || !cents) throw new Error("usage: log <ticker> <yes|no> <contracts> <price_cents> --q 0.55 [--ava ... --grok ...]");
      const modelProbs = {};
      for (const m of Object.keys(MODELS)) if (f[m] != null) modelProbs[m] = parseFloat(f[m]);
      const l = loadLedger();
      l.bets.push({
        id: l.bets.length + 1, ts: new Date().toISOString(), ticker, side,
        contracts: +n, price: +cents / 100, stake: +(+n * +cents / 100).toFixed(2),
        fee: kalshiFee(+n, +cents / 100),
        q: f.q ? parseFloat(f.q) : null,
        modelProbs: Object.keys(modelProbs).length ? modelProbs : null,
        conviction: f.conviction || "med", note: f.note || null, outcome: null,
      });
      saveLedger(l);
      console.log(`logged bet #${l.bets.length}: ${side.toUpperCase()} ${n}x ${ticker} @ ${cents}c ($${(+n * +cents / 100).toFixed(2)})`);
      break;
    }
    case "settle": {
      // settle <bet_id> <won|lost>
      const [id, res] = f._;
      if (!id || !["won", "lost"].includes(res)) throw new Error("usage: settle <bet_id> <won|lost>");
      const l = loadLedger();
      const b = l.bets.find(x => x.id === +id);
      if (!b) throw new Error(`no bet #${id}`);
      b.outcome = res === "won";
      // Honest P&L nets the Kalshi entry fee. Win: gross profit minus fee.
      // Loss: stake plus the fee already paid. (Settlement itself is fee-free.)
      const fee = b.fee != null ? b.fee : kalshiFee(b.contracts, b.price);
      b.fee = fee;
      b.pnl = b.outcome
        ? +(b.contracts * (1 - b.price) - fee).toFixed(2)
        : +(-b.stake - fee).toFixed(2);
      saveLedger(l);
      console.log(`bet #${id} ${res}: ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(2)} (fee $${fee.toFixed(2)})`);
      break;
    }
    case "bank": {
      // bank — JSON snapshot for the site: live balance, open positions, ledger P&L
      const [bal, pos] = await Promise.all([
        req("GET", "/portfolio/balance"),
        req("GET", "/portfolio/positions"),
      ]);
      const l = loadLedger();
      let pnl = 0, settledN = 0, wins = 0;
      // Only TRUE/FALSE outcomes are settled win/loss. A string like "exited" means
      // the position was closed early (e.g. swapped for coherence) — it is NOT a
      // settled win and its realized pnl (if any) is tracked separately, so skip it
      // from the W/L + P&L tally to avoid the truthy-string miscount.
      for (const b of l.bets) {
        if (b.outcome !== true && b.outcome !== false) continue;
        pnl += (b.pnl || 0); settledN++; if (b.outcome === true) wins++;
      }
      // Kalshi renamed position fields to dollar-strings (market_exposure_dollars, position_fp).
      // Read the new names first, fall back to the legacy cents fields for safety.
      const posContracts = p => p.position_fp != null ? parseFloat(p.position_fp) : (p.position ?? 0);
      const posExposure = p => p.market_exposure_dollars != null
        ? Math.abs(parseFloat(p.market_exposure_dollars))
        : Math.abs((p.market_exposure ?? p.total_traded ?? 0) / 100);
      const posFee = p => p.fees_paid_dollars != null ? Math.abs(parseFloat(p.fees_paid_dollars)) : 0;
      const totalFees = +(pos.market_positions || []).reduce((a, p) => a + posFee(p), 0).toFixed(2);
      const positions = (pos.market_positions || [])
        .filter(p => posContracts(p) !== 0)
        .map(p => ({
          ticker: p.ticker,
          contracts: posContracts(p),
          exposure: +posExposure(p).toFixed(2),
        }));
      const out = {
        ts: Date.now(),
        balance: +(bal.balance / 100).toFixed(2),
        invested: +positions.reduce((a, p) => a + p.exposure, 0).toFixed(2),
        fees: totalFees,
        positions,
        bets: l.bets.map(b => ({
          ticker: b.ticker, side: b.side, contracts: b.contracts,
          price: b.price, stake: b.stake, conviction: b.conviction,
          outcome: b.outcome, pnl: b.pnl ?? null, ts: b.ts, note: b.note,
        })),
        settled: settledN, wins, pnl: +pnl.toFixed(2),
      };
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case "ledger": {
      // ledger — P&L summary + current model trust weights
      const l = loadLedger();
      if (!l.bets.length) { console.log("ledger empty, no bets yet"); break; }
      let pnl = 0, staked = 0, w = 0, n = 0;
      console.log("");
      for (const b of l.bets) {
        const bPnl = typeof b.pnl === "number" ? b.pnl : null;
        const status =
          b.outcome == null            ? "⏳ open" :
          b.outcome === "exited"       ? `↩️  exited  $${bPnl == null ? "0.00" : bPnl.toFixed(2)}` :
          b.outcome                    ? `✅  +$${bPnl.toFixed(2)}` :
                                         `❌  -$${Math.abs(bPnl ?? b.stake).toFixed(2)}`;
        console.log(`  #${b.id}  ${b.ticker}  ${b.side.toUpperCase()} ${b.contracts}x @ ${(b.price*100).toFixed(0)}c  $${b.stake.toFixed(2)}  [${b.conviction}]  ${status}`);
        staked += b.stake;
        if (b.outcome != null && b.outcome !== "exited") { pnl += b.pnl; n++; if (b.outcome) w++; }
        else if (b.outcome === "exited") n++;
      }
      console.log(`\n  ${l.bets.length} bets, $${staked.toFixed(2)} staked | settled ${n} (${w}W-${n-w}L) | P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      const live = liveBrier();
      console.log(`\n  model trust (live brier, settled bets):`);
      for (const [m, v] of Object.entries(live).sort((a,b) => a[1].brier - b[1].brier))
        console.log(`    ${m.padEnd(7)} ${v.brier}  (${v.n} settled)`);
      break;
    }
    case "market":   j(await req("GET", `/markets/${f._[0]}`)); break;
    case "orderbook":j(await req("GET", `/markets/${f._[0]}/orderbook`)); break;
    case "positions":j(await req("GET", "/portfolio/positions")); break;
    case "orders":   j(await req("GET", "/portfolio/orders")); break;
    case "bet": {
      const [ticker, side, count, price] = f._;
      if (!ticker || !side || !count) throw new Error("usage: bet <TICKER> <yes|no> <count> <price_cents> [--type limit|market] [--action buy|sell]");
      const order = {
        ticker,
        action: f.action || "buy",     // "buy" to open, "sell" to close/exit a held position
        side,                          // "yes" | "no"
        count: parseInt(count, 10),
        type: f.type || "limit",
        client_order_id: crypto.randomUUID(),
      };
      if ((f.type || "limit") === "limit") {
        if (!price) throw new Error("limit order needs a price in cents (1-99)");
        order[side === "yes" ? "yes_price" : "no_price"] = parseInt(price, 10);
      }
      j(await req("POST", "/portfolio/orders", order));
      break;
    }
    case "cancel":  j(await req("DELETE", `/portfolio/orders/${f._[0]}`)); break;
    default:
      console.log([
        "kalshi.js — read odds & trade on any Kalshi market",
        "",
        "  event <EVENT_TICKER>                  de-vigged probabilities for any event",
        "  odds <A> <B> [--date YYMMMDD]         World Cup head-to-head shortcut",
        "  markets [--series S] [--status open]  list markets in a series",
        "  market <TICKER>                       raw market JSON",
        "  orderbook <TICKER>                    raw order book",
        "  balance | positions | orders          account state (auth)",
        "  bet <TICKER> <yes|no> <count> <cents> place an order (auth)",
        "  cancel <ORDER_ID>                     cancel a resting order (auth)",
        "",
        "  env: KALSHI_ENV=demo|prod  KALSHI_KEY_ID=...  KALSHI_KEY_PATH=...",
      ].join("\n"));
  }
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
