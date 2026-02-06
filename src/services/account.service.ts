import { PolymarketClient } from '../clients/polymarket.client';
import { AccountConfig } from '../types';

interface SetupResult {
  success: boolean;
  address?: string;
  apiKey?: string;
  error?: string;
}

export class AccountService {
  async setupAccount(config: AccountConfig): Promise<SetupResult> {
    try {
      const client = new PolymarketClient(config);

      // Derive API credentials from the private key
      const credentials = await client.deriveApiCredentials();

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
      const allowanceSet = await client.checkAndSetAllowance();

      if (!allowanceSet) {
        return {
          success: false,
          error: 'Failed to set token allowance',
        };
      }

      return {
        success: true,
        address: config.funderAddress,
        apiKey: credentials.apiKey,
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
