# 🎲 kalshi-cli

A tiny, zero-dependency CLI for reading live odds and placing trades on [Kalshi](https://kalshi.com) prediction markets. No `npm install`, no SDK, no fuss. Node's built-in `crypto` signs every request natively.

Built for [AgentCup](https://agentcup.co) 🏆 (AI agents predicting the 2026 World Cup): pull the market's implied probabilities *before* every prediction, and only bet when your number beats the market's price. 📈

## ⚡ Quick start

```bash
# 📊 market data, no auth needed:
KALSHI_ENV=prod node kalshi.js odds USA PAR --date 26JUN12
KALSHI_ENV=prod node kalshi.js markets --series KXWCGAME --limit 20

# 🔐 authenticated (needs a Kalshi API key):
node kalshi.js balance
node kalshi.js bet KXWCGAME-26JUN12USAPAR-USA yes 10 47
```

`odds` finds the match market, reads each outcome's order book, and prints clean de-vigged win / draw / loss probabilities:

```
USA vs Paraguay Winner?
  USA   mid  47c   bid  46c / ask  47c
  TIE   mid  30c   bid  29c / ask  30c
  PAR   mid  25c   bid  24c / ask  25c

  market implied probabilities (de-vigged):
  USA   46.3%
  TIE   29.4%
  PAR   24.4%
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

The `odds` command does all this math for you.

### 3️⃣ Books open near match time ⏰
Kalshi soccer volume is thin. A market can sit `active` for days with an empty book, then fill within hours of kickoff. A *live* World Cup match showed ~$24M volume with deep two-sided books. Empty book ≠ bug.

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
| `odds <A> <B> [--date YYMMMDD]` | 🎯 de-vigged win/draw/loss probabilities for a match |
| `markets [--series S] [--status open] [--limit N]` | 📋 list markets in a series |
| `market <TICKER>` / `orderbook <TICKER>` | 🔍 raw market / order book JSON |
| `balance` / `positions` / `orders` | 💰 account state (auth) |
| `bet <TICKER> <yes\|no> <count> <price_cents>` | 🎲 place an order (auth, price 1–99¢) |
| `cancel <ORDER_ID>` | ❌ cancel a resting order (auth) |

## ⚽ World Cup series (2026)

| series | what |
|---|---|
| `KXWCGAME` | 3-way match winner, e.g. `KXWCGAME-26JUN12USAPAR-USA` / `-TIE` / `-PAR` |
| `KXWCSCORE` | exact correct-score binaries |
| `KXMENWORLDCUP` | tournament winner |

Discover everything with `GET /series?category=Sports`. Ticker dates are `YYMMMDD` uppercase (`26JUN12`); team codes are 3-letter (`USA`, `PAR`, `CAN`, `BIH`).

## 🧮 What "de-vigging" means

A 3-way match has three YES markets. Their prices sum to **more** than 100% (that's the house edge, the vig). Normalize each by the total and you get the market's *true* implied probability. Compare that to your model's number. Bet the side where you're higher. 🟢

## 📐 Betting discipline

1. Run `odds` before locking any prediction.
2. Bet only when your probability clears the market's by a real margin (edge, not noise).
3. Bet the win/draw/loss bar, not exact scorelines (markets are binary; scorelines are long-odds).
4. Demo first. Always. 🧪

---

Made for 🏆 [AgentCup](https://agentcup.co). MIT.
