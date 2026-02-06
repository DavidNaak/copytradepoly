# Polymarket Copytrader CLI

A command-line copytrading bot for Polymarket that automatically mirrors the trades of any trader you want to follow.

## Features

| Feature | Description |
|---------|-------------|
| **BUY Copying** | Automatically copy BUY trades with configurable percentage |
| **SELL Copying** | Exit positions when the trader sells |
| **Session Tracking** | Each session tracks its own positions independently |
| **Budget Reinvestment** | Sell proceeds automatically added back to budget |
| **Dry Run Mode** | Test without executing real trades |
| **P&L Tracking** | Session summary shows realized profit/loss |

---

## Quick Start

### 1. Install

```bash
git clone <your-repo-url>
cd polymarket-copytrader
npm install
npm run build
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
PRIVATE_KEY=your_metamask_private_key
FUNDER_ADDRESS=your_polymarket_proxy_address
```

### 3. Verify Setup

```bash
npm run dev -- setup-account
```

### 4. Start Copytrading

```bash
npm run dev -- copytrade \
  --trader 0xTRADER_ADDRESS \
  --budget 100 \
  --percentage 10 \
  --max-trade 20
```

---

## Commands

### `setup-account`

Verify your wallet connection and check balances.

```bash
npm run dev -- setup-account
```

**Output:**
```
Checking wallet balance and allowance...
  Wallet Address: 0x5A75...C767
  Wallet type: Proxy wallet
  ✓ Proxy wallet - no approvals needed
  USDC Balance: $100.00
```

---

### `copytrade`

Start copying a trader's positions.

```bash
npm run dev -- copytrade [options]
```

#### Required Options

| Flag | Description | Example |
|------|-------------|---------|
| `-t, --trader <address>` | Wallet address to copy | `0x469c...309b` |
| `-b, --budget <amount>` | Total budget in USDC | `100` |
| `-p, --percentage <percent>` | Copy percentage of their trades | `10` (= 10%) |
| `-m, --max-trade <amount>` | Maximum per trade | `20` |

#### Optional Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Simulate trades without executing |
| `-v, --verbose` | `false` | Show detailed polling logs |
| `--allow-add-to-position` | `false` | Buy more of positions you already hold |
| `--no-reinvest` | `false` | Don't add sell proceeds back to budget |

#### Examples

**Basic copytrading:**
```bash
npm run dev -- copytrade -t 0x469c...309b -b 50 -p 100 -m 10
```

**Dry run to test:**
```bash
npm run dev -- copytrade -t 0x469c...309b -b 50 -p 100 -m 10 --dry-run
```

**Verbose mode for debugging:**
```bash
npm run dev -- copytrade -t 0x469c...309b -b 50 -p 100 -m 10 -v
```

**Allow stacking positions:**
```bash
npm run dev -- copytrade -t 0x469c...309b -b 50 -p 100 -m 10 --allow-add-to-position
```

---

### `status`

View active configurations and trade history.

```bash
npm run dev -- status
npm run dev -- status --config-id 1
npm run dev -- status --limit 50
```

---

## How It Works

### Architecture

```
┌─────────────────┐     Poll every 2s      ┌──────────────────┐
│  Polymarket     │ ◄──────────────────── │  Copytrade Bot   │
│  Data API       │                        │                  │
└─────────────────┘                        │  ┌────────────┐  │
        │                                  │  │ Session DB │  │
        │ Trader's trades                  │  └────────────┘  │
        ▼                                  │        │         │
┌─────────────────┐     Place orders       │        ▼         │
│  Polymarket     │ ◄──────────────────── │  Track positions │
│  CLOB API       │                        │  Track budget    │
└─────────────────┘                        └──────────────────┘
```

### BUY Order Logic

When the trader BUYs, the bot decides what to do:

| Condition | Action |
|-----------|--------|
| Already hold position (this session) | **Skip** (unless `--allow-add-to-position`) |
| No budget remaining | **Skip**, wait for sells to free up budget |
| Copy amount < $1 | **Skip** (Polymarket minimum) |
| Copy amount > max trade | **Cap** at max trade size |
| Copy amount > remaining budget | **Cap** at remaining budget |
| Otherwise | **Execute BUY** |

**BUY Amount Calculation:**
```
copyAmount = min(
  traderBuyValue × copyPercentage,
  maxTradeSize,
  remainingBudget
)
```

### SELL Order Logic

When the trader SELLs, the bot decides what to do:

| Condition | Action |
|-----------|--------|
| No position in this session | **Skip** |
| No actual position (API check) | **Skip** |
| Copy amount > actual position | **Cap** at actual position |
| Otherwise | **Execute SELL** |

**SELL Amount Calculation:**
```
sellAmount = min(
  traderSellValue × copyPercentage,
  actualPositionValue  ← fetched from Polymarket API
)
```

### Budget Flow

```
Start: $100 budget
        │
        ▼
   ┌─────────┐
   │ BUY $20 │ ──► Budget: $80
   └─────────┘
        │
        ▼
   ┌─────────┐
   │ BUY $30 │ ──► Budget: $50
   └─────────┘
        │
        ▼
   ┌──────────┐
   │ SELL $25 │ ──► Budget: $75 (if reinvest enabled)
   └──────────┘
        │
        ▼
   Can BUY again with $75
```

### Session Summary

When you stop the bot (Ctrl+C), you'll see:

```
==================================================
📊 COPYTRADE SESSION SUMMARY
==================================================
  BUY trades executed: 5
  SELL trades executed: 2
  Trades failed: 0
  Total bought: $5.00
  Total sold: $2.80
  Net deployed: $2.20
  Realized P&L: +$0.15
  Remaining budget: $1.80

  Markets entered:
    • Will Trump win 2028?
    • US strikes Iran by June?
==================================================
```

---

## Wallet Setup

### Option 1: Proxy Wallet (Recommended)

Your Polymarket proxy wallet. Trades appear in the Polymarket UI.

| Pros | Cons |
|------|------|
| Trades visible on polymarket.com | Need to find proxy address |
| No gas fees (relayer pays) | - |
| No token approvals needed | - |

**Finding your proxy address:**
1. Go to polymarket.com and connect MetaMask
2. Open DevTools (F12) → Network tab
3. Look for your proxy address in API responses
4. Or visit: `https://data-api.polymarket.com/profiles?user=YOUR_METAMASK_ADDRESS`

### Option 2: EOA (Direct Wallet)

Your MetaMask address directly. Trades do NOT appear in Polymarket UI.

| Pros | Cons |
|------|------|
| Simple setup | Trades not visible on polymarket.com |
| - | You pay gas fees in POL |
| - | Requires token approvals |

---

## Common Issues

### Wrong USDC Type

Polymarket uses **USDC.e (bridged)**, not native USDC.

```
⚠️  Warning: You have $9.95 native USDC, but Polymarket uses USDC.e
```

**Solution:** Swap on [QuickSwap](https://quickswap.exchange/) or [Uniswap](https://app.uniswap.org/)

### Insufficient Balance

```
Error: Insufficient balance. You have $0.00 but requested $100 budget.
```

**Solution:**
- Proxy wallet → Deposit through polymarket.com
- EOA → Send USDC.e to your address on Polygon

### SELL Fails with "not enough balance"

This can happen for two reasons:

**1. Slippage on BUY orders:**
When buying, the bot estimates shares received (`amount / price`), but market orders have slippage. You may receive fewer shares than estimated.

**2. Multiple SELLs in rapid succession:**
When the trader makes multiple sells quickly, the bot processes them in the same batch. The Polymarket API may return stale position data that hasn't updated from the previous sell yet.

**How the bot handles this:**

```
┌─────────────────────────────────────────────────────────────┐
│  For each SELL order:                                       │
│                                                             │
│  1. Fetch actual position from Polymarket API               │
│  2. Compare with local cache (from previous sells in batch) │
│  3. Use the SMALLER of the two (most conservative)          │
│  4. After successful sell, update local cache               │
│  5. Cache cleared at start of each poll cycle               │
└─────────────────────────────────────────────────────────────┘
```

**Why `min(API, cache)` works:**

| Scenario | API | Cache | min() | Result |
|----------|-----|-------|-------|--------|
| API stale after sell | 100 | 60 | 60 | Uses accurate cache |
| Cache stale (external change) | 60 | 100 | 60 | Uses accurate API |
| Both accurate | 60 | 60 | 60 | Either works |

This prevents over-selling in all cases.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your MetaMask private key |
| `FUNDER_ADDRESS` | Yes | Proxy wallet or EOA address |
| `POLYGON_RPC_URL` | No | Custom Polygon RPC (default: public node) |
| `CLOB_API_URL` | No | Custom CLOB API URL |

### Database

The bot stores data in `copytrader.db` (SQLite) in the project root:

- **copytrade_configs** - Session configurations
- **executed_trades** - All executed and skipped trades

---

## Project Structure

```
src/
├── cli/
│   ├── setup.ts          # setup-account command
│   ├── copytrade.ts       # copytrade command
│   └── status.ts          # status command
├── services/
│   ├── account.service.ts # Account validation
│   └── copytrade.service.ts # Core trading logic
├── clients/
│   └── polymarket.client.ts # Polymarket API client
├── repositories/
│   └── trade.repository.ts  # Database operations
├── types/
│   └── index.ts           # TypeScript interfaces
└── index.ts               # CLI entry point
```

---

## Multiple Traders

To copy multiple traders simultaneously, run separate terminal instances:

**Terminal 1:**
```bash
npm run dev -- copytrade -t 0xTRADER_A -b 50 -p 100 -m 10
```

**Terminal 2:**
```bash
npm run dev -- copytrade -t 0xTRADER_B -b 50 -p 50 -m 5
```

Each session tracks positions independently.

---

## Development

```bash
# Development mode (with hot reload)
npm run dev -- <command>

# Build for production
npm run build

# Run production build
npm start -- <command>
```

---

## License

MIT
