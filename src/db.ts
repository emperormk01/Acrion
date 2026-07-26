export interface TradeLog {
  id?: number;
  symbol: string;
  contract_id: number | null;
  action: string;
  amount: number;
  purchase_price: number | null;
  timestamp: string;
  decision_reason: string;
  confidence: number;
  status: string;
}

export interface CfdPosition {
  id?: number;
  symbol: string;
  direction: "BUY" | "SELL"; // BUY for Long, SELL for Short
  lots: number;
  entry_price: number;
  current_price: number;
  sl: number | null;
  tp: number | null;
  leverage: number;
  margin: number;
  floating_pl: number;
  open_time: string;
  close_time?: string | null;
  close_price?: number | null;
  status?: "OPEN" | "CLOSED_TP" | "CLOSED_SL" | "CLOSED_MANUAL" | "CLOSED_REVERSAL";
}

export class DbHelper {
  private db: any; // Cloudflare D1 Database binding

  constructor(d1Database: any) {
    this.db = d1Database;
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) return;

    // Table for trades executed by the agent
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        contract_id INTEGER,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        purchase_price REAL,
        timestamp TEXT NOT NULL,
        decision_reason TEXT,
        confidence REAL,
        status TEXT NOT NULL
      )
    `).run();

    // Table for CFD open/closed positions
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS cfd_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        lots REAL NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL NOT NULL,
        sl REAL,
        tp REAL,
        leverage REAL NOT NULL,
        margin REAL NOT NULL,
        floating_pl REAL NOT NULL,
        open_time TEXT NOT NULL,
        close_time TEXT,
        close_price REAL,
        status TEXT NOT NULL
      )
    `).run();

        // Table to keep trace of tick prices at the time of decisions
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS decision_ticks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        tick_price REAL NOT NULL,
        timestamp TEXT NOT NULL
      )
    `).run();
    
        // User Settings
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS user_settings (
        chat_id TEXT PRIMARY KEY,
        options_stake REAL,
        cfd_lots REAL,
        cfd_leverage REAL
      )
    `).run();
    
    // Trading Reports
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trading_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();

    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN ai_provider TEXT DEFAULT 'poolside'`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN ai_model TEXT DEFAULT 'poolside/laguna-s-2.1'`).run();
    } catch (e) {}
  }

  async saveTrade(trade: TradeLog): Promise<void> {
    if (!this.db) {
      console.log("Mock Database Save Trade:", JSON.stringify(trade, null, 2));
      return;
    }

    await this.db.prepare(`
      INSERT INTO trades (symbol, contract_id, action, amount, purchase_price, timestamp, decision_reason, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      trade.symbol,
      trade.contract_id,
      trade.action,
      trade.amount,
      trade.purchase_price,
      trade.timestamp,
      trade.decision_reason,
      trade.confidence,
      trade.status
    ).run();
  }

  async openCfdPosition(pos: CfdPosition): Promise<number> {
    if (!this.db) {
      console.log("Mock Database Open CFD Position:", JSON.stringify(pos, null, 2));
      return Math.floor(Math.random() * 1000000);
    }

    const result = await this.db.prepare(`
      INSERT INTO cfd_positions (symbol, direction, lots, entry_price, current_price, sl, tp, leverage, margin, floating_pl, open_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      pos.symbol,
      pos.direction,
      pos.lots,
      pos.entry_price,
      pos.current_price,
      pos.sl,
      pos.tp,
      pos.leverage,
      pos.margin,
      pos.floating_pl,
      pos.open_time,
      "OPEN"
    ).run();

    return result.meta?.last_row_id || Math.floor(Math.random() * 1000000);
  }

  async getOpenCfdPositions(symbol?: string): Promise<CfdPosition[]> {
    if (!this.db) {
      return [];
    }

    let query = "SELECT * FROM cfd_positions WHERE status = 'OPEN'";
    let stmt;
    if (symbol) {
      query += " AND symbol = ?";
      stmt = this.db.prepare(query).bind(symbol);
    } else {
      stmt = this.db.prepare(query);
    }

    const { results } = await stmt.all();
    return results as CfdPosition[];
  }

  async getAllCfdPositions(limit: number = 50): Promise<CfdPosition[]> {
    if (!this.db) {
      return [];
    }

    const { results } = await this.db.prepare(`
      SELECT * FROM cfd_positions ORDER BY id DESC LIMIT ?
    `).bind(limit).all();

    return results as CfdPosition[];
  }

  async updateCfdPositionPrice(id: number, currentPrice: number, floatingPl: number): Promise<void> {
    if (!this.db) {
      console.log(`Mock Database Update CFD ${id}: Price -> $${currentPrice}, P/L -> $${floatingPl}`);
      return;
    }

    await this.db.prepare(`
      UPDATE cfd_positions 
      SET current_price = ?, floating_pl = ?
      WHERE id = ?
    `).bind(currentPrice, floatingPl, id).run();
  }

  async closeCfdPosition(id: number, closePrice: number, status: string): Promise<void> {
    const closeTime = new Date().toISOString();
    if (!this.db) {
      console.log(`Mock Database Close CFD ${id}: ClosePrice -> $${closePrice}, Status -> ${status}`);
      return;
    }

    await this.db.prepare(`
      UPDATE cfd_positions 
      SET current_price = ?, close_price = ?, close_time = ?, status = ?, floating_pl = CASE 
        WHEN direction = 'BUY' THEN (? - entry_price) * lots * 100
        ELSE (entry_price - ?) * lots * 100
      END
      WHERE id = ?
    `).bind(closePrice, closePrice, closeTime, status, closePrice, closePrice, id).run();
  }

  async saveDecisionTick(symbol: string, price: number): Promise<void> {
    if (!this.db) {
      console.log(`Mock Database Save Tick: ${symbol} @ $${price}`);
      return;
    }

    await this.db.prepare(`
      INSERT INTO decision_ticks (symbol, tick_price, timestamp)
      VALUES (?, ?, ?)
    `).bind(
      symbol,
      price,
      new Date().toISOString()
    ).run();
  }

  
  
  async saveReport(reportText: string): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(`INSERT INTO trading_reports (report_text, created_at) VALUES (?, ?)`)
      .bind(reportText, new Date().toISOString()).run();
  }

  async getLatestReport(): Promise<string | null> {
    if (!this.db) return null;
    const { results } = await this.db.prepare(`SELECT report_text FROM trading_reports ORDER BY id DESC LIMIT 1`).all();
    return results.length > 0 ? results[0].report_text : null;
  }

  async getUserSettings(chatId: string | number) {
    if (!this.db) return null;
    const { results } = await this.db.prepare(`SELECT * FROM user_settings WHERE chat_id = ?`).bind(chatId.toString()).all();
    return results.length > 0 ? results[0] : null;
  }

  async updateUserSettings(chatId: string | number, field: string, value: number | string) {
    if (!this.db) return;
    const settings = await this.getUserSettings(chatId);
    if (!settings) {
      await this.db.prepare(`INSERT INTO user_settings (chat_id, ${field}) VALUES (?, ?)`).bind(chatId.toString(), value).run();
    } else {
      await this.db.prepare(`UPDATE user_settings SET ${field} = ? WHERE chat_id = ?`).bind(value, chatId.toString()).run();
    }
  }

  async getRecentTrades(limit: number = 20): Promise<TradeLog[]> {
    if (!this.db) {
      return [];
    }

    const { results } = await this.db.prepare(`
      SELECT * FROM trades ORDER BY id DESC LIMIT ?
    `).bind(limit).all();

    return results as TradeLog[];
  }
}
