import { PolymarketClient } from '../clients/polymarket.client';
import { TradeRepository } from '../repositories/trade.repository';
import { AccountConfig, CopytradeConfig, PolymarketTrade, ExecutedTrade } from '../types';

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

    // Calculate our trade size based on copy percentage
    let tradeSize = (originalSize * config.copyPercentage) / 100;

    // Apply max trade size limit
    tradeSize = Math.min(tradeSize, config.maxTradeSize);

    // Check against remaining budget
    const tradeCost = tradeSize * price;
    if (tradeCost > config.remainingBudget) {
      tradeSize = config.remainingBudget / price;
      console.log(`Adjusted trade size to $${tradeSize.toFixed(2)} due to budget constraint`);
    }

    if (tradeSize <= 0) {
      console.log('Trade size too small or no budget remaining. Skipping.');
      return;
    }

    console.log(`\nProcessing trade:`);
    console.log(`  Market: ${trade.title}`);
    console.log(`  Outcome: ${trade.outcome}`);
    console.log(`  Original: ${trade.side} ${originalSize.toFixed(2)} shares @ $${price.toFixed(4)}`);
    console.log(`  Our size: ${tradeSize.toFixed(2)} shares (${config.copyPercentage}% of original)`);
    console.log(`  Cost: $${(tradeSize * price).toFixed(2)}`);

    const executedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.transactionHash,
      traderAddress: config.traderAddress,
      market: trade.title,
      assetId: trade.asset,
      side: trade.side,
      originalSize,
      executedSize: tradeSize,
      price,
      status: 'PENDING',
    };

    if (dryRun) {
      console.log('  [DRY RUN] Would execute this trade');
      executedTrade.status = 'SUCCESS';
      executedTrade.orderId = 'dry-run';
    } else {
      try {
        // Execute the trade via CLOB API
        const result = await this.client.placeMarketOrder({
          tokenId: trade.asset,
          side: 'BUY',
          size: tradeSize,
        });

        executedTrade.status = 'SUCCESS';
        executedTrade.orderId = result.orderId;
        console.log(`  ✓ Trade executed! Order ID: ${result.orderId}`);

        // Update remaining budget
        this.repository.updateBudget(config.id!, config.remainingBudget - tradeCost);

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
