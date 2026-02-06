import { ClobClient, Side, AssetType } from '@polymarket/clob-client';
import { Wallet, Contract, providers } from 'ethers';
import { AccountConfig, PolymarketTrade, OrderRequest } from '../types';

const CLOB_API_URL = process.env.CLOB_API_URL || 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';
const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';

// Detect wallet type (EOA vs Proxy) by checking if address has contract code
async function detectWalletType(address: string): Promise<{ type: 0 | 2; name: string }> {
  const provider = new providers.JsonRpcProvider(POLYGON_RPC);
  const code = await provider.getCode(address);

  // No code = EOA
  if (code === '0x') {
    return { type: 0, name: 'EOA (direct wallet)' };
  }

  // EIP-7702 delegation indicator (0xef01) = EOA with delegation, treat as EOA
  if (code.startsWith('0xef01')) {
    return { type: 0, name: 'EOA (direct wallet)' };
  }

  // Has contract code = Proxy wallet (Gnosis Safe)
  return { type: 2, name: 'Proxy wallet' };
}

// Retry helper for RPC operations that may hit rate limits
async function withRetry<T>(
  fn: () => Promise<T>,
  operationName: string,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit =
        error.message?.includes('rate limit') ||
        error.message?.includes('Too many requests') ||
        error.code === -32090 ||
        error.code === 'SERVER_ERROR';

      if (attempt < maxRetries && isRateLimit) {
        const delay = 2000 * attempt; // 2s, 4s, 6s
        console.log(`  ⚠️  Rate limited, retrying ${operationName} in ${delay / 1000}s... (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`${operationName} failed after ${maxRetries} retries`);
}

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
  private signatureType: 0 | 2 = 0; // 0 = EOA, 2 = Proxy wallet

  constructor(config: AccountConfig) {
    this.config = config;
  }

  async deriveApiCredentials(): Promise<ApiCredentials & { isNew: boolean }> {
    // Create a wallet from the private key
    const wallet = new Wallet(this.config.privateKey);

    // Initialize CLOB client to derive/create API credentials
    const host = CLOB_API_URL;
    const chainId = 137; // Polygon mainnet

    // First, create the client without credentials to derive them
    const tempClient = new ClobClient(host, chainId, wallet);

    // Suppress the library's noisy error logging during credential derivation
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    let wasCreated = true; // Assume new unless we see the "already exists" error

    console.log = (...args: any[]) => {
      const msg = args.join(' ');
      if (msg.includes('[CLOB Client]')) return; // Suppress library logs
      originalConsoleLog.apply(console, args);
    };
    console.error = (...args: any[]) => {
      const msg = args.join(' ');
      if (msg.includes('[CLOB Client]') || msg.includes('Could not create api key')) {
        wasCreated = false; // Key already exists, we're deriving
        return;
      }
      originalConsoleError.apply(console, args);
    };

    let creds;
    try {
      creds = await tempClient.createOrDeriveApiKey();
    } finally {
      // Restore console functions
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }

    if (!creds || !creds.key) {
      throw new Error('Failed to derive API credentials. Make sure you have enabled trading on polymarket.com with this wallet first.');
    }

    this.credentials = {
      apiKey: creds.key,
      apiSecret: creds.secret,
      apiPassphrase: creds.passphrase,
    };

    // Auto-detect wallet type from funder address
    // Type 0 = EOA (direct wallet like MetaMask) - pays gas, needs approvals
    // Type 2 = Proxy wallet (Gnosis Safe via Polymarket.com) - no approvals needed
    const walletInfo = await detectWalletType(this.config.funderAddress);
    this.signatureType = walletInfo.type;
    console.log(`  Wallet type: ${walletInfo.name}`);

    // Now create the full client with credentials, signature type, and funder
    this.clobClient = new ClobClient(
      host,
      chainId,
      wallet,
      creds,
      this.signatureType,
      this.config.funderAddress
    );

    return { ...this.credentials, isNew: wasCreated };
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

      // Check POL (native token for gas) with retry
      const polBalance = await withRetry(
        () => provider.getBalance(this.config.funderAddress),
        'check POL balance'
      );
      const polAmount = parseFloat(polBalance.toString()) / 1e18;

      // Check USDC.e (bridged) - this is what Polymarket uses
      const usdcEContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, provider);
      const [usdcEBalance, usdcEDecimals] = await withRetry(
        () => Promise.all([
          usdcEContract.balanceOf(this.config.funderAddress),
          usdcEContract.decimals(),
        ]),
        'check USDC.e balance'
      );
      const usdcEAmount = parseFloat(usdcEBalance.toString()) / Math.pow(10, usdcEDecimals);

      // Also check native USDC in case user sent the wrong one
      const usdcNativeContract = new Contract(USDC_NATIVE_ADDRESS, ERC20_ABI, provider);
      const [usdcNativeBalance, usdcNativeDecimals] = await withRetry(
        () => Promise.all([
          usdcNativeContract.balanceOf(this.config.funderAddress),
          usdcNativeContract.decimals(),
        ]),
        'check native USDC balance'
      );
      const usdcNativeAmount = parseFloat(usdcNativeBalance.toString()) / Math.pow(10, usdcNativeDecimals);

      // Display balances
      console.log(`  USDC.e: $${usdcEAmount.toFixed(2)}`);
      // Only show POL balance for EOA wallets (they pay gas directly)
      if (this.signatureType === 0) {
        console.log(`  POL (gas): ${polAmount.toFixed(4)} POL`);
      }

      // Warnings - POL warning only for EOA wallets
      if (this.signatureType === 0 && polAmount < 0.01) {
        console.log(`\n  ⚠️  Low POL balance! You need POL for gas fees on Polygon.`);
      }

      if (usdcNativeAmount > 0 && usdcEAmount === 0) {
        console.log(`\n  ⚠️  You have $${usdcNativeAmount.toFixed(2)} native USDC, but Polymarket uses USDC.e (bridged)`);
        console.log(`  ⚠️  Swap native USDC to USDC.e on a DEX like Uniswap/QuickSwap`);
      }

      if (usdcEAmount === 0) {
        console.log(`\n  ⚠️  No USDC.e balance. Deposit USDC.e to start trading.`);
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
      // Get balance from CLOB API (works for both EOA and proxy wallets)
      const balanceAllowance = await this.clobClient!.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL
      });
      // CLOB API returns balance in micro-units (6 decimals for USDC)
      const balanceRaw = parseFloat(balanceAllowance.balance || '0');
      const balance = balanceRaw / 1_000_000;

      // Proxy wallets don't need token approvals - they handle this internally
      if (this.signatureType === 2) {
        console.log('  ✓ Proxy wallet - no approvals needed');
        return { success: true, balance };
      }

      // API returns allowances as object with contract addresses as keys
      const apiAllowances = (balanceAllowance as any).allowances || {};

      // Find which contracts need approval based on API data
      const contractsNeedingApproval = EXCHANGE_CONTRACTS.filter(
        contract => apiAllowances[contract.address] === '0' || !apiAllowances[contract.address]
      );

      if (contractsNeedingApproval.length > 0) {
        console.log('  Setting USDC.e approvals for Polymarket...\n');

        const provider = new providers.JsonRpcProvider(POLYGON_RPC);
        const wallet = new Wallet(this.config.privateKey, provider);
        const usdcContract = new Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);
        const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

        // Get current gas price with retry (RPC call)
        const feeData = await withRetry(
          () => provider.getFeeData(),
          'get gas price'
        );
        const gasPrice = feeData.gasPrice?.mul(2) || '50000000000'; // 50 gwei fallback

        for (const contract of contractsNeedingApproval) {
          process.stdout.write(`  Approving ${contract.name}...`);
          // Wrap approval in retry logic
          await withRetry(async () => {
            const tx = await usdcContract.approve(contract.address, MAX_UINT256, { gasPrice });
            await tx.wait();
          }, `approve ${contract.name}`);
          console.log(' ✓');
        }

        // Show final status with newly approved ones marked
        console.log('');
        for (const contract of EXCHANGE_CONTRACTS) {
          const wasJustApproved = contractsNeedingApproval.some(c => c.address === contract.address);
          if (wasJustApproved) {
            console.log(`  ✓ ${contract.name} approved`);
          } else {
            console.log(`  ✓ ${contract.name} (already approved)`);
          }
        }
      } else {
        // All already approved - show status
        for (const contract of EXCHANGE_CONTRACTS) {
          console.log(`  ✓ ${contract.name} (already approved)`);
        }
      }

      return { success: true, balance };
    } catch (error) {
      console.error('Allowance check/set error:', error);
      return { success: false, balance: 0 };
    }
  }
}
