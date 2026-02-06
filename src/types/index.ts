// Account types
export interface AccountConfig {
  privateKey: string;
  funderAddress: string;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

// Copytrading configuration
export interface CopytradeConfig {
  id?: number;
  traderAddress: string;
  budget: number;
  remainingBudget: number;
  copyPercentage: number;
  maxTradeSize: number;
  isActive: boolean;
  reinvest: boolean;  // Whether to add sell proceeds back to budget
  createdAt?: string;
}

// Trade from Polymarket Data API
export interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;  // This is the token ID
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;  // Unix timestamp
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  transactionHash: string;
}

// Our executed trade record
export interface ExecutedTrade {
  id?: number;
  configId: number;
  originalTradeId: string;
  traderAddress: string;
  market: string;
  assetId: string;
  side: 'BUY' | 'SELL';
  originalSize: number;
  executedSize: number;
  price: number;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'SKIPPED';
  orderId?: string;
  errorMessage?: string;
  createdAt?: string;
}

// Market info
export interface MarketInfo {
  conditionId: string;
  questionId: string;
  tokens: TokenInfo[];
}

export interface TokenInfo {
  token_id: string;
  outcome: string;
  price: number;
}

// Order types for CLOB
export interface OrderRequest {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // Dollar amount for BUY, share count for SELL
}
