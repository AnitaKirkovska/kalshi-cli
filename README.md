# kalshi-cli

A tiny, dependency-free CLI for reading live odds and placing trades on [Kalshi](https://kalshi.com) prediction markets. Built for the [AgentCup](https://agentcup.co) workflow: pull the market's implied probabilities before every prediction, and bet only when our number beats the market's price.

No npm install. Node's built-in `crypto` signs requests (RSA-PSS) natively.

## Usage

```bash
# market data, no auth needed:
KALSHI_ENV=prod node kalshi.js odds USA PAR --date 26JUN12
KALSHI_ENV=prod node kalshi.js markets --series KXWCGAME --limit 20

# authenticated (needs a Kalshi API key):
node kalshi.js balance
node kalshi.js bet KXWCGAME-26JUN12USAPAR-USA yes 10 47
```

`odds` finds the match market, reads each outcome's order book, and prints de-vigged win / draw / loss probabilities.

## The three gotchas

1. **The API moved.** Old `trading-api.kalshi.com` is dead. Market data: `https://api.elections.kalshi.com/trade-api/v2`. Trading: `external-api.{demo|prod}.kalshi.*`.
2. **Prices are not in the summary fields.** `yes_bid`/`yes_ask`/`last_price` come back null. Real prices live in `GET /markets/{ticker}/orderbook`. Best YES ask = 1 minus best NO bid.
3. **Books open near match time.** A market can be active for days with an empty book, then fill within hours of kickoff. Empty book is not a bug.

## Auth

Kalshi signs with an RSA private key, not a bearer token. Generate one in Account to API Keys, then set:

- `KALSHI_KEY_ID` the key id
- `KALSHI_KEY_PATH` path to the private key `.pem` (never commit it)
- `KALSHI_ENV` `demo` (default, fake money) or `prod`

Each request signs `timestamp_ms + METHOD + path` with RSA-PSS / SHA256, base64, sent via the `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP`, `KALSHI-ACCESS-SIGNATURE` headers. The CLI handles all of it.

Always test against demo first.

## Commands

| command | does |
|---|---|
| `odds <A> <B> [--date YYMMMDD]` | de-vigged win/draw/loss probabilities for a match |
| `markets [--series S] [--status open] [--limit N]` | list markets in a series |
| `market <TICKER>` / `orderbook <TICKER>` | raw market / orderbook JSON |
| `balance` / `positions` / `orders` | account state (auth) |
| `bet <TICKER> <yes\|no> <count> <price_cents>` | place an order (auth) |
| `cancel <ORDER_ID>` | cancel a resting order (auth) |

## World Cup series (2026)

- `KXWCGAME` 3-way match winner, e.g. `KXWCGAME-26JUN12USAPAR-USA`
- `KXWCSCORE` exact correct-score binaries
- `KXMENWORLDCUP` tournament winner

Discover series with `GET /series?category=Sports`.
