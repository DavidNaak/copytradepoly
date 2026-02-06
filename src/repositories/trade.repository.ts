import Database from 'better-sqlite3';
import path from 'path';
import { CopytradeConfig, ExecutedTrade } from '../types';

const DB_PATH = path.join(process.cwd(), 'copytrader.db');

export class TradeRepository {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Create configs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS copytrade_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trader_address TEXT NOT NULL,
        budget REAL NOT NULL,
        remaining_budget REAL NOT NULL,
        copy_percentage REAL NOT NULL,
        max_trade_size REAL NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id INTEGER NOT NULL,
        original_trade_id TEXT NOT NULL UNIQUE,
        trader_address TEXT NOT NULL,
        market TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        side TEXT NOT NULL,
        original_size REAL NOT NULL,
        executed_size REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT NOT NULL,
        order_id TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (config_id) REFERENCES copytrade_configs(id)
      )
    `);

    // Create index for faster lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_original_id ON executed_trades(original_trade_id)
    `);
  }

  // Config operations
  saveConfig(config: CopytradeConfig): CopytradeConfig {
    const stmt = this.db.prepare(`
      INSERT INTO copytrade_configs (trader_address, budget, remaining_budget, copy_percentage, max_trade_size, is_active)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      config.traderAddress,
      config.budget,
      config.remainingBudget,
      config.copyPercentage,
      config.maxTradeSize,
      config.isActive ? 1 : 0
    );

    return {
      ...config,
      id: result.lastInsertRowid as number,
    };
  }

  getConfig(id: number): CopytradeConfig | null {
    const stmt = this.db.prepare(`
      SELECT * FROM copytrade_configs WHERE id = ?
    `);

    const row = stmt.get(id) as any;
    if (!row) return null;

    return this.mapRowToConfig(row);
  }

  getActiveConfigs(): CopytradeConfig[] {
    const stmt = this.db.prepare(`
      SELECT * FROM copytrade_configs WHERE is_active = 1
    `);

    const rows = stmt.all() as any[];
    return rows.map(this.mapRowToConfig);
  }

  updateBudget(configId: number, remainingBudget: number): void {
    const stmt = this.db.prepare(`
      UPDATE copytrade_configs SET remaining_budget = ? WHERE id = ?
    `);
    stmt.run(remainingBudget, configId);
  }

  deactivateConfig(configId: number): void {
    const stmt = this.db.prepare(`
      UPDATE copytrade_configs SET is_active = 0 WHERE id = ?
    `);
    stmt.run(configId);
  }

  // Trade operations
  saveTrade(trade: ExecutedTrade): ExecutedTrade {
    const stmt = this.db.prepare(`
      INSERT INTO executed_trades (
        config_id, original_trade_id, trader_address, market, asset_id,
        side, original_size, executed_size, price, status, order_id, error_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      trade.configId,
      trade.originalTradeId,
      trade.traderAddress,
      trade.market,
      trade.assetId,
      trade.side,
      trade.originalSize,
      trade.executedSize,
      trade.price,
      trade.status,
      trade.orderId || null,
      trade.errorMessage || null
    );

    return {
      ...trade,
      id: result.lastInsertRowid as number,
    };
  }

  isTradeProcessed(originalTradeId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM executed_trades WHERE original_trade_id = ?
    `);
    const row = stmt.get(originalTradeId);
    return !!row;
  }

  hasPositionInMarket(assetId: string): boolean {
    const stmt = this.db.prepare(`
      SELECT 1 FROM executed_trades
      WHERE asset_id = ? AND status = 'SUCCESS'
    `);
    const row = stmt.get(assetId);
    return !!row;
  }

  getHeldPositions(): Set<string> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT asset_id FROM executed_trades WHERE status = 'SUCCESS'
    `);
    const rows = stmt.all() as any[];
    return new Set(rows.map(r => r.asset_id));
  }

  getTradesByConfig(configId: number, limit: number = 10): ExecutedTrade[] {
    const stmt = this.db.prepare(`
      SELECT * FROM executed_trades
      WHERE config_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(configId, limit) as any[];
    return rows.map(this.mapRowToTrade);
  }

  getRecentTrades(limit: number = 10): ExecutedTrade[] {
    const stmt = this.db.prepare(`
      SELECT * FROM executed_trades
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as any[];
    return rows.map(this.mapRowToTrade);
  }

  // Mapping helpers
  private mapRowToConfig(row: any): CopytradeConfig {
    return {
      id: row.id,
      traderAddress: row.trader_address,
      budget: row.budget,
      remainingBudget: row.remaining_budget,
      copyPercentage: row.copy_percentage,
      maxTradeSize: row.max_trade_size,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
    };
  }

  private mapRowToTrade(row: any): ExecutedTrade {
    return {
      id: row.id,
      configId: row.config_id,
      originalTradeId: row.original_trade_id,
      traderAddress: row.trader_address,
      market: row.market,
      assetId: row.asset_id,
      side: row.side,
      originalSize: row.original_size,
      executedSize: row.executed_size,
      price: row.price,
      status: row.status,
      orderId: row.order_id,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}
