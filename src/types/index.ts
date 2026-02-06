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
  createdAt?: string;
}

// Trade from Polymarket API
export interface PolymarketTrade {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  size: string;
  fee_rate_bps: string;
  price: string;
  status: string;
  match_time: string;
  last_update: string;
  outcome: string;
  maker_address: string;
  trader: string; // This is the taker address
  transaction_hash: string;
  bucket_index: number;
  owner: string;
  type: string;
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
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
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
  size: number;
  price?: number; // For limit orders
}
