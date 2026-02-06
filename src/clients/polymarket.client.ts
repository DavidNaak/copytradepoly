import { ClobClient, Side } from '@polymarket/clob-client';
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

    this.credentials = {
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    };

    // Now create the full client with credentials
    this.clobClient = new ClobClient(
      host,
      chainId,
      wallet,
      creds // Use the original creds object which has the right type
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
    } catch (error) {
      console.error('Error fetching trades:', error);
      return [];
    }
  }

  async placeMarketOrder(order: OrderRequest): Promise<OrderResult> {
    if (!this.clobClient) {
      await this.deriveApiCredentials();
    }

    try {
      // For market orders, we need to get the current best price first
      // and then place a limit order at that price (or slightly worse to ensure fill)
      const orderBook = await this.clobClient!.getOrderBook(order.tokenId);

      // Get the best ask price for buy orders
      let price: number;
      const side = order.side === 'BUY' ? Side.BUY : Side.SELL;

      if (order.side === 'BUY') {
        // For buys, we take from the asks (sellers)
        const bestAsk = orderBook.asks?.[0];
        if (!bestAsk) {
          throw new Error('No asks available in order book');
        }
        price = parseFloat(bestAsk.price);
        // Add a small buffer to ensure fill (max 0.99 per Polymarket rules)
        price = Math.min(price * 1.01, 0.99);
      } else {
        // For sells, we take from the bids (buyers)
        const bestBid = orderBook.bids?.[0];
        if (!bestBid) {
          throw new Error('No bids available in order book');
        }
        price = parseFloat(bestBid.price);
        // Subtract a small buffer to ensure fill (min 0.001 per Polymarket rules)
        price = Math.max(price * 0.99, 0.001);
      }

      // Create and sign the order
      const signedOrder = await this.clobClient!.createOrder({
        tokenID: order.tokenId,
        price: price,
        size: order.size,
        side: side,
      });

      // Submit the order
      const response = await this.clobClient!.postOrder(signedOrder);

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
}
