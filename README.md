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
- A Polymarket account with trading enabled
- Your MetaMask wallet private key

### Wallet Types

The bot supports two wallet types. **Choose based on whether you want to see trades in the Polymarket UI:**

| Type | Address to Use | Trades in UI? | Gas Fees | Setup |
|------|---------------|---------------|----------|-------|
| **Proxy Wallet** | Your Polymarket proxy address | Yes | No (relayer pays) | Recommended |
| **EOA (Direct)** | Your MetaMask address | No | Yes (you pay POL) | Advanced |

**Proxy Wallet (Recommended)**
- Trades appear in polymarket.com under your positions
- No gas fees - Polymarket's relayer handles them
- No token approvals needed
- Use the proxy address shown in your Polymarket account settings

**EOA (Direct Wallet)**
- Trades do NOT appear in the Polymarket UI
- You pay gas fees in POL
- Requires one-time USDC.e token approvals
- Use your MetaMask wallet address directly

### Finding Your Proxy Wallet Address

1. Go to polymarket.com and connect your MetaMask
2. Open browser DevTools (F12) → Network tab
3. Look for API requests - your proxy address appears in the responses
4. Or check: `https://data-api.polymarket.com/profiles?user=YOUR_METAMASK_ADDRESS`

The bot auto-detects which wallet type you're using based on the address in your `.env` file.

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
PRIVATE_KEY=your_metamask_private_key
FUNDER_ADDRESS=your_proxy_or_eoa_address
```

- `PRIVATE_KEY`: Your MetaMask private key (same for both wallet types)
- `FUNDER_ADDRESS`: Either your proxy wallet address (recommended) or your MetaMask EOA address

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
- `-v, --verbose`: Show detailed polling activity

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

## Common Issues

### Wrong USDC Type

Polymarket uses **USDC.e (bridged)**, not native USDC on Polygon. If you see:

```
Checking wallet balance...
  Wallet Address: 0x75320178FcDd76C56ABb8939e090C9382D07E9Ae
  ⚠️  Warning: You have $9.95 native USDC, but Polymarket uses USDC.e (bridged)
  ⚠️  Swap native USDC to USDC.e on a DEX like Uniswap/QuickSwap
  USDC Balance: $0.00
```

**Solution**: Swap your native USDC to USDC.e on a DEX like [QuickSwap](https://quickswap.exchange/) or [Uniswap](https://app.uniswap.org/).

### Insufficient Balance

```
Error: Insufficient balance. You have $0.00 but requested $1 budget.
Either reduce your budget or add funds to your wallet.
```

**Solution**: Ensure you have USDC.e in your `FUNDER_ADDRESS`:
- **Proxy wallet**: Deposit through polymarket.com
- **EOA**: Send USDC.e directly to your MetaMask address on Polygon

### Wallet Address Mismatch

If you're using a **proxy wallet** (recommended), make sure:
1. `FUNDER_ADDRESS` is set to your proxy address, not your MetaMask address
2. Funds are deposited through polymarket.com (they go to your proxy)

If you're using **EOA** (direct wallet):
1. `FUNDER_ADDRESS` should be your MetaMask address
2. Send USDC.e directly to that address on Polygon

### "Could not create api key" Error

This is usually a temporary Polymarket API issue. The trade may still succeed - check the final status message.

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
