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
        chat_id TEXT,
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
        chat_id TEXT,
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
        chat_id TEXT,
        symbol TEXT NOT NULL,
        tick_price REAL NOT NULL,
        timestamp TEXT NOT NULL
      )
    `).run();
    
        // User Settings
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS user_settings (
        chat_id TEXT PRIMARY KEY,
        deriv_token TEXT,
        deriv_token_demo TEXT,
        deriv_token_real TEXT,
        deriv_account_type TEXT DEFAULT 'demo',
        options_stake REAL,
        cfd_lots REAL,
        cfd_leverage REAL
      )
    `).run();

    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN deriv_token_demo TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN deriv_token_real TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN deriv_account_type TEXT DEFAULT 'demo'`).run();
    } catch (e) {}
    
    // Trading Reports
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS trading_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        report_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();

    // Evolutionary agent self-learning memory
    await this.db.prepare(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        chat_id TEXT,
        symbol TEXT,
        memory_text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, symbol)
      )
    `).run();

    try {
      await this.db.prepare(`ALTER TABLE trades ADD COLUMN chat_id TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE cfd_positions ADD COLUMN chat_id TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE decision_ticks ADD COLUMN chat_id TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE trading_reports ADD COLUMN chat_id TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN deriv_token TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN ai_provider TEXT DEFAULT 'poolside'`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN ai_model TEXT DEFAULT 'poolside/laguna-s-2.1'`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN auto_trade_interval INTEGER DEFAULT 0`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN last_auto_trade_time TEXT`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN auto_trade_symbol TEXT DEFAULT 'R_100'`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN auto_trade_mode TEXT DEFAULT 'options'`).run();
    } catch (e) {}
    try {
      await this.db.prepare(`ALTER TABLE user_settings ADD COLUMN smart_routing INTEGER DEFAULT 0`).run();
    } catch (e) {}
  }

  async getAllSchedulableUserSettings(): Promise<any[]> {
    if (!this.db) return [];
    try {
      const { results } = await this.db.prepare(`
        SELECT * FROM user_settings WHERE auto_trade_interval > 0
      `).all();
      return results || [];
    } catch (e) {
      console.error("Error retrieving schedulable user settings:", e);
      return [];
    }
  }

  async saveTrade(trade: TradeLog, chatId?: string | number): Promise<void> {
    if (!this.db) {
      console.log("Mock Database Save Trade:", JSON.stringify(trade, null, 2));
      return;
    }

    await this.db.prepare(`
      INSERT INTO trades (chat_id, symbol, contract_id, action, amount, purchase_price, timestamp, decision_reason, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      chatId?.toString(),
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

  async getRecentTradesForSymbol(symbol: string, limit: number = 3, chatId?: string | number): Promise<any[]> {
    if (!this.db) return [];
    try {
      const { results } = await this.db.prepare(
        `SELECT action FROM trades WHERE symbol = ? ${chatId ? 'AND chat_id = ?' : ''} ORDER BY id DESC LIMIT ?`
      ).bind(...(chatId ? [symbol, chatId.toString(), limit] : [symbol, limit])).all();
      return results || [];
    } catch (e) {
      console.error(`Error fetching recent trades for symbol ${symbol}:`, e);
      return [];
    }
  }

  async openCfdPosition(pos: CfdPosition, chatId?: string | number): Promise<number> {
    if (!this.db) {
      console.log("Mock Database Open CFD Position:", JSON.stringify(pos, null, 2));
      return Math.floor(Math.random() * 1000000);
    }

    const result = await this.db.prepare(`
      INSERT INTO cfd_positions (chat_id, symbol, direction, lots, entry_price, current_price, sl, tp, leverage, margin, floating_pl, open_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      chatId?.toString(),
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

  async getOpenCfdPositions(symbol?: string, chatId?: string | number): Promise<CfdPosition[]> {
    if (!this.db) {
      return [];
    }

    let query = "SELECT * FROM cfd_positions WHERE status = 'OPEN'";
    const params: any[] = [];
    
    if (chatId) {
      query += " AND chat_id = ?";
      params.push(chatId.toString());
    }
    
    if (symbol) {
      query += " AND symbol = ?";
      params.push(symbol);
    }

    const stmt = this.db.prepare(query).bind(...params);

    const { results } = await stmt.all();
    return results as CfdPosition[];
  }

  async getAllCfdPositions(limit: number = 50, chatId?: string | number): Promise<CfdPosition[]> {
    if (!this.db) {
      return [];
    }

    const query = chatId 
      ? `SELECT * FROM cfd_positions WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM cfd_positions ORDER BY id DESC LIMIT ?`;
    
    const params = chatId ? [chatId.toString(), limit] : [limit];

    const { results } = await this.db.prepare(query).bind(...params).all();

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

  async saveDecisionTick(symbol: string, price: number, chatId?: string | number): Promise<void> {
    if (!this.db) {
      console.log(`Mock Database Save Tick: ${symbol} @ $${price}`);
      return;
    }

    await this.db.prepare(`
      INSERT INTO decision_ticks (chat_id, symbol, tick_price, timestamp)
      VALUES (?, ?, ?, ?)
    `).bind(
      chatId?.toString(),
      symbol,
      price,
      new Date().toISOString()
    ).run();
  }

  
  
  async saveReport(reportText: string, chatId?: string | number): Promise<void> {
    if (!this.db) return;
    await this.db.prepare(`INSERT INTO trading_reports (chat_id, report_text, created_at) VALUES (?, ?, ?)`)
      .bind(chatId?.toString(), reportText, new Date().toISOString()).run();
  }

  async getLatestReport(chatId?: string | number): Promise<string | null> {
    if (!this.db) return null;
    const query = chatId 
      ? `SELECT report_text FROM trading_reports WHERE chat_id = ? ORDER BY id DESC LIMIT 1`
      : `SELECT report_text FROM trading_reports ORDER BY id DESC LIMIT 1`;
    const params = chatId ? [chatId.toString()] : [];
    const { results } = await this.db.prepare(query).bind(...params).all();
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

  async getRecentTrades(limit: number = 20, chatId?: string | number): Promise<TradeLog[]> {
    if (!this.db) {
      return [];
    }

    const query = chatId 
      ? `SELECT * FROM trades WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM trades ORDER BY id DESC LIMIT ?`;
    
    const params = chatId ? [chatId.toString(), limit] : [limit];

    const { results } = await this.db.prepare(query).bind(...params).all();

    return results as TradeLog[];
  }

  async getAgentMemory(symbol: string, chatId?: string | number): Promise<string> {
    if (!this.db) return "";
    try {
      const query = chatId 
        ? `SELECT memory_text FROM agent_memory WHERE symbol = ? AND chat_id = ?`
        : `SELECT memory_text FROM agent_memory WHERE symbol = ?`;
      const params = chatId ? [symbol, chatId.toString()] : [symbol];
      
      const { results } = await this.db.prepare(query).bind(...params).all();
      return results.length > 0 ? (results[0] as any).memory_text : "";
    } catch (e) {
      console.error("Error retrieving agent memory:", e);
      return "";
    }
  }

  async saveAgentMemory(symbol: string, memoryText: string, chatId?: string | number): Promise<void> {
    if (!this.db) return;
    try {
      const updatedAt = new Date().toISOString();
      await this.db.prepare(`
        INSERT INTO agent_memory (chat_id, symbol, memory_text, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id, symbol) DO UPDATE SET memory_text = excluded.memory_text, updated_at = excluded.updated_at
      `).bind(chatId?.toString() || "default", symbol, memoryText, updatedAt).run();
    } catch (e) {
      console.error("Error saving agent memory:", e);
    }
  }
}
