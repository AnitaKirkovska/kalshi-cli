---
name: "Kalshi Betting"
description: "Read live odds and place trades on any Kalshi prediction market (sports, Fed, elections, weather) via a signed CLI. Covers RSA-PSS auth, the moved API host, where real prices actually live (the orderbook, not the deprecated summary fields), and de-vigging market prices into clean probabilities."
metadata:
  vellum:
    emoji: 🎲
---

# Kalshi Betting

Read live odds and place trades on [Kalshi](https://kalshi.com) (US-legal, CFTC-regulated event markets) through a small signed CLI. Works across **every** Kalshi category — sports, Fed decisions, elections, weather, anything. The headline move: pull a market's de-vigged implied probabilities for any event, line them up against your own model, and bet only when you have an edge.

The CLI lives next to this skill: **`kalshi.js`** (Node, no external deps). Node's `crypto` signs RSA-PSS natively, so there's nothing to install. The Python `cryptography` module is NOT available in the sandbox and there's no `pip`, so always use the Node tool. All network calls run through the proxy (`network_mode: "proxied"` on the bash tool).

## Quick start

```bash
# any event, de-vigged probabilities, no auth needed:
KALSHI_ENV=prod node kalshi.js event KXPRESPARTY-2028
KALSHI_ENV=prod node kalshi.js event KXWCGAME-26JUN12USAPAR

# browse + inspect:
KALSHI_ENV=prod node kalshi.js markets --series KXWCGAME --limit 20
KALSHI_ENV=prod node kalshi.js orderbook KXPRESPARTY-2028-DEM

# authenticated (needs a key, see Auth):
node kalshi.js balance
node kalshi.js bet KXWCGAME-26JUN12USAPAR-USA yes 10 47
```

## The three things that will trip you up

### 1. The API moved hosts
The old `trading-api.kalshi.com` / `.co` hosts are dead. They return `"API has been moved to https://api.elections.kalshi.com/"`.

- **Market data (read):** `https://api.elections.kalshi.com/trade-api/v2` — markets, events, series, orderbooks. No auth.
- **Trading (authenticated):** `https://external-api.demo.kalshi.co/trade-api/v2` (demo) / prod host. `KALSHI_ENV` switches the trade host; the read commands hit the elections host directly.

### 2. Prices are NOT in the market summary fields
The big one. `GET /markets` and `GET /markets/{ticker}` return `yes_bid`, `yes_ask`, `last_price`, `volume` all as **null** in this API version. They look like an empty book. They are not.

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

The `event`/`odds` commands already do all of this. If you ever query prices yourself, hit the orderbook, never trust the summary fields.

### 3. Books open near event time
Kalshi liquidity is thin until an event is close or live. A market can be `status: active` for days with a genuinely empty orderbook, then fill in within hours. "Empty book" ≠ "bug." A live World Cup match showed ~$24M volume with 29-63 levels per side.

## How Kalshi is structured (series → event → market)

Everything nests three levels deep. Understanding this is how you find any ticker:

- **Series** = a recurring template. e.g. `KXWCGAME` (a World Cup game), `KXPRESPARTY` (presidential winner by party), `KXHIGHNY` (NYC high temp), `KXFED` (Fed rate decision). Discover them: `GET /series?category=Sports` (also `Politics`, `Economics`, `Climate`, `Entertainment`, ...).
- **Event** = one instance of a series. e.g. `KXWCGAME-26JUN12USAPAR`, `KXPRESPARTY-2028`. Feed this to the `event` command.
- **Market** = one yes/no outcome inside an event. e.g. `KXWCGAME-26JUN12USAPAR-USA`, `KXPRESPARTY-2028-DEM`. This is what you place a `bet` on.

Get all outcomes of an event at once: `GET /events/{event_ticker}?with_nested_markets=true`. That's what `event` uses, and it's the generic path that works for any category.

## Auth (for trading / balance / positions)

Kalshi signs with an **RSA private key**, not a bearer token.

- Generate a key in the Kalshi UI: Account → API Keys. You get a **key ID** (uuid) and download a **private key `.pem`** (shown once).
- Set env:
  - `KALSHI_KEY_ID` = the key id
  - `KALSHI_KEY_PATH` = path to the `.pem` file (store in the vault / a secrets dir, never commit it)
  - `KALSHI_ENV` = `demo` (default, fake money) or `prod` (real)
- Signing scheme (the CLI handles it): for each request, build `msg = timestamp_ms + METHOD + path` where `path` is from the API root **without** query string (e.g. `/trade-api/v2/portfolio/balance`). Sign with **RSA-PSS / SHA256**, salt length = digest length, base64. Send three headers:
  - `KALSHI-ACCESS-KEY: <key id>`
  - `KALSHI-ACCESS-TIMESTAMP: <same ms timestamp>`
  - `KALSHI-ACCESS-SIGNATURE: <base64 sig>`

Always test against **demo** first (`KALSHI_ENV=demo`). Demo and prod are separate accounts with separate keys.

## Commands

| command | what it does |
|---|---|
| `event <EVENT_TICKER>` | reads each outcome's orderbook and prints de-vigged probabilities. The workhorse, works for any category. |
| `odds <A> <B> [--date YYMMMDD] [--series KXWCGAME]` | World Cup head-to-head shortcut (resolves team codes to a `KXWCGAME` event). For anything non-WC, use `event`. |
| `markets [--series S] [--status open] [--limit N]` | list markets in a series |
| `market <TICKER>` | raw market JSON |
| `orderbook <TICKER>` | raw orderbook |
| `balance` | account balance (auth) |
| `positions` | open positions (auth) |
| `orders` | resting orders (auth) |
| `bet <TICKER> <yes\|no> <count> <price_cents> [--type limit\|market]` | place an order (auth). Price in cents 1-99. |
| `cancel <ORDER_ID>` | cancel a resting order (auth) |
| `size <TICKER> <my_prob> [--conviction low\|med\|high\|bold] [--bankroll N]` | fractional-Kelly stake recommendation vs the live ask. No bet under 5pts edge. |
| `blend <TICKER> --ava 0.55 --grok 0.50 ... [--conviction X]` | Brier-weighted ensemble of model probs (sharper model = more say), then sizes the bet. |
| `log <TICKER> <yes\|no> <count> <price_cents> --q 0.55 [--ava ... --grok ...]` | record a placed bet in `betledger.json` |
| `settle <bet_id> <won\|lost>` | settle a bet; P&L recorded, model trust weights update from real outcomes |
| `ledger` | P&L summary + current live model trust weights |

## Sizing strategy (fractional Kelly + conviction dial)

Stake = bankroll x Kelly fraction x conviction tier, hard-capped. Tiers: `low` (0.15x Kelly, 3%/$50 cap), `med` (0.25x, 5%/$100, default), `high` (0.40x, 8%/$160), `bold` (0.60x, 12%/$250). Minimum 5pts edge vs market or no bet, $5 minimum stake. Bankroll defaults to $1000, override with `KALSHI_BANKROLL` or `--bankroll`.

The ensemble (`blend`) weights each model by inverse Brier squared. After bets settle (`settle`), live Brier scores from actual outcomes blend into the seed weights (n/(n+4) shrinkage), so the system trusts whoever has actually been calling it better.

## De-vigging (why the percentages add to 100)

The outcomes of an event have prices that sum to >100% because of the spread/vig. Normalize: `prob_i = mid_i / sum(mids)`. That's the market's true implied probability for each outcome. Compare to your model's probability; bet the side where your number is higher (positive expected value).

## World Cup quick reference (2026)

- **`KXWCGAME`** — 3-way match winner. Events like `KXWCGAME-26JUN12USAPAR`; markets `-USA` / `-TIE` / `-PAR`.
- **`KXWCSCORE`** — exact correct-score binaries (`...-GER9CUW1` = Germany 9, opponent 1).
- **`KXWCSPREAD`**, **`KXWCTOTAL`**, **`KXWCTEAMH2H`** (advance-further), **`KXMENWORLDCUP`** / **`KXMWORLDCUP`** (tournament winner).

Ticker date format is `YYMMMDD` uppercase, e.g. `26JUN12`. Team codes are 3-letter (USA, PAR, CAN, BIH). The `odds USA PAR --date 26JUN12` shortcut just resolves these into an event for you.

## Betting discipline

1. Run `event` (or `odds`) before locking any view.
2. Only bet when your probability for an outcome clears the market's implied probability by a real margin (edge, not noise).
3. Markets are binary, so bet the strongest single outcome you have a read on, not long-odds combos.
4. Demo first. Always. Move to prod only once the demo flow places and settles cleanly.
