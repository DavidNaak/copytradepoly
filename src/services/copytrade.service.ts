import { PolymarketClient } from '../clients/polymarket.client';
import { TradeRepository } from '../repositories/trade.repository';
import { AccountConfig, CopytradeConfig, PolymarketTrade, ExecutedTrade } from '../types';

// Polymarket minimum order size is $1
const MIN_ORDER_SIZE_USD = 1.0;

export class CopytradeService {
  private client: PolymarketClient;
  private repository: TradeRepository;
  private isRunning: boolean = false;
  private pollInterval: number = 2000; // 2 seconds (matches Polygon block time)
  private heldPositions: Set<string> = new Set();

  constructor(accountConfig: AccountConfig) {
    this.client = new PolymarketClient(accountConfig);
    this.repository = new TradeRepository();
  }

  async start(
    config: CopytradeConfig,
    dryRun: boolean = false,
    verbose: boolean = false,
    allowAddToPosition: boolean = false
  ): Promise<void> {
    // Save config to database
    const savedConfig = this.repository.saveConfig(config);
    const configId = savedConfig.id!;

    this.isRunning = true;

    // Load existing held positions from database
    this.heldPositions = this.repository.getHeldPositions();

    // Use Unix timestamp (seconds) for comparison
    let lastProcessedTimestamp = Math.floor(Date.now() / 1000);
    let pollCount = 0;

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\nStopping copytrade...');
      this.isRunning = false;
      this.repository.deactivateConfig(configId);
      this.showExitSummary(configId);
      process.exit(0);
    });

    console.log(`Config saved with ID: ${configId}`);
    if (verbose) {
      console.log(`Started monitoring at: ${new Date(lastProcessedTimestamp * 1000).toISOString()}`);
      console.log(`Poll interval: ${this.pollInterval / 1000}s\n`);
    }

    // Main polling loop
    while (this.isRunning) {
      try {
        pollCount++;
        const pollTime = new Date().toLocaleTimeString();

        if (verbose) {
          console.log(`[${pollTime}] Poll #${pollCount} - Fetching trades...`);
        }

        // Fetch recent trades from target trader
        const trades = await this.client.getTradesForAddress(config.traderAddress);

        if (verbose) {
          console.log(`[${pollTime}] Fetched ${trades.length} total trades from API`);
        }

        // Filter to only new trades (after our start time) and BUY orders only
        const newTrades = trades.filter((trade) => {
          const isNew = trade.timestamp > lastProcessedTimestamp;
          const isBuy = trade.side === 'BUY';
          const notProcessed = !this.repository.isTradeProcessed(trade.transactionHash);
          return isNew && isBuy && notProcessed;
        });

        if (verbose) {
          const buyTrades = trades.filter(t => t.side === 'BUY').length;
          const recentTrades = trades.filter(t => t.timestamp > lastProcessedTimestamp).length;
          console.log(`[${pollTime}] Filtered: ${recentTrades} recent, ${buyTrades} buys, ${newTrades.length} new to copy`);

          // Show the most recent trade timestamp for debugging
          if (trades.length > 0) {
            const mostRecent = Math.max(...trades.map(t => t.timestamp));
            console.log(`[${pollTime}] Most recent trade: ${new Date(mostRecent * 1000).toLocaleString()}`);
            console.log(`[${pollTime}] Monitoring since: ${new Date(lastProcessedTimestamp * 1000).toLocaleString()}`);
          }
        }

        if (newTrades.length > 0) {
          console.log(`\n🎯 Found ${newTrades.length} new trade(s) to copy!`);

          for (const trade of newTrades) {
            // Refresh budget from DB before each trade to ensure accurate tracking
            const freshConfig = this.repository.getConfig(configId);
            if (freshConfig) {
              savedConfig.remainingBudget = freshConfig.remainingBudget;
            }

            // Stop if budget exhausted
            if (savedConfig.remainingBudget <= 0) {
              console.log('Budget exhausted. Stopping.');
              break;
            }

            await this.processTrade(trade, savedConfig, dryRun, allowAddToPosition, verbose);
          }

          // Update last processed timestamp
          const latestTrade = newTrades.reduce((latest, trade) =>
            trade.timestamp > latest.timestamp ? trade : latest
          );
          lastProcessedTimestamp = latestTrade.timestamp;
        } else if (verbose) {
          console.log(`[${pollTime}] No new trades to copy\n`);
        }

        // Update remaining budget from database
        const currentConfig = this.repository.getConfig(configId);
        if (currentConfig && currentConfig.remainingBudget <= 0) {
          console.log('Budget exhausted. Stopping copytrade.');
          this.isRunning = false;
          break;
        }

      } catch (error) {
        console.error('Error during poll:', error instanceof Error ? error.message : error);
      }

      // Wait before next poll
      await this.sleep(this.pollInterval);
    }

    // Show summary when exiting normally (e.g., budget exhausted)
    this.showExitSummary(configId);
  }

  private async processTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean,
    allowAddToPosition: boolean,
    verbose: boolean
  ): Promise<void> {
    // Skip if we already have this position (unless flag is set)
    if (!allowAddToPosition && this.heldPositions.has(trade.asset)) {
      if (verbose) {
        console.log(`\n⏭️  Skipping trade (already hold position):`);
        console.log(`  Market: ${trade.title} - ${trade.outcome}`);
        console.log(`  Reason: Already have position in this market`);
      }
      return;
    }

    const originalSize = trade.size;
    const price = trade.price;
    const originalCost = originalSize * price;

    // Calculate our trade amount (in dollars) based on copy percentage
    let tradeAmount = (originalCost * config.copyPercentage) / 100;

    // Apply max trade size limit
    tradeAmount = Math.min(tradeAmount, config.maxTradeSize);

    // Check against remaining budget
    if (tradeAmount > config.remainingBudget) {
      console.log(`Adjusted trade amount from $${tradeAmount.toFixed(2)} to $${config.remainingBudget.toFixed(2)} due to budget constraint`);
      tradeAmount = config.remainingBudget;
    }

    if (tradeAmount <= 0) {
      if (verbose) {
        console.log('Trade amount too small or no budget remaining. Skipping.');
      }
      return;
    }

    // Check against Polymarket minimum order size ($1)
    if (tradeAmount < MIN_ORDER_SIZE_USD) {
      if (verbose) {
        console.log(`\n⏭️  Skipping trade (below $1 minimum):`);
        console.log(`  Market: ${trade.title} - ${trade.outcome}`);
        console.log(`  Original trade: $${originalCost.toFixed(2)} (${originalSize.toFixed(2)} shares @ $${price.toFixed(4)})`);
        console.log(`  Your copy (${config.copyPercentage}%): $${tradeAmount.toFixed(2)}`);
        console.log(`  Reason: Polymarket requires minimum $1 orders`);
      }
      return;
    }

    // Estimate shares we'll get (actual may vary based on market)
    const estimatedShares = tradeAmount / price;

    console.log(`\n📈 Processing trade:`);
    console.log(`  Market: ${trade.title}`);
    console.log(`  Outcome: ${trade.outcome}`);
    console.log(`  Original: ${trade.side} $${originalCost.toFixed(2)} (${originalSize.toFixed(2)} shares @ $${price.toFixed(4)})`);
    console.log(`  Our order: $${tradeAmount.toFixed(2)} (~${estimatedShares.toFixed(2)} shares at current price)`);

    const executedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.transactionHash,
      traderAddress: config.traderAddress,
      market: trade.title,
      assetId: trade.asset,
      side: trade.side,
      originalSize,
      executedSize: estimatedShares,
      price,
      status: 'PENDING',
    };

    if (dryRun) {
      console.log('  [DRY RUN] Would execute this trade');
      executedTrade.status = 'SUCCESS';
      executedTrade.orderId = 'dry-run';
    } else {
      try {
        // Execute the trade via CLOB API using dollar amount
        const result = await this.client.placeMarketOrder({
          tokenId: trade.asset,
          side: 'BUY',
          amount: tradeAmount,
        });

        if (result.success && result.orderId) {
          executedTrade.status = 'SUCCESS';
          executedTrade.orderId = result.orderId;
          console.log(`  ✓ Trade executed! Order ID: ${result.orderId}`);

          // Update remaining budget in DB and in-memory
          const newBudget = config.remainingBudget - tradeAmount;
          this.repository.updateBudget(config.id!, newBudget);
          config.remainingBudget = newBudget;

          // Track that we now hold this position
          this.heldPositions.add(trade.asset);
        } else {
          executedTrade.status = 'FAILED';
          executedTrade.errorMessage = result.errorMessage || 'Order submission failed - no order ID returned';
          console.error(`  ✗ Trade failed: ${executedTrade.errorMessage}`);
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Check if it's a balance/allowance error - stop gracefully
        if (errorMsg.includes('not enough balance') || errorMsg.includes('allowance')) {
          console.error(`\n🛑 Stopping: Insufficient balance or allowance`);
          this.isRunning = false;
          return; // Don't save failed trade, just stop
        }

        // Other errors - log and continue
        executedTrade.status = 'FAILED';
        executedTrade.errorMessage = errorMsg;
        console.error(`  ✗ Trade failed: ${errorMsg}`);
      }
    }

    // Save executed trade to database
    try {
      this.repository.saveTrade(executedTrade);
    } catch (error) {
      // Ignore duplicate constraint errors (trade already recorded)
      if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
        console.log('  (Trade already recorded, skipping duplicate)');
      } else {
        throw error;
      }
    }
  }

  private showExitSummary(configId: number): void {
    const config = this.repository.getConfig(configId);
    const trades = this.repository.getTradesByConfig(configId, 100);

    const successful = trades.filter(t => t.status === 'SUCCESS');
    const failed = trades.filter(t => t.status === 'FAILED');
    const totalSpent = config ? config.budget - config.remainingBudget : 0;

    console.log('\n' + '='.repeat(50));
    console.log('📊 COPYTRADE SESSION SUMMARY');
    console.log('='.repeat(50));
    console.log(`  Trades executed: ${successful.length}`);
    console.log(`  Trades failed: ${failed.length}`);
    console.log(`  Total spent: $${totalSpent.toFixed(2)}`);
    console.log(`  Remaining budget: $${config?.remainingBudget.toFixed(2) || '0.00'}`);
    console.log(`  Positions entered: ${successful.length}`);

    if (successful.length > 0) {
      console.log('\n  Markets entered:');
      const markets = [...new Set(successful.map(t => t.market))];
      markets.forEach(m => console.log(`    • ${m}`));
    }
    console.log('='.repeat(50) + '\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop(): void {
    this.isRunning = false;
  }
}
