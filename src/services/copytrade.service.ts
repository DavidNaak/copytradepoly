import { PolymarketClient } from '../clients/polymarket.client';
import { TradeRepository } from '../repositories/trade.repository';
import { AccountConfig, CopytradeConfig, PolymarketTrade, ExecutedTrade } from '../types';

// Polymarket minimum order size is $1
const MIN_ORDER_SIZE_USD = 1.0;

export class CopytradeService {
  private client: PolymarketClient;
  private repository: TradeRepository;
  private isRunning: boolean = false;
  private pollInterval: number = 5000; // 5 seconds

  constructor(accountConfig: AccountConfig) {
    this.client = new PolymarketClient(accountConfig);
    this.repository = new TradeRepository();
  }

  async start(config: CopytradeConfig, dryRun: boolean = false, verbose: boolean = false): Promise<void> {
    // Save config to database
    const savedConfig = this.repository.saveConfig(config);
    const configId = savedConfig.id!;

    this.isRunning = true;

    // Use Unix timestamp (seconds) for comparison
    let lastProcessedTimestamp = Math.floor(Date.now() / 1000);
    let pollCount = 0;

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\nStopping copytrade...');
      this.isRunning = false;
      this.repository.deactivateConfig(configId);
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
            await this.processTrade(trade, savedConfig, dryRun);
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
  }

  private async processTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean
  ): Promise<void> {
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
      console.log('Trade amount too small or no budget remaining. Skipping.');
      return;
    }

    // Check against Polymarket minimum order size ($1)
    if (tradeAmount < MIN_ORDER_SIZE_USD) {
      console.log(`\n⏭️  Skipping trade (below $1 minimum):`);
      console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      console.log(`  Original trade: $${originalCost.toFixed(2)} (${originalSize.toFixed(2)} shares @ $${price.toFixed(4)})`);
      console.log(`  Your copy (${config.copyPercentage}%): $${tradeAmount.toFixed(2)}`);
      console.log(`  Reason: Polymarket requires minimum $1 orders`);
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

          // Update remaining budget
          this.repository.updateBudget(config.id!, config.remainingBudget - tradeAmount);
        } else {
          executedTrade.status = 'FAILED';
          executedTrade.errorMessage = result.errorMessage || 'Order submission failed - no order ID returned';
          console.error(`  ✗ Trade failed: ${executedTrade.errorMessage}`);
        }

      } catch (error) {
        executedTrade.status = 'FAILED';
        executedTrade.errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`  ✗ Trade failed: ${executedTrade.errorMessage}`);
      }
    }

    // Save executed trade to database
    this.repository.saveTrade(executedTrade);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop(): void {
    this.isRunning = false;
  }
}
