# Acrion Agent ⚡

An autonomous, full-stack AI-driven trading assistant designed to run headlessly as a cost-optimized **Cloudflare Worker**. It continuously watches real-time tick movements, leverages state-of-the-art LLMs (**Poolside AI** & **Gemini API**) to perform automated analysis, executes Options and CFD contracts via **Deriv**, persists state in **Cloudflare D1**, and provides a rich control layer via **Telegram Bot**.

---

## 🏗️ Architecture Blueprint

```
                     ┌──────────────────────────────────────┐
                     │          Telegram Client             │
                     └──────────────────┬───────────────────┘
                                        │ (Webhook)
                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           CLOUDFLARE WORKER                              │
│                                                                          │
│  ┌──────────────────┐    ┌────────────────────┐    ┌──────────────────┐  │
│  │    /api/trade    │───▶│  Trading Pipeline  │◀───│  /api/telegram   │  │
│  └──────────────────┘    └─────────┬──────────┘    └──────────────────┘  │
│                                    │                                     │
│            ┌───────────────────────┴───────────────────────┐             │
│            ▼                                               ▼             │
│  ┌────────────────────┐                          ┌────────────────────┐  │
│  │     LLM Engine     │                          │     Deriv API      │  │
│  │  (Poolside/Gemini) │                          │  (WebSocket/REST)  │  │
│  └────────────────────┘                          └────────────────────┘  │
│            │                                               │             │
│            ▼                                               ▼             │
│  ┌────────────────────┐                          ┌────────────────────┐  │
│  │   D1 Database      │                          │   HTML Report API  │  │
│  │  (Remote Storage)  │                          │    (/api/report)   │  │
│  └────────────────────┘                          └────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1. Dual AI Engine
- **Poolside AI (`laguna-s-2.1`)**: Cost-optimized, ultra-fast model for micro-trend execution and structural trade validations.
- **Gemini API (`gemini-3.5-flash-lite`)**: Deep reasoning capability, multi-tick sentiment analysis, and risk governance.
- **Dynamic Routing**: Users can dynamically pivot their active LLM configuration on-the-fly via interactive Telegram callback menus.

### 2. Execution Pipeline & Deriv Bridge
- **Options Trading**: Executes instant `CALL` / `PUT` contracts on synthetic indices (e.g., `R_10`, `R_100`) via low-latency secure connections.
- **CFD Positions**: Tracks, calculates, and maintains simulated margin portfolios directly on-chain/in-DB.
- **Real-Time Market Context**: Gathers tick feeds directly to establish real-time price history (`recent_ticks`) prior to querying model inferences.

### 3. Cost-Optimized Cloudflare D1 Storage
Performs structural state persistence inside Cloudflare's serverless SQLite relational engine.
- `trades`: Historical ledger of completed or active options executions.
- `cfd_positions`: Real-time portfolio logging for live leverage exposure.
- `user_settings`: Chat-specific configurations, trade stakes, leverage limits, and chosen active AI models.
- `trading_reports`: Rich text outputs from past runs rendered instantly via `/api/report`.
- `decision_ticks`: Price logs aligned with discrete analytical runs.

---

## 🛠️ Relational Database Schema

```sql
-- Chat-specific routing & stake profiles
CREATE TABLE user_settings (
  chat_id TEXT PRIMARY KEY,
  options_stake REAL DEFAULT 10,
  cfd_lots REAL,
  cfd_leverage REAL,
  ai_provider TEXT DEFAULT 'poolside',
  ai_model TEXT DEFAULT 'poolside/laguna-s-2.1'
);

-- Trade execution ledger
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  symbol TEXT,
  contract_type TEXT,
  amount REAL,
  contract_id INTEGER,
  status TEXT,
  created_at TEXT
);

-- Portfolio tracking for CFD positions
CREATE TABLE cfd_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT,
  position_id INTEGER,
  symbol TEXT,
  action TEXT,
  lots REAL,
  entry_price REAL,
  current_price REAL,
  floating_pl REAL,
  margin REAL,
  created_at TEXT
);
```

---

## ⚡ API Endpoint Schema

| Endpoint | Method | Description |
|---|---|---|
| `/api/trade` | `POST` | Forces or schedules a live trade cycle. Pulls real-time prices, evaluates via the active LLM, executes the trade on Deriv, and outputs reports. |
| `/api/telegram` | `POST` | Webhook handler processing all inbound Telegram bot interactions, inline commands, and configuration button presses. |
| `/api/report` | `GET` | Renders a visually parsed HTML status update of the most recent active runs, portfolio logs, and model insights. |

---

## 🚀 Headless Management & Command Lines

### Initial Setup & Secrets Injection
```bash
# Inject keys directly into the Cloudflare Worker runtime secrets vaults
echo -n "<BOT_TOKEN>" | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo -n "<GEMINI_API_KEY>" | npx wrangler secret put GEMINI_API_KEY
echo -n "<POOLSIDE_API_KEY>" | npx wrangler secret put POOLSIDE_API_KEY
echo -n "<DERIV_TOKEN>" | npx wrangler secret put DERIV_TOKEN
```

### Apply Webhook Configuration
```bash
# Programmatically wire Telegram Bot API webhooks directly to the Worker's entry points
npx tsx set_telegram_webhook.ts "<BOT_TOKEN>" "https://deriv-poolside-cfd-agent.georgeo-qie.workers.dev"
```

### Production Deployment
```bash
# Instantly compile, bundle, and deploy code changes to Cloudflare Edge
npx wrangler deploy --config wrangler.toml
```

---

## 🧬 Secure Operational Principles
- **No Client Keys**: All API credentials and personal tokens reside strictly inside encrypted Cloudflare vault storage. No front-end client exposures occur.
- **State Integrity**: System configurations are retrieved directly from D1 on a per-request basis, guaranteeing flawless multi-tenant state separation.
