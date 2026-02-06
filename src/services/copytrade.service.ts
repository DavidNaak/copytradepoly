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
  // Local cache of positions to handle rapid sells (API may be stale)
  private positionCache: Map<string, number> = new Map();

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

        // Clear position cache at start of each poll to get fresh API data
        this.positionCache.clear();

        if (verbose) {
          console.log(`[${pollTime}] Poll #${pollCount} - Fetching trades...`);
        }

        // Fetch recent trades from target trader
        const trades = await this.client.getTradesForAddress(config.traderAddress);

        if (verbose) {
          console.log(`[${pollTime}] Fetched ${trades.length} total trades from API`);
        }

        // Filter to only new trades (after our start time) - both BUY and SELL
        const newTrades = trades.filter((trade) => {
          const isNew = trade.timestamp > lastProcessedTimestamp;
          const notProcessed = !this.repository.isTradeProcessed(trade.transactionHash);
          return isNew && notProcessed;
        });

        if (verbose) {
          const buyTrades = newTrades.filter(t => t.side === 'BUY').length;
          const sellTrades = newTrades.filter(t => t.side === 'SELL').length;
          console.log(`[${pollTime}] Filtered: ${newTrades.length} new trades (${buyTrades} buys, ${sellTrades} sells)`);

          // Show the most recent trade timestamp for debugging
          if (trades.length > 0) {
            const mostRecent = Math.max(...trades.map(t => t.timestamp));
            console.log(`[${pollTime}] Most recent trade: ${new Date(mostRecent * 1000).toLocaleString()}`);
            console.log(`[${pollTime}] Monitoring since: ${new Date(lastProcessedTimestamp * 1000).toLocaleString()}`);
          }
        }

        if (newTrades.length > 0) {
          const buys = newTrades.filter(t => t.side === 'BUY').length;
          const sells = newTrades.filter(t => t.side === 'SELL').length;
          console.log(`\n${'─'.repeat(50)}`);
          console.log(`🎯 Found ${newTrades.length} new trade(s) to copy! (${buys} buys, ${sells} sells)`);
          console.log(`${'─'.repeat(50)}`);

          for (let i = 0; i < newTrades.length; i++) {
            const trade = newTrades[i];
            // Refresh budget from DB before each trade to ensure accurate tracking
            const freshConfig = this.repository.getConfig(configId);
            if (freshConfig) {
              savedConfig.remainingBudget = freshConfig.remainingBudget;
            }

            await this.processTrade(trade, savedConfig, dryRun, allowAddToPosition, verbose, i + 1, newTrades.length);
          }
          console.log(`${'─'.repeat(50)}\n`);

          // Update last processed timestamp
          const latestTrade = newTrades.reduce((latest, trade) =>
            trade.timestamp > latest.timestamp ? trade : latest
          );
          lastProcessedTimestamp = latestTrade.timestamp;
        } else if (verbose) {
          console.log(`[${pollTime}] No new trades to copy\n`);
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
    verbose: boolean,
    tradeNum: number,
    totalTrades: number
  ): Promise<void> {
    if (trade.side === 'BUY') {
      await this.processBuyTrade(trade, config, dryRun, allowAddToPosition, verbose, tradeNum, totalTrades);
    } else {
      await this.processSellTrade(trade, config, dryRun, verbose, tradeNum, totalTrades);
    }
  }

  private async processBuyTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean,
    allowAddToPosition: boolean,
    verbose: boolean,
    tradeNum: number,
    totalTrades: number
  ): Promise<void> {
    const tradeLabel = `[${tradeNum}/${totalTrades}]`;

    // Skip if we already have this position in THIS session (unless flag is set)
    if (!allowAddToPosition && this.repository.hasSessionPosition(config.id!, trade.asset)) {
      console.log(`\n${tradeLabel} ⏭️  SKIPPED BUY - already hold position`);
      console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      this.markTradeSkipped(trade, config, 'Already hold position');
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
      if (config.remainingBudget <= 0) {
        console.log(`\n${tradeLabel} ⏭️  SKIPPED BUY - no budget (waiting for sells)`);
        console.log(`  Market: ${trade.title} - ${trade.outcome}`);
        this.markTradeSkipped(trade, config, 'No budget');
        return;
      }
      console.log(`  Adjusted: $${tradeAmount.toFixed(2)} → $${config.remainingBudget.toFixed(2)} (budget limit)`);
      tradeAmount = config.remainingBudget;
    }

    if (tradeAmount <= 0) {
      console.log(`\n${tradeLabel} ⏭️  SKIPPED BUY - amount too small`);
      console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      this.markTradeSkipped(trade, config, 'Trade amount too small');
      return;
    }

    // Check against Polymarket minimum order size ($1)
    if (tradeAmount < MIN_ORDER_SIZE_USD) {
      console.log(`\n${tradeLabel} ⏭️  SKIPPED BUY - below $1 minimum ($${tradeAmount.toFixed(2)})`);
      console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      this.markTradeSkipped(trade, config, 'Below $1 minimum');
      return;
    }

    // Estimate shares we'll get (actual may vary based on market)
    const estimatedShares = tradeAmount / price;

    console.log(`\n${tradeLabel} 📈 BUY`);
    console.log(`  Market: ${trade.title} - ${trade.outcome}`);
    console.log(`  Trader: $${originalCost.toFixed(2)} (${originalSize.toFixed(2)} shares @ $${price.toFixed(4)})`);
    console.log(`  Us: $${tradeAmount.toFixed(2)} (~${estimatedShares.toFixed(2)} shares)`);

    const executedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.transactionHash,
      traderAddress: config.traderAddress,
      market: trade.title,
      assetId: trade.asset,
      side: 'BUY',
      originalSize,
      executedSize: estimatedShares,
      price,
      status: 'PENDING',
    };

    if (dryRun) {
      console.log('  [DRY RUN] Would execute this BUY');
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
          console.log(`  ✓ BUY executed! Order ID: ${result.orderId}`);

          // Update remaining budget in DB and in-memory
          const newBudget = config.remainingBudget - tradeAmount;
          this.repository.updateBudget(config.id!, newBudget);
          config.remainingBudget = newBudget;
          console.log(`  Budget remaining: $${newBudget.toFixed(2)}`);
        } else {
          executedTrade.status = 'FAILED';
          executedTrade.errorMessage = result.errorMessage || 'Order submission failed - no order ID returned';
          console.error(`  ✗ BUY failed: ${executedTrade.errorMessage}`);
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
        console.error(`  ✗ BUY failed: ${errorMsg}`);
      }
    }

    // Save executed trade to database
    this.saveTradeRecord(executedTrade);
  }

  private async processSellTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean,
    verbose: boolean,
    tradeNum: number,
    totalTrades: number
  ): Promise<void> {
    const tradeLabel = `[${tradeNum}/${totalTrades}]`;

    // Check if we have a position to sell in THIS session (for tracking)
    const sessionPosition = this.repository.getSessionPosition(config.id!, trade.asset);

    if (sessionPosition.shares <= 0) {
      if (verbose) {
        console.log(`\n${tradeLabel} ⏭️  SKIPPED SELL - no position in session`);
        console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      }
      this.markTradeSkipped(trade, config, 'No position in session');
      return;
    }

    // Get position - use minimum of API and local cache to be safe
    // (API may be stale after recent sells in same batch, cache may be stale from previous operations)
    const apiShares = await this.client.getPositionSize(trade.asset);
    const cachedShares = this.positionCache.get(trade.asset);

    let actualShares: number;
    if (cachedShares !== undefined) {
      // Use the smaller of API and cache (most conservative)
      actualShares = Math.min(apiShares, cachedShares);
    } else {
      actualShares = apiShares;
    }

    // Update cache with current known position
    this.positionCache.set(trade.asset, actualShares);

    if (actualShares <= 0) {
      if (verbose) {
        console.log(`\n${tradeLabel} ⏭️  SKIPPED SELL - no actual position`);
        console.log(`  Market: ${trade.title} - ${trade.outcome}`);
      }
      this.markTradeSkipped(trade, config, 'No actual position');
      return;
    }

    // Calculate their sell value in dollars
    const theirSellValue = trade.size * trade.price;

    // Calculate our proportional sell value
    let ourSellValue = (theirSellValue * config.copyPercentage) / 100;

    // Calculate actual position value at current price
    const actualPositionValue = actualShares * trade.price;

    // Cap at our ACTUAL position value (can't sell more than we have)
    const wasCapped = ourSellValue > actualPositionValue;
    if (wasCapped) {
      ourSellValue = actualPositionValue;
    }

    // No minimum for SELL - try to sell any amount, let API decide
    // This ensures we can exit small positions

    // Calculate shares to sell based on actual value and current price
    let sharesToSell = ourSellValue / trade.price;

    // Safety cap: never try to sell more than actual shares
    if (sharesToSell > actualShares) {
      sharesToSell = actualShares;
    }

    console.log(`\n${tradeLabel} 📉 SELL`);
    console.log(`  Market: ${trade.title} - ${trade.outcome}`);
    console.log(`  Trader: $${theirSellValue.toFixed(2)} (${trade.size.toFixed(2)} shares @ $${trade.price.toFixed(4)})`);
    console.log(`  Us: $${ourSellValue.toFixed(2)} (~${sharesToSell.toFixed(2)} shares)${wasCapped ? ' [capped to position]' : ''}`);
    console.log(`  Position: ${actualShares.toFixed(2)} shares (~$${actualPositionValue.toFixed(2)})`);

    const executedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.transactionHash,
      traderAddress: config.traderAddress,
      market: trade.title,
      assetId: trade.asset,
      side: 'SELL',
      originalSize: trade.size,
      executedSize: sharesToSell,
      price: trade.price,
      status: 'PENDING',
    };

    if (dryRun) {
      console.log('  [DRY RUN] Would execute this SELL');
      executedTrade.status = 'SUCCESS';
      executedTrade.orderId = 'dry-run';
    } else {
      try {
        // Execute SELL order via CLOB API (amount is in shares for SELL)
        const result = await this.client.placeMarketOrder({
          tokenId: trade.asset,
          side: 'SELL',
          amount: sharesToSell,
        });

        if (result.success && result.orderId) {
          executedTrade.status = 'SUCCESS';
          executedTrade.orderId = result.orderId;
          console.log(`  ✓ SELL executed! Order ID: ${result.orderId}`);

          // Update local position cache (deduct sold shares)
          const remainingShares = actualShares - sharesToSell;
          this.positionCache.set(trade.asset, Math.max(0, remainingShares));

          // Add proceeds back to budget if reinvest is enabled
          if (config.reinvest) {
            const proceeds = sharesToSell * trade.price;
            const newBudget = config.remainingBudget + proceeds;
            this.repository.updateBudget(config.id!, newBudget);
            config.remainingBudget = newBudget;
            console.log(`  💰 Added $${proceeds.toFixed(2)} back to budget (now $${newBudget.toFixed(2)})`);
          }
        } else {
          executedTrade.status = 'FAILED';
          executedTrade.errorMessage = result.errorMessage || 'SELL order failed';
          console.error(`  ✗ SELL failed: ${executedTrade.errorMessage}`);
        }
      } catch (error) {
        executedTrade.status = 'FAILED';
        executedTrade.errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ SELL failed: ${executedTrade.errorMessage}`);
      }
    }

    // Save executed trade to database
    this.saveTradeRecord(executedTrade);
  }

  private saveTradeRecord(executedTrade: ExecutedTrade): void {
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

  private markTradeSkipped(trade: PolymarketTrade, config: CopytradeConfig, reason: string): void {
    const skippedTrade: ExecutedTrade = {
      configId: config.id!,
      originalTradeId: trade.transactionHash,
      traderAddress: config.traderAddress,
      market: trade.title,
      assetId: trade.asset,
      side: trade.side,
      originalSize: trade.size,
      executedSize: 0,
      price: trade.price,
      status: 'SKIPPED',
      errorMessage: reason,
    };
    this.saveTradeRecord(skippedTrade);
  }

  private showExitSummary(configId: number): void {
    const config = this.repository.getConfig(configId);
    const trades = this.repository.getTradesByConfig(configId, 100);

    const successful = trades.filter(t => t.status === 'SUCCESS');
    const failed = trades.filter(t => t.status === 'FAILED');
    const buys = successful.filter(t => t.side === 'BUY');
    const sells = successful.filter(t => t.side === 'SELL');

    const totalBought = buys.reduce((sum, t) => sum + (t.executedSize * t.price), 0);
    const totalSold = sells.reduce((sum, t) => sum + (t.executedSize * t.price), 0);
    const netDeployed = totalBought - totalSold;

    // Calculate realized P&L for closed positions
    const realizedPnL = this.calculateRealizedPnL(successful);

    console.log('\n' + '='.repeat(50));
    console.log('📊 COPYTRADE SESSION SUMMARY');
    console.log('='.repeat(50));
    console.log(`  BUY trades executed: ${buys.length}`);
    console.log(`  SELL trades executed: ${sells.length}`);
    console.log(`  Trades failed: ${failed.length}`);
    console.log(`  Total bought: $${totalBought.toFixed(2)}`);
    console.log(`  Total sold: $${totalSold.toFixed(2)}`);
    console.log(`  Net deployed: $${netDeployed.toFixed(2)}`);
    console.log(`  Realized P&L: ${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toFixed(2)}`);
    console.log(`  Remaining budget: $${config?.remainingBudget.toFixed(2) || '0.00'}`);

    if (buys.length > 0) {
      console.log('\n  Markets entered:');
      const markets = [...new Set(buys.map(t => t.market))];
      markets.forEach(m => console.log(`    • ${m}`));
    }
    console.log('='.repeat(50) + '\n');
  }

  private calculateRealizedPnL(trades: ExecutedTrade[]): number {
    // Group trades by asset
    const byAsset = new Map<string, { buys: ExecutedTrade[]; sells: ExecutedTrade[] }>();

    for (const trade of trades) {
      if (!byAsset.has(trade.assetId)) {
        byAsset.set(trade.assetId, { buys: [], sells: [] });
      }
      const group = byAsset.get(trade.assetId)!;
      if (trade.side === 'BUY') {
        group.buys.push(trade);
      } else {
        group.sells.push(trade);
      }
    }

    let totalPnL = 0;

    // For each asset with sells, calculate realized P&L
    for (const [, group] of byAsset) {
      if (group.sells.length === 0) continue;

      // Calculate average buy price (weighted by shares)
      const totalBuyShares = group.buys.reduce((sum, t) => sum + t.executedSize, 0);
      const totalBuyCost = group.buys.reduce((sum, t) => sum + (t.executedSize * t.price), 0);
      const avgBuyPrice = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;

      // Calculate P&L for each sell
      for (const sell of group.sells) {
        const sellProceeds = sell.executedSize * sell.price;
        const costBasis = sell.executedSize * avgBuyPrice;
        const pnl = sellProceeds - costBasis;
        totalPnL += pnl;
      }
    }

    return totalPnL;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  stop(): void {
    this.isRunning = false;
  }
}
