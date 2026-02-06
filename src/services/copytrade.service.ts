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

  async start(config: CopytradeConfig, dryRun: boolean = false): Promise<void> {
    // Save config to database
    const savedConfig = this.repository.saveConfig(config);
    const configId = savedConfig.id!;

    this.isRunning = true;

    // Get initial timestamp to only process new trades
    let lastProcessedTime = new Date().toISOString();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\nStopping copytrade...');
      this.isRunning = false;
      this.repository.deactivateConfig(configId);
      process.exit(0);
    });

    console.log(`Config saved with ID: ${configId}`);

    // Main polling loop
    while (this.isRunning) {
      try {
        // Fetch recent trades from target trader
        const trades = await this.client.getTradesForAddress(config.traderAddress);

        // Filter to only new trades (after our start time) and BUY orders only
        const newTrades = trades.filter((trade) => {
          const isNew = trade.match_time > lastProcessedTime;
          const isBuy = trade.side === 'BUY';
          const notProcessed = !this.repository.isTradeProcessed(trade.id);
          return isNew && isBuy && notProcessed;
        });

        if (newTrades.length > 0) {
          console.log(`Found ${newTrades.length} new trade(s) to copy`);

          for (const trade of newTrades) {
            await this.processTrade(trade, savedConfig, dryRun);
          }

          // Update last processed time
          const latestTrade = newTrades.reduce((latest, trade) =>
            trade.match_time > latest.match_time ? trade : latest
          );
          lastProcessedTime = latestTrade.match_time;
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
    const originalSize = parseFloat(trade.size);
    const price = parseFloat(trade.price);

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
    console.log(`  Original: ${trade.side} $${originalSize.toFixed(2)} @ ${price.toFixed(4)}`);
    console.log(`  Our size: $${tradeSize.toFixed(2)} (${config.copyPercentage}% of original)`);
    console.log(`  Market: ${trade.market}`);

    const executedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.id,
      traderAddress: config.traderAddress,
      market: trade.market,
      assetId: trade.asset_id,
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
          tokenId: trade.asset_id,
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
