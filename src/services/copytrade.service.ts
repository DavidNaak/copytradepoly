import { PolymarketClient } from '../clients/polymarket.client';
import { TradeRepository } from '../repositories/trade.repository';
import { AccountConfig, CopytradeConfig, PolymarketTrade, ExecutedTrade } from '../types';

// Polymarket minimum order size is $1
const MIN_ORDER_SIZE_USD = 1.0;

// Result of processing a trade
interface TradeResult {
  status: 'executed' | 'failed' | 'skipped';
  side: 'BUY' | 'SELL';
  market: string;
  outcome: string;
  amount?: number;
  skipReason?: string;
  errorMessage?: string;
  orderId?: string;
  budgetRemaining?: number;
  proceedsAdded?: number;
}

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
          const results: TradeResult[] = [];

          for (const trade of newTrades) {
            // Refresh budget from DB before each trade to ensure accurate tracking
            const freshConfig = this.repository.getConfig(configId);
            if (freshConfig) {
              savedConfig.remainingBudget = freshConfig.remainingBudget;
            }

            const result = await this.processTrade(trade, savedConfig, dryRun, allowAddToPosition, verbose);
            results.push(result);
          }

          // Display clean summary
          this.displayBatchResults(results, verbose);

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
    verbose: boolean
  ): Promise<TradeResult> {
    if (trade.side === 'BUY') {
      return this.processBuyTrade(trade, config, dryRun, allowAddToPosition, verbose);
    } else {
      return this.processSellTrade(trade, config, dryRun, verbose);
    }
  }

  private async processBuyTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean,
    allowAddToPosition: boolean,
    verbose: boolean
  ): Promise<TradeResult> {
    const baseResult = { side: 'BUY' as const, market: trade.title, outcome: trade.outcome };

    // Skip if we already have this position in THIS session (unless flag is set)
    if (!allowAddToPosition && this.repository.hasSessionPosition(config.id!, trade.asset)) {
      this.markTradeSkipped(trade, config, 'Already hold position');
      return { ...baseResult, status: 'skipped', skipReason: 'already hold position' };
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
        this.markTradeSkipped(trade, config, 'No budget');
        return { ...baseResult, status: 'skipped', skipReason: 'no budget' };
      }
      tradeAmount = config.remainingBudget;
    }

    if (tradeAmount <= 0) {
      this.markTradeSkipped(trade, config, 'Trade amount too small');
      return { ...baseResult, status: 'skipped', skipReason: 'amount too small' };
    }

    // Check against Polymarket minimum order size ($1)
    if (tradeAmount < MIN_ORDER_SIZE_USD) {
      this.markTradeSkipped(trade, config, 'Below $1 minimum');
      return { ...baseResult, status: 'skipped', skipReason: 'below $1 minimum' };
    }

    // Estimate shares we'll get (actual may vary based on market)
    const estimatedShares = tradeAmount / price;

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
      executedTrade.status = 'SUCCESS';
      executedTrade.orderId = 'dry-run';
      this.saveTradeRecord(executedTrade);
      return { ...baseResult, status: 'executed', amount: tradeAmount, orderId: 'dry-run', budgetRemaining: config.remainingBudget };
    }

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

        // Update remaining budget in DB and in-memory
        const newBudget = config.remainingBudget - tradeAmount;
        this.repository.updateBudget(config.id!, newBudget);
        config.remainingBudget = newBudget;

        this.saveTradeRecord(executedTrade);
        return { ...baseResult, status: 'executed', amount: tradeAmount, orderId: result.orderId, budgetRemaining: newBudget };
      } else {
        executedTrade.status = 'FAILED';
        executedTrade.errorMessage = result.errorMessage || 'Order failed';
        this.saveTradeRecord(executedTrade);
        return { ...baseResult, status: 'failed', amount: tradeAmount, errorMessage: executedTrade.errorMessage };
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if it's a balance/allowance error - stop gracefully
      if (errorMsg.includes('not enough balance') || errorMsg.includes('allowance')) {
        console.error(`\n🛑 Stopping: Insufficient balance or allowance`);
        this.isRunning = false;
        return { ...baseResult, status: 'failed', errorMessage: 'Insufficient balance - stopping' };
      }

      executedTrade.status = 'FAILED';
      executedTrade.errorMessage = errorMsg;
      this.saveTradeRecord(executedTrade);
      return { ...baseResult, status: 'failed', amount: tradeAmount, errorMessage: errorMsg };
    }
  }

  private async processSellTrade(
    trade: PolymarketTrade,
    config: CopytradeConfig,
    dryRun: boolean,
    verbose: boolean
  ): Promise<TradeResult> {
    const baseResult = { side: 'SELL' as const, market: trade.title, outcome: trade.outcome };

    // Check if we have a position to sell in THIS session (for tracking)
    const sessionPosition = this.repository.getSessionPosition(config.id!, trade.asset);

    if (sessionPosition.shares <= 0) {
      this.markTradeSkipped(trade, config, 'No position in session');
      return { ...baseResult, status: 'skipped', skipReason: 'no position' };
    }

    // Get position - use minimum of API and local cache to be safe
    const apiShares = await this.client.getPositionSize(trade.asset);
    const cachedShares = this.positionCache.get(trade.asset);

    let actualShares: number;
    if (cachedShares !== undefined) {
      actualShares = Math.min(apiShares, cachedShares);
    } else {
      actualShares = apiShares;
    }

    this.positionCache.set(trade.asset, actualShares);

    if (actualShares <= 0) {
      this.markTradeSkipped(trade, config, 'No actual position');
      return { ...baseResult, status: 'skipped', skipReason: 'no position' };
    }

    // Calculate sell amounts
    const theirSellValue = trade.size * trade.price;
    let ourSellValue = (theirSellValue * config.copyPercentage) / 100;
    const actualPositionValue = actualShares * trade.price;

    if (ourSellValue > actualPositionValue) {
      ourSellValue = actualPositionValue;
    }

    let sharesToSell = ourSellValue / trade.price;
    if (sharesToSell > actualShares) {
      sharesToSell = actualShares;
    }

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
      executedTrade.status = 'SUCCESS';
      executedTrade.orderId = 'dry-run';
      this.saveTradeRecord(executedTrade);
      return { ...baseResult, status: 'executed', amount: ourSellValue, orderId: 'dry-run' };
    }

    try {
      const result = await this.client.placeMarketOrder({
        tokenId: trade.asset,
        side: 'SELL',
        amount: sharesToSell,
      });

      if (result.success && result.orderId) {
        executedTrade.status = 'SUCCESS';
        executedTrade.orderId = result.orderId;

        // Update local position cache
        const remainingShares = actualShares - sharesToSell;
        this.positionCache.set(trade.asset, Math.max(0, remainingShares));

        let proceedsAdded: number | undefined;
        if (config.reinvest) {
          const proceeds = sharesToSell * trade.price;
          const newBudget = config.remainingBudget + proceeds;
          this.repository.updateBudget(config.id!, newBudget);
          config.remainingBudget = newBudget;
          proceedsAdded = proceeds;
        }

        this.saveTradeRecord(executedTrade);
        return { ...baseResult, status: 'executed', amount: ourSellValue, orderId: result.orderId, proceedsAdded, budgetRemaining: config.remainingBudget };
      } else {
        executedTrade.status = 'FAILED';
        executedTrade.errorMessage = result.errorMessage || 'SELL order failed';
        this.saveTradeRecord(executedTrade);
        return { ...baseResult, status: 'failed', amount: ourSellValue, errorMessage: executedTrade.errorMessage };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      executedTrade.status = 'FAILED';
      executedTrade.errorMessage = errorMsg;
      this.saveTradeRecord(executedTrade);
      return { ...baseResult, status: 'failed', amount: ourSellValue, errorMessage: errorMsg };
    }
  }

  private saveTradeRecord(executedTrade: ExecutedTrade): void {
    try {
      this.repository.saveTrade(executedTrade);
    } catch (error) {
      // Silently ignore duplicate constraint errors
      if (!(error instanceof Error && error.message.includes('UNIQUE constraint'))) {
        throw error;
      }
    }
  }

  private displayBatchResults(results: TradeResult[], verbose: boolean): void {
    const executed = results.filter(r => r.status === 'executed');
    const failed = results.filter(r => r.status === 'failed');
    const skipped = results.filter(r => r.status === 'skipped');

    // Don't show anything if all trades were skipped (unless verbose)
    if (executed.length === 0 && failed.length === 0 && !verbose) {
      return;
    }

    console.log(`\n${'─'.repeat(50)}`);

    // Show executed trades
    for (const result of executed) {
      const icon = result.side === 'BUY' ? '📈' : '📉';
      const shortMarket = result.market.length > 40 ? result.market.substring(0, 40) + '...' : result.market;
      console.log(`✓ ${icon} ${result.side} $${result.amount?.toFixed(2)} - ${shortMarket}`);

      if (result.side === 'BUY' && result.budgetRemaining !== undefined) {
        console.log(`  Budget: $${result.budgetRemaining.toFixed(2)}`);
      }
      if (result.side === 'SELL' && result.proceedsAdded !== undefined) {
        console.log(`  💰 +$${result.proceedsAdded.toFixed(2)} to budget ($${result.budgetRemaining?.toFixed(2)})`);
      }
    }

    // Show failed trades
    for (const result of failed) {
      const icon = result.side === 'BUY' ? '📈' : '📉';
      const shortMarket = result.market.length > 40 ? result.market.substring(0, 40) + '...' : result.market;
      console.log(`✗ ${icon} ${result.side} $${result.amount?.toFixed(2)} - ${shortMarket}`);
      console.log(`  Error: ${result.errorMessage}`);
    }

    // Show skipped summary (grouped by reason)
    if (skipped.length > 0) {
      const byReason = new Map<string, { count: number; side: string }>();
      for (const s of skipped) {
        const key = `${s.side}:${s.skipReason}`;
        const existing = byReason.get(key) || { count: 0, side: s.side };
        existing.count++;
        byReason.set(key, existing);
      }

      const parts: string[] = [];
      for (const [key, value] of byReason) {
        const reason = key.split(':')[1];
        parts.push(`${value.count} ${value.side.toLowerCase()}${value.count > 1 ? 's' : ''} (${reason})`);
      }
      console.log(`  Skipped: ${parts.join(', ')}`);
    }

    console.log(`${'─'.repeat(50)}`);
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
