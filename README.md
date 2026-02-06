# Polymarket Copytrader CLI

A command-line copytrading bot for Polymarket that allows you to automatically mirror the trades of other traders.

## Features

- **Account Setup**: Initialize and validate your Polymarket account connection
- **Copytrading**: Mirror trades from any Polymarket wallet address
- **Configurable**: Set budget, copy percentage, and max trade size
- **Persistent Storage**: SQLite database tracks configurations and trade history
- **Dry Run Mode**: Test your configuration without executing real trades
- **Status Monitoring**: View active configs and trade history

## Prerequisites

- Node.js v18+
- A Polymarket account with USDC on Polygon
- Your wallet private key and address

## Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd polymarket-copytrader

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` with your credentials:
```
PRIVATE_KEY=your_wallet_private_key
FUNDER_ADDRESS=your_wallet_address
```

**IMPORTANT**: Never commit your `.env` file or share your private key.

## Usage

### Setup Account

Initialize and validate your Polymarket account connection:

```bash
# Using environment variables
npm run dev -- setup-account

# Or with command line flags
npm run dev -- setup-account --private-key YOUR_KEY --address YOUR_ADDRESS
```

### Start Copytrading

Mirror trades from a target wallet:

```bash
npm run dev -- copytrade \
  --trader 0xTARGET_WALLET_ADDRESS \
  --budget 100 \
  --percentage 10 \
  --max-trade 20
```

Options:
- `-t, --trader <address>`: Wallet address to copy (required)
- `-b, --budget <amount>`: Total budget in USDC (required)
- `-p, --percentage <percent>`: Copy percentage (e.g., 10 = 10% of their trade) (required)
- `-m, --max-trade <amount>`: Maximum amount per trade (required)
- `--dry-run`: Simulate without executing trades

### Check Status

View active configurations and trade history:

```bash
npm run dev -- status

# Show trades for a specific config
npm run dev -- status --config-id 1

# Limit number of trades shown
npm run dev -- status --limit 20
```

## Project Structure

```
src/
├── cli/                  # CLI command handlers
│   ├── setup.ts         # setup-account command
│   ├── copytrade.ts     # copytrade command
│   └── status.ts        # status command
├── services/            # Business logic
│   ├── account.service.ts
│   └── copytrade.service.ts
├── clients/             # External API clients
│   └── polymarket.client.ts
├── repositories/        # Data persistence
│   └── trade.repository.ts
├── types/               # TypeScript interfaces
│   └── index.ts
└── index.ts             # CLI entry point
```

## How It Works

1. **Polling**: The bot polls the Polymarket API every 5 seconds for new trades from the target wallet
2. **Filtering**: Only BUY orders after the copytrade start time are processed
3. **Sizing**: Trade size is calculated as: `min(originalSize * copyPercentage, maxTradeSize, remainingBudget)`
4. **Execution**: Market orders are placed via the CLOB API at the best available price
5. **Tracking**: All executed trades are stored in SQLite for history and duplicate prevention

## Limitations

- Currently only handles BUY events (SELL events are out of scope per assignment)
- Single wallet copytrading (multi-wallet support is a bonus feature)
- No position exit logic (bonus feature)

## Development

```bash
# Run in development mode
npm run dev -- <command>

# Build for production
npm run build

# Run built version
npm start -- <command>
```

## License

MIT
