import { PolymarketClient } from '../clients/polymarket.client';
import { AccountConfig } from '../types';

interface SetupResult {
  success: boolean;
  address?: string;
  apiKey?: string;
  isNewCredentials?: boolean;
  error?: string;
}

export class AccountService {
  async setupAccount(config: AccountConfig): Promise<SetupResult> {
    try {
      const client = new PolymarketClient(config);

      // Derive API credentials from the private key
      console.log('  Checking credentials...');
      const credentials = await client.deriveApiCredentials();

      if (credentials.isNew) {
        console.log('  Creating new credentials... ✓');
      } else {
        console.log('  Using existing credentials ✓');
      }

      // Verify the account can connect
      const isValid = await client.validateConnection();

      if (!isValid) {
        return {
          success: false,
          error: 'Failed to validate connection to Polymarket',
        };
      }

      // Check balance
      console.log('\nChecking balance...');
      const balance = await client.getBalance();

      // Set up token allowance
      console.log('\nSetting up token allowance...');
      const allowanceResult = await client.checkAndSetAllowance();

      if (!allowanceResult.success) {
        return {
          success: false,
          error: 'Failed to set token allowance (see above)',
        };
      }

      return {
        success: true,
        address: config.funderAddress,
        apiKey: credentials.apiKey,
        isNewCredentials: credentials.isNew,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getBalance(config: AccountConfig): Promise<number> {
    const client = new PolymarketClient(config);
    return client.getBalance();
  }
}
