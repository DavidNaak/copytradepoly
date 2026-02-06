import { Command } from 'commander';
import { CopytradeService } from '../services/copytrade.service';
import { PolymarketClient } from '../clients/polymarket.client';
import { CopytradeConfig } from '../types';

export const copytradeCommand = new Command('copytrade')
  .description('Start copytrading a target wallet')
  .requiredOption('-t, --trader <address>', 'Wallet address of the trader to copy')
  .requiredOption('-b, --budget <amount>', 'Total budget for copytrading (in USDC)', parseFloat)
  .requiredOption('-p, --percentage <percent>', 'Copy percentage (e.g., 10 = 10% of their trade size)', parseFloat)
  .requiredOption('-m, --max-trade <amount>', 'Maximum amount per individual trade', parseFloat)
  .option('--dry-run', 'Simulate trades without executing', false)
  .option('-v, --verbose', 'Show detailed polling activity', false)
  .option('--allow-add-to-position', 'Allow buying more of positions you already hold', false)
  .option('--no-reinvest', 'Do not add sell proceeds back to budget')
  .action(async (options) => {
    try {
      const privateKey = process.env.PRIVATE_KEY;
      const funderAddress = process.env.FUNDER_ADDRESS;

      if (!privateKey || !funderAddress) {
        console.error('Error: PRIVATE_KEY and FUNDER_ADDRESS must be set in .env');
        console.error('Run "copytrader setup-account" first.');
        process.exit(1);
      }

      // Validate inputs
      if (options.budget <= 0) {
        console.error('Error: Budget must be greater than 0');
        process.exit(1);
      }

      if (options.percentage <= 0 || options.percentage > 100) {
        console.error('Error: Percentage must be between 0 and 100');
        process.exit(1);
      }

      if (options.maxTrade <= 0) {
        console.error('Error: Max trade size must be greater than 0');
        process.exit(1);
      }

      // Check allowance and get balance from Polymarket API
      console.log('\nChecking wallet balance and allowance...');
      console.log(`  Wallet Address: ${funderAddress}`);
      const client = new PolymarketClient({ privateKey, funderAddress });
      const { success: allowanceOk, balance } = await client.checkAndSetAllowance();
      console.log(`  USDC Balance: $${balance.toFixed(2)}`);

      if (!allowanceOk) {
        console.error('\nError: Failed to verify/set token allowance.');
        console.error('Run "copytrader setup-account" to initialize your account.');
        process.exit(1);
      }

      if (balance < options.budget) {
        console.error(`\nError: Insufficient balance. You have $${balance.toFixed(2)} but requested $${options.budget} budget.`);
        console.error('Either reduce your budget or add funds to your wallet.');
        process.exit(1);
      }

      const config: CopytradeConfig = {
        traderAddress: options.trader,
        budget: options.budget,
        remainingBudget: options.budget,
        copyPercentage: options.percentage,
        maxTradeSize: options.maxTrade,
        isActive: true,
        reinvest: options.reinvest !== false,  // Default true, --no-reinvest sets false
      };

      console.log('\n🔄 Starting copytrading...');
      console.log(`  Trader: ${config.traderAddress}`);
      console.log(`  Budget: $${config.budget}`);
      console.log(`  Copy %: ${config.copyPercentage}%`);
      console.log(`  Max Trade: $${config.maxTradeSize}`);
      console.log(`  Dry Run: ${options.dryRun ? 'Yes' : 'No'}`);
      console.log(`  Verbose: ${options.verbose ? 'Yes' : 'No'}`);
      console.log(`  Allow Add to Position: ${options.allowAddToPosition ? 'Yes' : 'No'}`);
      console.log(`  Reinvest Proceeds: ${config.reinvest ? 'Yes' : 'No'}`);
      console.log('\nMonitoring for new trades... (Press Ctrl+C to stop)\n');

      const copytradeService = new CopytradeService({
        privateKey,
        funderAddress,
      });

      await copytradeService.start(config, options.dryRun, options.verbose, options.allowAddToPosition);

    } catch (error) {
      console.error('Copytrade failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
