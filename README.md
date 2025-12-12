# Sim Top Token Holders Tracker Bot

A Telegram bot that monitors top ERC20 token holders and sends real-time alerts when they move funds. This example demonstrates integrating Sim's Token Holders API and Subscriptions API to build a whale tracking bot.

To read the full guide, visit [https://docs.sim.dune.com/evm/build-a-top-holders-tracker-bot](https://docs.sim.dune.com/evm/build-a-top-holders-tracker-bot).

## Features

- 🐋 Identify top holders for any ERC20 token
- 🔔 Real-time balance change notifications via webhooks
- 📲 Telegram alerts with transaction details
- ⏸️ Pause and resume webhook subscriptions
- 🔗 Multi-chain support (Ethereum, Base, Arbitrum, Polygon, and more)

## Prerequisites

- Node.js >= 22.0.0
- A Sim API key from [sim.dune.com](https://sim.dune.com)
- A Telegram bot token from [@BotFather](https://t.me/botfather)
- A Supabase account (free tier works)

## Getting Started

1. Clone the repository

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up your environment:

   ```bash
   cp .env.template .env
   ```

   Then edit `.env` with your credentials:

   ```env
   SIM_API_KEY=your_sim_api_key
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   WEBHOOK_BASE_URL=https://your-deployed-url.com
   DATABASE_URL=your_supabase_connection_string
   ```

4. Add your token list:

   Export a CSV of tokens from Dune Analytics and save it as `tokens.csv` in the project root.

5. Start the server:

   ```bash
   npm start
   ```

6. Initialize the tracker:

   ```bash
   # Fetch top holders for each token
   curl -X POST http://localhost:3000/setup/fetch-holders

   # Create webhooks to monitor those holders
   curl -X POST http://localhost:3000/setup/create-webhooks
   ```

7. Register the Telegram webhook:

   ```bash
   curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "<YOUR_URL>/telegram/webhook"}'
   ```

## Project Structure

```
├── main.js               # Express server and core logic
├── tokens.csv            # Token list exported from Dune
├── package.json          # Project configuration
└── .env                  # Environment variables
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/balances` | POST | Webhook receiver for balance changes |
| `/telegram/webhook` | POST | Telegram bot updates |
| `/setup/fetch-holders` | POST | Fetch top holders for all tokens |
| `/setup/create-webhooks` | POST | Create webhooks for all holders |
| `/setup/view-webhooks` | GET | List all webhooks |
| `/setup/pause-webhooks` | POST | Pause all webhooks |
| `/setup/resume-webhooks` | POST | Resume all webhooks |