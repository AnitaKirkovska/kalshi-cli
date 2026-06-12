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
    case "odds": {
      // odds <TEAM1CODE> <TEAM2CODE> [--date YYMMMDD] [--series KXWCGAME]
      // e.g. node kalshi.js odds USA PAR --date 26JUN12
      const series = f.series || "KXWCGAME";
      const [a, b] = f._.map((s) => s.toUpperCase());
      const d = await req("GET", `/markets?series_ticker=${series}&status=open&limit=500`);
      const ms = (d.markets || []).filter((m) =>
        m.ticker.includes(a + b) || m.ticker.includes(b + a)
      ).filter((m) => !f.date || m.ticker.includes(f.date.toUpperCase()));
      if (!ms.length) { console.log(`no ${series} market for ${a}/${b}` + (f.date ? ` on ${f.date}` : "")); break; }
      console.log(`\n${ms[0].title}`);
      // Real prices live in the orderbook, not the summary fields (Kalshi deprecated yes_bid/ask here).
      // yes_dollars = bids to buy YES; no_dollars = bids to buy NO. Best YES ask = 1 - best NO bid.
      const implied = [];
      for (const m of ms) {
        const ob = (await req("GET", `/markets/${m.ticker}/orderbook`)).orderbook_fp || {};
        const yes = ob.yes_dollars || [], no = ob.no_dollars || [];
        const bestYesBid = yes.length ? parseFloat(yes[yes.length - 1][0]) : null;       // highest someone pays for YES
        const bestNoBid = no.length ? parseFloat(no[no.length - 1][0]) : null;            // highest someone pays for NO
        const bestYesAsk = bestNoBid != null ? 1 - bestNoBid : null;                      // cheapest YES you can buy
        const mid = bestYesBid != null && bestYesAsk != null ? (bestYesBid + bestYesAsk) / 2
                  : (bestYesBid ?? bestYesAsk);
        const out = m.ticker.split("-").pop();
        implied.push({ out, mid });
        const c = (x) => x != null ? (Math.round(x * 100) + "c").padStart(4) : "  - ";
        console.log(`  ${out.padEnd(5)} mid ${c(mid)}   bid ${c(bestYesBid)} / ask ${c(bestYesAsk)}`);
      }
      const sum = implied.reduce((s, x) => s + (x.mid || 0), 0);
      if (sum > 0) {
        console.log(`\n  market implied probabilities (de-vigged):`);
        implied.forEach((x) => console.log(`  ${x.out.padEnd(5)} ${(100 * (x.mid || 0) / sum).toFixed(1)}%`));
      } else {
        console.log(`\n  no live pricing yet (book not open)`);
      }
      break;
    }
    case "market":   j(await req("GET", `/markets/${f._[0]}`)); break;
    case "orderbook":j(await req("GET", `/markets/${f._[0]}/orderbook`)); break;
    case "positions":j(await req("GET", "/portfolio/positions")); break;
    case "orders":   j(await req("GET", "/portfolio/orders")); break;
    case "bet": {
      const [ticker, side, count, price] = f._;
      if (!ticker || !side || !count) throw new Error("usage: bet <TICKER> <yes|no> <count> <price_cents> [--type limit|market]");
      const order = {
        ticker,
        action: "buy",
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
      console.log("commands: balance | markets | market <T> | orderbook <T> | positions | orders | bet <T> <yes|no> <count> <price> | cancel <id>");
  }
}

main().catch((e) => { console.error("error:", e.message); process.exit(1); });
