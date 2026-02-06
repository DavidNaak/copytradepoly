import { ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { AccountConfig, PolymarketTrade, OrderRequest } from '../types';

const CLOB_API_URL = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';

interface ApiCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

interface OrderResult {
  orderId: string;
  success: boolean;
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
    // Get USDC balance from the wallet
    // This would typically query the Polygon chain for USDC balance
    // For now, return a placeholder
    // TODO: Implement actual balance check
    return 0;
  }

  async getTradesForAddress(address: string): Promise<PolymarketTrade[]> {
    try {
      // Use the Data API to get trades for a specific address
      const url = `${DATA_API_URL}/trades?user=${address}&limit=100`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch trades: ${response.statusText}`);
      }

      const trades = await response.json();
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
        // Add a small buffer to ensure fill
        price = Math.min(price * 1.01, 1.0);
      } else {
        // For sells, we take from the bids (buyers)
        const bestBid = orderBook.bids?.[0];
        if (!bestBid) {
          throw new Error('No bids available in order book');
        }
        price = parseFloat(bestBid.price);
        // Subtract a small buffer to ensure fill
        price = Math.max(price * 0.99, 0.01);
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

      return {
        orderId: response.orderID || 'unknown',
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
