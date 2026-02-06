import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { Wallet, Contract, providers } from 'ethers';
import { AccountConfig, PolymarketTrade, OrderRequest } from '../types';

const CLOB_API_URL = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';
const POLYGON_RPC = 'https://polygon-rpc.com';

// USDC tokens on Polygon
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged) - used by Polymarket
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Polymarket exchange contracts that need USDC.e approval
const EXCHANGE_CONTRACTS = [
  { address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', name: 'CTF Exchange' },
  { address: '0xC5d563A36AE78145C45a50134d48A1215220f80a', name: 'Neg Risk CTF Exchange' },
  { address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296', name: 'Neg Risk Adapter' },
];

interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

interface OrderResult {
  orderId: string;
  success: boolean;
  errorMessage?: string;
}

export class PolymarketClient {
  private config: AccountConfig;
  private clobClient: ClobClient | null = null;
  private credentials: ApiCredentials | null = null;

  constructor(config: AccountConfig) {
    this.config = config;
  }

  async deriveApiCredentials(): Promise<ApiCredentials> {
    // Create a wallet from the private key
    const wallet = new Wallet(this.config.privateKey);

    // Initialize CLOB client to derive/create API credentials
    const host = CLOB_API_URL;
    const chainId = 137; // Polygon mainnet

    // First, create the client without credentials to derive them
    const tempClient = new ClobClient(host, chainId, wallet);

    // Derive API credentials
    const creds = await tempClient.createOrDeriveApiKey();

    if (!creds || !creds.key) {
      throw new Error('Failed to derive API credentials. Make sure you have enabled trading on polymarket.com with this wallet first.');
    }

    this.credentials = {
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    };

    // Signature type 0 = EOA (direct wallet like MetaMask)
    // Signature type 1 = POLY_PROXY (Magic Link/email login)
    // Signature type 2 = GNOSIS_SAFE (browser wallet connection via Polymarket.com)
    const signatureType = 0; // EOA for direct private key usage

    // Now create the full client with credentials, signature type, and funder
    this.clobClient = new ClobClient(
      host,
      chainId,
      wallet,
      creds,
      signatureType,
      this.config.funderAddress
    );

    return this.credentials;
  }

  async validateConnection(): Promise<boolean> {
    try {
      if (!this.clobClient) {
        await this.deriveApiCredentials();
      }

      // Try to get the API key info to validate connection
      const apiKeys = await this.clobClient!.getApiKeys();
      return apiKeys !== null && typeof apiKeys === 'object';
    } catch (error) {
      console.error('Validation error:', error);
      return false;
    }
  }

  async getBalance(): Promise<number> {
    try {
      const provider = new providers.JsonRpcProvider(POLYGON_RPC);

      // Check POL (native token for gas)
      const polBalance = await provider.getBalance(this.config.funderAddress);
      const polAmount = parseFloat(polBalance.toString()) / 1e18;
      if (polAmount < 0.01) {
        console.log(`  ⚠️  Warning: Low POL balance (${polAmount.toFixed(4)} POL). You need POL for gas fees on Polygon.`);
      }

      // Check USDC.e (bridged) - this is what Polymarket uses
      const usdcEContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
      const usdcEBalance = await usdcEContract.balanceOf(this.config.funderAddress);
      const usdcEDecimals = await usdcEContract.decimals();
      const usdcEAmount = parseFloat(usdcEBalance.toString()) / Math.pow(10, usdcEDecimals);

      // Also check native USDC in case user sent the wrong one
      const usdcNativeContract = new Contract(USDC_NATIVE_ADDRESS, ERC20_ABI, provider);
      const usdcNativeBalance = await usdcNativeContract.balanceOf(this.config.funderAddress);
      const usdcNativeDecimals = await usdcNativeContract.decimals();
      const usdcNativeAmount = parseFloat(usdcNativeBalance.toString()) / Math.pow(10, usdcNativeDecimals);

      if (usdcNativeAmount > 0 && usdcEAmount === 0) {
        console.log(`  ⚠️  Warning: You have $${usdcNativeAmount.toFixed(2)} native USDC, but Polymarket uses USDC.e (bridged)`);
        console.log(`  ⚠️  Swap native USDC to USDC.e on a DEX like Uniswap/QuickSwap`);
      }

      // Return USDC.e balance (what Polymarket uses)
      return usdcEAmount;
    } catch (error) {
      console.error('Error fetching balance:', error);
      return 0;
    }
  }

  async getTradesForAddress(address: string): Promise<PolymarketTrade[]> {
    try {
      // Use the /activity endpoint - it has real-time data (unlike /trades which is delayed)
      const url = `${DATA_API_URL}/activity?user=${address}&limit=100`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch activity: ${response.statusText}`);
      }

      const activities = (await response.json()) as any[];

      // Filter to only TRADE type activities and map to our format
      const trades = activities
        .filter((a: any) => a.type === 'TRADE')
        .map((a: any) => ({
          proxyWallet: a.proxyWallet,
          side: a.side,
          asset: a.asset,
          conditionId: a.conditionId,
          size: a.size,
          price: a.price,
          timestamp: a.timestamp,
          title: a.title,
          slug: a.slug,
          icon: a.icon,
          eventSlug: a.eventSlug,
          outcome: a.outcome,
          outcomeIndex: a.outcomeIndex,
          name: a.name,
          pseudonym: a.pseudonym,
          transactionHash: a.transactionHash,
        }));

      return trades as PolymarketTrade[];
    } catch (error: any) {
      // Clean error messages for common network issues
      if (error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.log('  ⚠️  Network timeout fetching trades (will retry next poll)');
      } else if (error?.cause?.code === 'ENOTFOUND' || error?.cause?.code === 'ECONNREFUSED') {
        console.log('  ⚠️  Network error - cannot reach Polymarket API (will retry)');
      } else if (error.message?.includes('fetch failed')) {
        console.log('  ⚠️  Network error fetching trades (will retry next poll)');
      } else {
        console.error('Error fetching trades:', error.message || error);
      }
      return [];
    }
  }

  async placeMarketOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.clobClient) {
      await this.deriveApiCredentials();
    }

    try {
      const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

      // Use createMarketOrder which accepts dollar amounts for BUY orders
      // This is the proper way to place market orders on Polymarket
      const signedOrder = await this.clobClient!.createMarketOrder({
        tokenID: order.tokenId,
        amount: order.amount, // Dollar amount for BUY orders
        side: side,
      });

      // Submit the order as FOK (Fill or Kill)
      const response = await this.clobClient!.postOrder(signedOrder, 'FOK' as any);

      // Verify we got a valid order ID back
      if (!response.orderID) {
        return {
          orderId: '',
          success: false,
          errorMessage: 'No order ID returned from API',
        };
      }

      return {
        orderId: response.orderID,
        success: true,
      };
    } catch (error) {
      console.error('Order placement error:', error);
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.clobClient) {
      await this.deriveApiCredentials();
    }

    try {
      await this.clobClient!.cancelOrder({ orderID: orderId });
      return true;
    } catch (error) {
      console.error('Cancel order error:', error);
      return false;
    }
  }

  async checkAndSetAllowance(): Promise<{ success: boolean; balance: number }> {
    if (!this.clobClient) {
      await this.deriveApiCredentials();
    }

    try {
      // Check current allowance from API
      const balanceAllowance = await this.clobClient!.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL
      });
      const balance = parseFloat(balanceAllowance.balance || '0');

      // Check if any exchange contract needs approval
      const provider = new providers.JsonRpcProvider(POLYGON_RPC);
      const wallet = new Wallet(this.config.privateKey, provider);
      const usdcContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);

      // Max uint256 for unlimited approval
      const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      // Check which contracts need approval
      const contractsNeedingApproval: typeof EXCHANGE_CONTRACTS = [];
      for (const contract of EXCHANGE_CONTRACTS) {
        const currentAllowance = await usdcContract.allowance(this.config.funderAddress, contract.address);
        if (currentAllowance.toString() === '0') {
          contractsNeedingApproval.push(contract);
        }
      }

      if (contractsNeedingApproval.length > 0) {
        console.log('  Setting USDC.e approvals for Polymarket...\n');

        // Get current gas price and add buffer for Polygon
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice?.mul(2) || '50000000000'; // 50 gwei fallback

        for (const contract of contractsNeedingApproval) {
          process.stdout.write(`  Approving ${contract.name}...`);
          const tx = await usdcContract.approve(contract.address, MAX_UINT256, { gasPrice });
          await tx.wait();
          console.log(' ✓');
        }

        console.log('\n  All approvals complete!');
      } else {
        // All already approved - show status
        for (const contract of EXCHANGE_CONTRACTS) {
          console.log(`  ✓ ${contract.name} approved`);
        }
      }

      return { success: true, balance };
    } catch (error) {
      console.error('Allowance check/set error:', error);
      return { success: false, balance: 0 };
    }
  }
}
