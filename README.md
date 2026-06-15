# 🎲 kalshi-cli

A tiny, zero-dependency CLI for reading live odds and placing trades on [Kalshi](https://kalshi.com) prediction markets. Works across **every** Kalshi category, sports ⚽, Fed decisions 🏦, elections 🗳️, weather 🌦️, anything. No `npm install`, no SDK, no fuss. Node's built-in `crypto` signs every request natively.

The headline trick: it pulls the market's **de-vigged implied probabilities** for any event, so you can line them up against your own model and bet only when you have an edge. 📈

## ⚡ Quick start

```bash
# 📊 any event, de-vigged probabilities, no auth needed:
KALSHI_ENV=prod node kalshi.js event KXPRESPARTY-2028
KALSHI_ENV=prod node kalshi.js event KXHIGHNY-26JUN12

# 🔍 browse + inspect:
KALSHI_ENV=prod node kalshi.js markets --series KXPRESPARTY --limit 20
KALSHI_ENV=prod node kalshi.js orderbook KXPRESPARTY-2028-DEM

# 🔐 authenticated (needs a Kalshi API key):
node kalshi.js balance
node kalshi.js bet KXPRESPARTY-2028-DEM yes 10 47
```

`event` reads each outcome's order book and prints clean, de-vigged probabilities:

```
2028 Presidential Election winner? (Party)
  Democratic party    mid  59c   bid  58c / ask  59c
  Republican party    mid  42c   bid  41c / ask  42c

  market implied probabilities (de-vigged):
  Democratic party    58.5%
  Republican party    41.5%
```

## 🪤 The three things that will trip you up

### 1️⃣ The API moved hosts
The old `trading-api.kalshi.com` is dead. It just tells you to migrate.
- **Market data (read):** `https://api.elections.kalshi.com/trade-api/v2` — markets, events, series, order books. No auth.
- **Trading (auth):** `external-api.demo.kalshi.co` (demo) / prod host. `KALSHI_ENV` switches it.

### 2️⃣ Prices are NOT in the summary fields 🫥
The big one. `yes_bid`, `yes_ask`, `last_price`, `volume` all come back **null** on the `/markets` endpoints. Looks like an empty book. It isn't.

Real prices live in the **order book**: `GET /markets/{ticker}/orderbook`. The trick:

> **best YES ask = 1 − (best NO bid)** — because buying YES is the same as selling NO.

The `event` and `odds` commands do this math for you.

### 3️⃣ Books open near event time ⏰
Liquidity is thin until an event is close or live. A market can sit `active` for days with an empty book, then fill within hours. A *live* event with a close finish showed ~$24M volume with deep two-sided books. Empty book ≠ bug.

## 🔑 Auth

Kalshi signs with an **RSA private key**, not a bearer token.

1. Generate a key in the Kalshi UI: **Account → API Keys**. You get a **key ID** + a downloadable **private key `.pem`** (shown once 👀).
2. Set env vars:
   - `KALSHI_KEY_ID` — the key id
   - `KALSHI_KEY_PATH` — path to the `.pem` (🚫 never commit it)
   - `KALSHI_ENV` — `demo` (default, fake money 🪙) or `prod` (real 💵)

Each request signs `timestamp_ms + METHOD + path` with **RSA-PSS / SHA256**, base64, sent via three headers (`KALSHI-ACCESS-KEY`, `-TIMESTAMP`, `-SIGNATURE`). The CLI handles every bit of it.

> 🧪 **Always test against demo first.** Demo and prod are separate accounts with separate keys.

## 🎮 Commands

| command | what it does |
|---|---|
| `event <EVENT_TICKER>` | 🎯 de-vigged probabilities for **any** event (the workhorse) |
| `odds <A> <B> --series <S> [--date YYMMMDD]` | 🎯 head-to-head shortcut within a series |
| `markets [--series S] [--status open] [--limit N]` | 📋 list markets in a series |
| `market <TICKER>` / `orderbook <TICKER>` | 🔍 raw market / order book JSON |
| `balance` / `positions` / `orders` | 💰 account state (auth) |
| `bet <TICKER> <yes\|no> <count> <price_cents>` | 🎲 place an order (auth, price 1–99¢) |
| `cancel <ORDER_ID>` | ❌ cancel a resting order (auth) |

## 🧭 Finding tickers

Everything on Kalshi nests as **series → event → markets**:

- **Series** = a recurring template (`KXPRESPARTY`, `KXHIGHNY`, `KXFED`). List them: `GET /series?category=Politics` (or `Sports`, `Economics`, `Climate`…).
- **Event** = one instance (`KXPRESPARTY-2028`, `KXHIGHNY-26JUN12`). Feed this to `event`.
- **Market** = one yes/no outcome inside an event (`...-USA`, `...-DEM`). This is what you `bet` on.

Browse the live UI at [kalshi.com](https://kalshi.com) and the URL slugs map straight to these tickers.

## 🧮 What "de-vigging" means

The outcome prices in an event sum to **more** than 100% (that's the house edge, the vig). Normalize each by the total and you get the market's *true* implied probability. Compare that to your model's number. Bet the side where you're higher. 🟢

## 📐 Betting discipline

1. Run `event` (or `odds`) before locking any view.
2. Bet only when your probability clears the market's by a real margin (edge, not noise).
3. Demo first. Always. 🧪

---

MIT.
