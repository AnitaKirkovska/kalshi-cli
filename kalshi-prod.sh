#!/bin/bash
# Wrapper: runs kalshi.js with prod credentials without exposing them in
# schedule prompts or conversation context. Created Jul 3, 2026 after
# bet #15 bypass (LLM ignored prompt-level guard, placed direct API call
# using credentials visible in the Nightly Kalshi Review prompt).
#
# Usage: bash kalshi-prod.sh balance
#        bash kalshi-prod.sh positions
#        bash kalshi-prod.sh reconcile
#        bash kalshi-prod.sh orders
#        bash kalshi-prod.sh bet <ticker> yes <count> <cents>
#
# NEVER use this to place MARKET orders. kalshi.js now blocks them by default.
export KALSHI_ENV=prod
export KALSHI_KEY_ID=a6fc348f-8bb6-4dbc-a328-f5812544d10a
export KALSHI_KEY_PATH=/workspace/.secrets/kalshi-prod.pem
exec node /workspace/scratch/wc-leaderboard/kalshi.js "$@"
