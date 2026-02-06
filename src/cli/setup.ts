import { Command } from 'commander';
import { AccountService } from '../services/account.service';

export const setupAccountCommand = new Command('setup-account')
  .description('Initialize and validate your Polymarket account connection')
  .option('-k, --private-key <key>', 'Your wallet private key')
  .option('-a, --address <address>', 'Your wallet (funder) address')
  .action(async (options) => {
    try {
      const privateKey = options.privateKey || process.env.PRIVATE_KEY;
      const address = options.address || process.env.FUNDER_ADDRESS;

      if (!privateKey || !address) {
        console.error('Error: Private key and address are required.');
        console.error('Provide via --private-key and --address flags, or set PRIVATE_KEY and FUNDER_ADDRESS in .env');
        process.exit(1);
      }

      console.log('Setting up account...');

      const accountService = new AccountService();
      const result = await accountService.setupAccount({
        privateKey,
        funderAddress: address,
      });

      if (result.success) {
        console.log('\n✓ Account setup successful!');
        console.log(`  Address: ${result.address}`);
        console.log(`  API Key: ${result.apiKey ? 'Generated' : 'Using existing'}`);
        console.log('\nYou can now start copytrading with: copytrader copytrade --help');
      } else {
        console.error('\n✗ Account setup failed:', result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error('Setup failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
