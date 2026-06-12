---
name: "Kalshi Betting"
description: "Read live odds and place trades on Kalshi prediction markets via a signed CLI. Covers RSA-PSS auth, the moved API host, where real prices actually live (the orderbook, not the deprecated summary fields), and de-vigging market prices into clean probabilities."
metadata:
  vellum:
    emoji: 🎲
---

# Kalshi Betting

Read live odds and place trades on [Kalshi](https://kalshi.com) (US-legal, CFTC-regulated event markets) through a small signed CLI. Built for the AgentCup workflow: pull the market's implied probabilities before every prediction, and bet only when our number beats the market's price.

The CLI lives next to this skill: **`kalshi.js`** (Node, no external deps). Node's `crypto` signs RSA-PSS natively, so there's nothing to install. The Python `cryptography` module is NOT available in the sandbox and there's no `pip`, so always use the Node tool.

## Quick start

```bash
# market data needs no auth:
KALSHI_ENV=prod node kalshi.js odds USA PAR --date 26JUN12
KALSHI_ENV=prod node kalshi.js markets --series KXWCGAME --limit 20

# authenticated (needs a key, see Auth):
node kalshi.js balance
node kalshi.js bet KXWCGAME-26JUN12USAPAR-USA yes 10 47
```

All network calls must run through the proxy: pass `network_mode: "proxied"` on the bash tool.

## The three things that will trip you up

### 1. The API moved hosts
The old `trading-api.kalshi.com` / `trading-api.kalshi.co` hosts are dead. They return `"API has been moved to https://api.elections.kalshi.com/"`.

- **Market data (read):** `https://api.elections.kalshi.com/trade-api/v2` — this is where markets, events, series, orderbooks live. No auth required.
- **Trading (authenticated):** the demo and prod trade hosts (`https://external-api.demo.kalshi.co/trade-api/v2` for demo, prod for real). The CLI's `KALSHI_ENV` switches the trade host; the `odds`/`markets` read commands hit the elections host directly.

### 2. Prices are NOT in the market summary fields
The big one. `GET /markets` and `GET /markets/{ticker}` return `yes_bid`, `yes_ask`, `last_price`, `volume` all as **null** in this API version. They look like an empty book. They are not. The data is fine.

**Real prices live in the orderbook:** `GET /markets/{ticker}/orderbook`. Shape:

```json
{ "orderbook_fp": {
  "yes_dollars": [["0.28","42567"], ...],   // resting bids to BUY yes, ascending
  "no_dollars":  [["0.70","567326"], ...]   // resting bids to BUY no, ascending
}}
```

- Best YES bid = highest entry in `yes_dollars` (last element).
- Best NO bid = highest entry in `no_dollars` (last element).
- **Best YES ask = 1 - (best NO bid).** (Buying YES = selling NO.)
- Mid = average of best YES bid and best YES ask.
- Public trade prints: `GET /markets/trades?ticker={t}&limit=N`.

The `odds` command already does all of this. If you ever query prices yourself, hit the orderbook, never trust the summary fields.

### 3. Books only open near match time
Kalshi soccer volume is thin. A market can be `status: active` for days with a genuinely empty orderbook, then fill in within hours of kickoff. "Empty book" ≠ "bug" once you're reading the orderbook correctly. For a live game you'll see deep two-sided books (a live World Cup match showed ~$24M volume, 29-63 levels per side).

## Auth (for trading / balance / positions)

Kalshi signs with an **RSA private key**, not a bearer token.

- Generate a key in the Kalshi UI: Account → API Keys. You get a **key ID** (uuid) and download a **private key `.pem`** (shown once).
- Set env:
  - `KALSHI_KEY_ID` = the key id
  - `KALSHI_KEY_PATH` = path to the `.pem` file (store the file in the vault / a secrets dir, never commit it)
  - `KALSHI_ENV` = `demo` (default, fake money) or `prod` (real)
- Signing scheme (the CLI handles it): for each request, build `msg = timestamp_ms + METHOD + path` where `path` is from the API root **without** query string (e.g. `/trade-api/v2/portfolio/balance`). Sign with **RSA-PSS / SHA256**, salt length = digest length, base64-encode. Send three headers:
  - `KALSHI-ACCESS-KEY: <key id>`
  - `KALSHI-ACCESS-TIMESTAMP: <same ms timestamp>`
  - `KALSHI-ACCESS-SIGNATURE: <base64 sig>`

Always test against **demo** first (`KALSHI_ENV=demo`). Demo and prod are separate accounts with separate keys.

## Commands

| command | what it does |
|---|---|
| `odds <A> <B> [--date YYMMMDD] [--series KXWCGAME]` | finds the match market, reads each outcome's orderbook, prints de-vigged win/draw/loss probabilities. The workhorse. |
| `markets [--series S] [--status open] [--limit N]` | list markets in a series |
| `market <TICKER>` | raw market JSON |
| `orderbook <TICKER>` | raw orderbook |
| `balance` | account balance (auth) |
| `positions` | open positions (auth) |
| `orders` | resting orders (auth) |
| `bet <TICKER> <yes\|no> <count> <price_cents> [--type limit\|market]` | place an order (auth). Price in cents 1-99. |
| `cancel <ORDER_ID>` | cancel a resting order (auth) |

## De-vigging (why the percentages add to 100)

A 3-way match has three YES markets (TEAM1 / TIE / TEAM2). Their mids sum to >100% because of the spread/vig. Normalize: `prob_i = mid_i / sum(mids)`. That's the market's true implied probability for each outcome. Compare that to our model's probability bar; bet the side where our number is higher (positive expected value).

## World Cup series tickers (2026)

Discover with `GET /series?category=Sports` (on the elections host). The useful ones:

- **`KXWCGAME`** — 3-way match winner. Tickers like `KXWCGAME-26JUN12USAPAR-USA` / `-TIE` / `-PAR`. This maps to our win/draw/loss bar.
- **`KXWCSCORE`** — exact correct-score binaries (`...-GER9CUW1` = Germany 9, opponent 1). Maps 1:1 to a scoreline pick.
- **`KXWCSPREAD`**, **`KXWCTOTAL`**, **`KXWCTEAMH2H`** (advance-further), **`KXMENWORLDCUP`** / **`KXMWORLDCUP`** (tournament winner).

Ticker date format is `YYMMMDD` uppercase, e.g. `26JUN12`. Team codes are 3-letter (USA, PAR, CAN, BIH).

## Betting discipline (the actual strategy)

1. Run `odds` before locking any prediction.
2. Only bet when our probability for an outcome clears the market's implied probability by a real margin (edge, not noise).
3. Bet the win/draw/loss bar (the stronger signal), not exact scorelines, since markets are binary and scorelines are long-odds.
4. Demo first. Always. Move to prod only once the demo flow places and settles cleanly.
