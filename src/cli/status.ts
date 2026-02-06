import { Command } from 'commander';
import { TradeRepository } from '../repositories/trade.repository';

export const statusCommand = new Command('status')
  .description('View copytrading status and trade history')
  .option('-c, --config-id <id>', 'Show trades for a specific config', parseInt)
  .option('-l, --limit <count>', 'Number of recent trades to show', parseInt, 10)
  .action(async (options) => {
    try {
      const repository = new TradeRepository();

      // Show active configs
      const configs = repository.getActiveConfigs();

      console.log('\n📊 Copytrading Status\n');
      console.log('Active Configurations:');

      if (configs.length === 0) {
        console.log('  No active copytrading configurations.\n');
      } else {
        configs.forEach((config) => {
          console.log(`  [${config.id}] Trader: ${config.traderAddress.slice(0, 10)}...`);
          console.log(`      Budget: $${config.remainingBudget.toFixed(2)} / $${config.budget.toFixed(2)} remaining`);
          console.log(`      Copy: ${config.copyPercentage}% | Max: $${config.maxTradeSize}`);
          console.log('');
        });
      }

      // Show recent trades
      const trades = options.configId
        ? repository.getTradesByConfig(options.configId, options.limit)
        : repository.getRecentTrades(options.limit);

      console.log(`Recent Trades (last ${options.limit}):`);

      if (trades.length === 0) {
        console.log('  No trades executed yet.\n');
      } else {
        trades.forEach((trade) => {
          const statusIcon = trade.status === 'SUCCESS' ? '✓' : trade.status === 'FAILED' ? '✗' : '⏳';
          console.log(`  ${statusIcon} ${trade.side} $${trade.executedSize.toFixed(2)} @ ${trade.price.toFixed(4)}`);
          console.log(`    Market: ${trade.market.slice(0, 20)}...`);
          console.log(`    Time: ${trade.createdAt}`);
          if (trade.errorMessage) {
            console.log(`    Error: ${trade.errorMessage}`);
          }
          console.log('');
        });
      }

    } catch (error) {
      console.error('Status check failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
