import "./shim.ts";
import { DerivClient } from "./deriv.ts";
import { PoolsideClient } from "./poolside.ts";
import { DbHelper, CfdPosition } from "./db.ts";

export interface Env {
  DB: any; // D1 database
  REPORTS_BUCKET: any; // R2 Bucket
  DERIV_TOKEN: string;
  POOLSIDE_API_KEY: string;
  POOLSIDE_API_URL: string;
  POOLSIDE_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY?: string;
}

const workerHandler = {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    // Helper to wrap response with CORS
    const jsonResponse = (data: any, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    };

    try {
      const dbHelper = new DbHelper(env.DB);

      // Route: GET /api/init
      if (path === "/api/init") {
        await dbHelper.initializeSchema();
        return jsonResponse({ message: "D1 Database schema initialized successfully" });
      }

      // Route: GET /api/status
      if (path === "/api/status") {
        await dbHelper.initializeSchema();
        const recentTrades = await dbHelper.getRecentTrades(30);
        const openCfdPositions = await dbHelper.getOpenCfdPositions();
        const allCfdPositions = await dbHelper.getAllCfdPositions(50);

        let mt5Logins: any[] = [];
        let authenticated = false;
        try {
          const derivToken = env.DERIV_TOKEN || process.env.DERIV_TOKEN || "pat_48a3740b33a183cf5f7598039d270871ab2239c00b9e7eb0a00a4b5b2f522d78";
          const derivClient = new DerivClient(
            derivToken,
            url.searchParams.get("app_id") || "33VKvdJA8yrAFlw0tC9Fn"
          );
          await derivClient.connect();
          await derivClient.authorize();
          mt5Logins = await derivClient.getMt5Logins();
          authenticated = true;
          derivClient.disconnect();
        } catch (e: any) {
          console.warn("Could not authenticate with Deriv on status check:", e.message);
        }

        return jsonResponse({
          status: "active",
          model: env.POOLSIDE_MODEL || process.env.POOLSIDE_MODEL || "poolside/laguna-s-2.1",
          deriv_authenticated: authenticated,
          mt5_logins: mt5Logins,
          open_cfd_positions: openCfdPositions,
          all_cfd_positions: allCfdPositions,
          recent_option_trades: recentTrades
        });
      }

      // Route: GET /api/report
      if (path === "/api/report") {
        await dbHelper.initializeSchema();
        const reportText = await dbHelper.getLatestReport();
        if (!reportText) {
          return jsonResponse({ message: "No trading reports found in DB" }, 404);
        }
        
        return new Response(reportText, {
          headers: {
            "Content-Type": "text/html",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      
      // Route: POST /api/telegram
      if (path === "/api/telegram" && request.method === "POST") {
        let update: any;
        try {
          update = await request.json();
        } catch (e) {
          return jsonResponse({ error: "Invalid JSON" }, 400);
        }

        const telegramToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        if (!telegramToken) {
          console.warn("Telegram token not configured");
          return jsonResponse({ error: "Telegram token not configured" }, 500);
        }

        const sendMessage = async (chatId: number, msg: string, replyMarkup?: any) => {
          const body: any = { chat_id: chatId, text: msg, parse_mode: "HTML" };
          if (replyMarkup) {
            body.reply_markup = replyMarkup;
          }
          await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
        };

        const answerCallbackQuery = async (callbackQueryId: string, text?: string) => {
          await fetch(`https://api.telegram.org/bot${telegramToken}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: callbackQueryId, text })
          });
        };

        const executeTrade = async (chatId: number, symbol: string, mode: string = "options") => {
          await sendMessage(chatId, `⏳ Initiating ${mode === "options" ? "Options" : "CFD"} trade cycle for <b>${symbol}</b>...`);
          
          await dbHelper.initializeSchema();
          const settings = await dbHelper.getUserSettings(chatId) || {};
          
          const bodyPayload: any = { mode, symbol, chat_id: chatId };
          if (mode === "options") bodyPayload.stake = settings.options_stake || 5;
          if (mode === "cfd") { 
            bodyPayload.lots = settings.cfd_lots || 0.1; 
            bodyPayload.leverage = settings.cfd_leverage || 100; 
          }

          const tradeReq = new Request(url.origin + "/api/trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyPayload)
          });
          
          const tradeRes = await workerHandler.fetch(tradeReq, env, ctx);
          const tradeData: any = await tradeRes.json();

          if (tradeRes.status === 200 && tradeData.execution) {
            const exec = tradeData.execution;
            const dec = tradeData.decision;
            let msg = `🤖 <b>Decision: ${dec.action}</b>\n\n`;
            msg += `<i>Reasoning:</i> ${dec.reason}\n\n`;
            if (exec.status === "SUCCESS") {
              msg += `✅ <b>Execution SUCCESS</b>\nBought ${exec.details.shortcode || exec.details.direction}\nID: ${exec.details.contract_id || exec.details.position_id}`;
            } else {
              msg += `⚠️ <b>Execution ${exec.status}</b>`;
            }
            await sendMessage(chatId, msg);
          } else {
            await sendMessage(chatId, `❌ Error executing trade: ${tradeData.error || 'Unknown error'}`);
          }
        };

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim();
          const args = text.split(" ");
          let command = args[0].toLowerCase();
          if (command.includes('@')) {
            command = command.split('@')[0];
          }

          if (command === "/start" || command === "/help") {
            await sendMessage(chatId, `🤖 <b>Acrion Agent</b>\n\nAvailable commands:\n/status - Get agent status\n/trade - Trigger a manual CFD/Options trade cycle\n/amount - Configure trading amounts\n/report - Fetch the latest trading report`);
            return jsonResponse({ ok: true });
          }

          
          if (command === "/amount") {
            const replyMarkup = {
              inline_keyboard: [
                [{ text: "💵 Options Stake", callback_data: "set_amount:options_stake" }],
                [{ text: "📊 CFD Lots", callback_data: "set_amount:cfd_lots" }],
                [{ text: "⚖️ CFD Leverage", callback_data: "set_amount:cfd_leverage" }]
              ]
            };
            await sendMessage(chatId, "⚙️ <b>Configure Trading Amounts</b>\nSelect which parameter you want to configure:", replyMarkup);
            return jsonResponse({ ok: true });
          }

          if (command === "/status") {
            await sendMessage(chatId, "⏳ Fetching agent status...");
            await dbHelper.initializeSchema();
            const openPositions = await dbHelper.getOpenCfdPositions("R_100");
            
            let statusMsg = `📊 <b>Agent Status</b>\n\n• Model: ${env.POOLSIDE_MODEL || process.env.POOLSIDE_MODEL || "poolside/laguna-s-2.1"}\n• Deriv Auth: ✅\n• Active Simulated CFD Positions: ${openPositions.length}`;
            if (openPositions.length > 0) {
              statusMsg += `\n\n<b>Positions:</b>\n` + openPositions.map((p: any) => `- ${p.symbol} ${p.direction} @ $${p.entry_price} (P/L: $${p.floating_pl.toFixed(2)})`).join("\n");
            }
            await sendMessage(chatId, statusMsg);
            return jsonResponse({ ok: true });
          }

          if (command === "/report") {
             await sendMessage(chatId, "⏳ Fetching latest report...");
             const reportReq = new Request(url.origin + "/api/report", { method: "GET" });
             const reportRes = await workerHandler.fetch(reportReq, env, ctx);
             if (reportRes.status === 200) {
               const reportText = await reportRes.text();
               const textToSend = reportText.length > 4000 ? reportText.substring(0, 4000) + "..." : reportText;
               await sendMessage(chatId, textToSend);
             } else {
               await sendMessage(chatId, "❌ No reports found or error retrieving report.");
             }
             return jsonResponse({ ok: true });
          }


          if (command === "/model") {
            const replyMarkup = {
              inline_keyboard: [
                [{ text: "🌊 Poolside (Laguna)", callback_data: "set_model:poolside:poolside/laguna-s-2.1" }],
                [{ text: "✨ Gemini (Flash Lite)", callback_data: "set_model:gemini:gemini-3.5-flash-lite" }]
              ]
            };
            await sendMessage(chatId, "🤖 <b>Select AI Trading Model:</b>", replyMarkup);
            return jsonResponse({ ok: true });
          }

          if (command === "/trade") {
            const symbol = args[1];
            if (symbol) {
              const mode = args[2] && args[2].toLowerCase() === 'options' ? 'options' : 'cfd';
              await executeTrade(chatId, symbol.toUpperCase(), mode);
            } else {
              const replyMarkup = {
                inline_keyboard: [
                  [{ text: "📉 CFD", callback_data: "select_symbol:cfd" }, { text: "📈 Options", callback_data: "select_symbol:options" }]
                ]
              };
              await sendMessage(chatId, "💱 <b>Select Trading Mode:</b>", replyMarkup);
            }
            return jsonResponse({ ok: true });
          }
        } else if (update.callback_query) {
          const callbackQuery = update.callback_query;
          const data = callbackQuery.data;
          const chatId = callbackQuery.message.chat.id;

          
          if (data && data.startsWith("set_amount:")) {
            const param = data.split(":")[1];
            let replyMarkup: any = { inline_keyboard: [] };
            let paramName = "";
            
            if (param === "options_stake") {
              paramName = "Options Stake ($)";
              replyMarkup.inline_keyboard = [
                [{ text: "$1", callback_data: "save_amount:options_stake:1" }, { text: "$5", callback_data: "save_amount:options_stake:5" }],
                [{ text: "$10", callback_data: "save_amount:options_stake:10" }, { text: "$20", callback_data: "save_amount:options_stake:20" }],
                [{ text: "$50", callback_data: "save_amount:options_stake:50" }]
              ];
            } else if (param === "cfd_lots") {
              paramName = "CFD Lots";
              replyMarkup.inline_keyboard = [
                [{ text: "0.1", callback_data: "save_amount:cfd_lots:0.1" }, { text: "0.5", callback_data: "save_amount:cfd_lots:0.5" }],
                [{ text: "1.0", callback_data: "save_amount:cfd_lots:1" }, { text: "2.0", callback_data: "save_amount:cfd_lots:2" }],
                [{ text: "5.0", callback_data: "save_amount:cfd_lots:5" }]
              ];
            } else if (param === "cfd_leverage") {
              paramName = "CFD Leverage";
              replyMarkup.inline_keyboard = [
                [{ text: "10x", callback_data: "save_amount:cfd_leverage:10" }, { text: "50x", callback_data: "save_amount:cfd_leverage:50" }],
                [{ text: "100x", callback_data: "save_amount:cfd_leverage:100" }, { text: "250x", callback_data: "save_amount:cfd_leverage:250" }]
              ];
            }
            
            await sendMessage(chatId, `⚙️ <b>Select new value for ${paramName}:</b>`, replyMarkup);
            await answerCallbackQuery(callbackQuery.id);
            return jsonResponse({ ok: true });
          } else if (data && data.startsWith("save_amount:")) {
            const parts = data.split(":");
            const param = parts[1];
            const value = parseFloat(parts[2]);
            
            await dbHelper.initializeSchema();
            await dbHelper.updateUserSettings(chatId, param, value);
            
            let paramName = param === "options_stake" ? "Options Stake" : (param === "cfd_lots" ? "CFD Lots" : "CFD Leverage");
            let displayValue = param === "options_stake" ? `${value}` : (param === "cfd_leverage" ? `${value}x` : `${value}`);
            
            await sendMessage(chatId, `✅ <b>${paramName} updated successfully to ${displayValue}!</b>`);
            await answerCallbackQuery(callbackQuery.id, `Saved ${paramName}: ${displayValue}`);
            return jsonResponse({ ok: true });
          } else 
          if (data && data.startsWith("set_amount:")) {
            const param = data.split(":")[1];
            let replyMarkup: any = { inline_keyboard: [] };
            let paramName = "";
            
            if (param === "options_stake") {
              paramName = "Options Stake ($)";
              replyMarkup.inline_keyboard = [
                [{ text: "$1", callback_data: "save_amount:options_stake:1" }, { text: "$5", callback_data: "save_amount:options_stake:5" }],
                [{ text: "$10", callback_data: "save_amount:options_stake:10" }, { text: "$20", callback_data: "save_amount:options_stake:20" }],
                [{ text: "$50", callback_data: "save_amount:options_stake:50" }]
              ];
            } else if (param === "cfd_lots") {
              paramName = "CFD Lots";
              replyMarkup.inline_keyboard = [
                [{ text: "0.1", callback_data: "save_amount:cfd_lots:0.1" }, { text: "0.5", callback_data: "save_amount:cfd_lots:0.5" }],
                [{ text: "1.0", callback_data: "save_amount:cfd_lots:1" }, { text: "2.0", callback_data: "save_amount:cfd_lots:2" }],
                [{ text: "5.0", callback_data: "save_amount:cfd_lots:5" }]
              ];
            } else if (param === "cfd_leverage") {
              paramName = "CFD Leverage";
              replyMarkup.inline_keyboard = [
                [{ text: "10x", callback_data: "save_amount:cfd_leverage:10" }, { text: "50x", callback_data: "save_amount:cfd_leverage:50" }],
                [{ text: "100x", callback_data: "save_amount:cfd_leverage:100" }, { text: "250x", callback_data: "save_amount:cfd_leverage:250" }]
              ];
            }
            
            await sendMessage(chatId, `⚙️ <b>Select new value for ${paramName}:</b>`, replyMarkup);
            await answerCallbackQuery(callbackQuery.id);
            return jsonResponse({ ok: true });
          } else if (data && data.startsWith("save_amount:")) {
            const parts = data.split(":");
            const param = parts[1];
            const value = parseFloat(parts[2]);
            
            await dbHelper.initializeSchema();
            await dbHelper.updateUserSettings(chatId, param, value);
            
            let paramName = param === "options_stake" ? "Options Stake" : (param === "cfd_lots" ? "CFD Lots" : "CFD Leverage");
            let displayValue = param === "options_stake" ? `${value}` : (param === "cfd_leverage" ? `${value}x` : `${value}`);
            
            await sendMessage(chatId, `✅ <b>${paramName} updated successfully to ${displayValue}!</b>`);
            await answerCallbackQuery(callbackQuery.id, `Saved ${paramName}: ${displayValue}`);
            return jsonResponse({ ok: true });

          
          } else if (data && data.startsWith("set_model:")) {
            const parts = data.split(":");
            const provider = parts[1];
            const modelName = parts[2] ? parts.slice(2).join(":") : "unknown";
            
            await dbHelper.initializeSchema();
            await dbHelper.updateUserSettings(chatId, "ai_provider", provider);
            await dbHelper.updateUserSettings(chatId, "ai_model", modelName);
            
            await answerCallbackQuery(callbackQuery.id, "✅ Model updated");
            await sendMessage(chatId, `🤖 AI Model successfully switched to <b>${provider.toUpperCase()} (${modelName})</b>.`);
            return jsonResponse({ ok: true });
          } else if (data && data.startsWith("select_symbol:")) {
            const mode = data.split(":")[1];
            const replyMarkup = {
              inline_keyboard: [
                [{ text: "Volatility 10 Index", callback_data: "trade:" + mode + ":R_10" }, { text: "Volatility 25 Index", callback_data: "trade:" + mode + ":R_25" }],
                [{ text: "Volatility 50 Index", callback_data: "trade:" + mode + ":R_50" }, { text: "Volatility 75 Index", callback_data: "trade:" + mode + ":R_75" }],
                [{ text: "Volatility 100 Index", callback_data: "trade:" + mode + ":R_100" }]
              ]
            };
            await sendMessage(chatId, "💱 <b>Select a symbol for " + mode.toUpperCase() + ":</b>", replyMarkup);
            await answerCallbackQuery(callbackQuery.id);
          } else if (data && data.startsWith("trade:")) {
            const parts = data.split(":");
            if (parts.length === 3) {
              const mode = parts[1];
              const symbol = parts[2];
              await answerCallbackQuery(callbackQuery.id, "Trading " + symbol + " (" + mode + ")");
              await executeTrade(chatId, symbol, mode);
            } else {
              const symbol = parts[1];
              await answerCallbackQuery(callbackQuery.id, "Trading " + symbol + " (options)");
              await executeTrade(chatId, symbol, "options");
            }
          } else {
            await answerCallbackQuery(callbackQuery.id);
          }
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ ok: true });
      }

      // Route: GET /api/status
      if (path === "/api/status" && request.method === "GET") {
        await dbHelper.initializeSchema();
        const openPositions = await dbHelper.getOpenCfdPositions("R_100");
        return jsonResponse({
          model: env.POOLSIDE_MODEL || process.env.POOLSIDE_MODEL || "poolside/laguna-s-2.1",
          deriv_authenticated: true,
          open_cfd_positions: openPositions
        });
      }

      // Route: POST /api/trade
      if (path === "/api/trade" && request.method === "POST") {
        await dbHelper.initializeSchema();

        // Get options from request body
        let body: any = {};
        try {
          body = await request.json();
        } catch (e) {}

        const mode = body.mode || "cfd"; // Default to CFD trading
        const symbol = body.symbol || "R_100"; // Volatility 100 Index default
        const lots = body.lots || 0.1; // CFD lot size
        const stake = body.stake || 1.0; // Options stake
        const leverage = body.leverage || 100; // CFD leverage
        const multiplier = body.multiplier || 100; // Index price point multiplier

        // Initialize Clients with fallbacks to process.env and verified tokens
        const derivToken = env.DERIV_TOKEN || process.env.DERIV_TOKEN || "pat_48a3740b33a183cf5f7598039d270871ab2239c00b9e7eb0a00a4b5b2f522d78";
        const derivClient = new DerivClient(
          derivToken,
          body.app_id || "33VKvdJA8yrAFlw0tC9Fn"
        );

        
        const chatId = body.chat_id;
        let settings: any = {};
        if (chatId) {
          settings = await dbHelper.getUserSettings(chatId) || {};
        }

        const aiProvider = settings.ai_provider || "poolside";
        const poolsideModel = settings.ai_model || env.POOLSIDE_MODEL || process.env.POOLSIDE_MODEL || "poolside/laguna-s-2.1";
        
        const poolsideApiKey = env.POOLSIDE_API_KEY || process.env.POOLSIDE_API_KEY || "";
        const poolsideApiUrl = env.POOLSIDE_API_URL || process.env.POOLSIDE_API_URL || "https://inference.poolside.ai/v1";
        const geminiApiKey = env.GEMINI_API_KEY || "";

        const poolsideClient = new PoolsideClient(
          poolsideApiKey,
          poolsideApiUrl,
          poolsideModel,
          aiProvider,
          geminiApiKey
        );

        console.log(`Connecting to Deriv for Symbol: ${symbol} in ${mode.toUpperCase()} mode...`);
        await derivClient.connect();

        let accountInfo;
        let ticksHistory;
        let currentTick;

        try {
          // Authorize account
          accountInfo = await derivClient.authorize();
          console.log(`Authenticated Deriv User: ${accountInfo.fullname} (Balance: $${accountInfo.balance})`);

          // Fetch market data
          ticksHistory = await derivClient.getTicksHistory(symbol, 10);
          currentTick = ticksHistory[ticksHistory.length - 1];
          await dbHelper.saveDecisionTick(symbol, currentTick);

        } catch (e: any) {
          derivClient.disconnect();
          return jsonResponse({ error: `Deriv API Initialization Error: ${e.message}` }, 500);
        }

        let logs: string[] = [];

        // 1. If we are in CFD mode, simulate live tick updates for all active CFD positions
        if (mode === "cfd") {
          const openPositions = await dbHelper.getOpenCfdPositions(symbol);
          for (const pos of openPositions) {
            // Calculate floating profit/loss
            let floatingPl = 0;
            if (pos.direction === "BUY") {
              floatingPl = (currentTick - pos.entry_price) * pos.lots * multiplier;
            } else {
              floatingPl = (pos.entry_price - currentTick) * pos.lots * multiplier;
            }

            // Check if Stop Loss (SL) or Take Profit (TP) was hit
            let isClosed = false;
            let closeReason = "";

            if (pos.sl !== null) {
              if ((pos.direction === "BUY" && currentTick <= pos.sl) || 
                  (pos.direction === "SELL" && currentTick >= pos.sl)) {
                isClosed = true;
                closeReason = "CLOSED_SL";
              }
            }

            if (pos.tp !== null && !isClosed) {
              if ((pos.direction === "BUY" && currentTick >= pos.tp) || 
                  (pos.direction === "SELL" && currentTick <= pos.tp)) {
                isClosed = true;
                closeReason = "CLOSED_TP";
              }
            }

            if (isClosed) {
              await dbHelper.closeCfdPosition(pos.id!, currentTick, closeReason);
              logs.push(`CFD Position #${pos.id} closed automatically via ${closeReason} at $${currentTick}. Floating P/L was $${floatingPl.toFixed(2)}`);
            } else {
              await dbHelper.updateCfdPositionPrice(pos.id!, currentTick, floatingPl);
            }
          }
        }

        // Fetch remaining/active open CFD positions
        const activeCfdPositions = await dbHelper.getOpenCfdPositions(symbol);

        // Retrieve persistent self-evolution memory from D1 database
        const currentMemory = await dbHelper.getAgentMemory(symbol);

        // Fetch AI Trading Decision from Poolside/Gemini with injected Memory Heuristics
        console.log(`Analyzing trends with Poolside/Gemini ${poolsideModel}...`);
        const decision = await poolsideClient.getTradingDecision({
          symbol,
          currentTick,
          ticksHistory,
          balance: accountInfo.balance,
          portfolioSize: mode === "cfd" ? activeCfdPositions.length : 0,
          memory: currentMemory
        });

        console.log(`AI Decision: ${decision.action} (${decision.reason})`);

        let receipt = null;
        let purchasePrice = null;
        let tradeStatus = "HOLD";
        let executionDetails: any = {};

        // 2. CFD Trading Mode Flow
        if (mode === "cfd") {
          if (decision.action === "BUY_CALL" || decision.action === "BUY_PUT") {
            const targetDirection = decision.action === "BUY_CALL" ? "BUY" : "SELL";
            const oppositeDirection = targetDirection === "BUY" ? "SELL" : "BUY";

            // A. Position Reversal: Close any existing position in the opposite direction
            const oppositePositions = activeCfdPositions.filter(p => p.direction === oppositeDirection);
            for (const pos of oppositePositions) {
              await dbHelper.closeCfdPosition(pos.id!, currentTick, "CLOSED_REVERSAL");
              logs.push(`Reversal Triggered: Closed opposite ${oppositeDirection} Position #${pos.id} at $${currentTick}`);
            }

            // B. Avoid Over-Exposure: Check if we already have an open position in the same direction
            const sameDirectionPositions = activeCfdPositions.filter(p => p.direction === targetDirection);
            if (sameDirectionPositions.length > 0) {
              tradeStatus = "HOLD_EXISTING";
              logs.push(`Hold existing position: Already have an active ${targetDirection} position. Skipping new order.`);
            } else {
              // Calculate SL, TP and Margin
              const slOffset = currentTick * 0.015; // 1.5% SL
              const tpOffset = currentTick * 0.030; // 3.0% TP

              const sl = targetDirection === "BUY" ? currentTick - slOffset : currentTick + slOffset;
              const tp = targetDirection === "BUY" ? currentTick + tpOffset : currentTick - tpOffset;

              const marginRequired = (currentTick * lots * multiplier) / leverage;

              if (marginRequired > accountInfo.balance) {
                tradeStatus = "FAILED_MARGIN";
                logs.push(`Execution Failed: Insufficient balance for margin requirement $${marginRequired.toFixed(2)} (Available: $${accountInfo.balance})`);
              } else {
                const newPosId = await dbHelper.openCfdPosition({
                  symbol,
                  direction: targetDirection,
                  lots,
                  entry_price: currentTick,
                  current_price: currentTick,
                  sl,
                  tp,
                  leverage,
                  margin: marginRequired,
                  floating_pl: 0,
                  open_time: new Date().toISOString()
                });

                tradeStatus = "SUCCESS";
                purchasePrice = currentTick;
                executionDetails = {
                  position_id: newPosId,
                  direction: targetDirection,
                  lots,
                  entry_price: currentTick,
                  sl,
                  tp,
                  margin: marginRequired
                };
                logs.push(`Successfully opened CFD ${targetDirection} Position #${newPosId} at $${currentTick}`);
              }
            }
          }
        } 
        // 3. Options Trading Mode Flow (retained as backup/utility)
        else {
          if (decision.action === "BUY_CALL" || decision.action === "BUY_PUT") {
            const contractType = decision.contract_type || (decision.action === "BUY_CALL" ? "CALL" : "PUT");
            const stakeAmount = Math.min(stake, accountInfo.balance);

            try {
              console.log(`Requesting option proposal for ${contractType} @ $${stakeAmount}...`);
              const proposal = await derivClient.getProposal({
                symbol,
                contractType,
                amount: stakeAmount,
                duration: 5,
                durationUnit: "t"
              });

              console.log(`Proposal received. Price: $${proposal.ask_price}, Payout: $${proposal.payout}. Purchasing...`);
              receipt = await derivClient.buyContract(proposal.id, proposal.ask_price);
              
              purchasePrice = proposal.ask_price;
              tradeStatus = "SUCCESS";
              executionDetails = {
                contract_id: receipt.contract_id,
                shortcode: receipt.shortcode
              };
              console.log(`Successfully purchased contract ID: ${receipt.contract_id}`);
            } catch (e: any) {
              tradeStatus = "FAILED";
              console.error("Trade execution failed:", e.message);
              logs.push(`Options execution failed: ${e.message}`);
            }
          }
        }

        derivClient.disconnect();

        const timestampStr = new Date().toISOString();

        // Save trade execution log to D1 Database
        await dbHelper.saveTrade({
          symbol,
          contract_id: receipt ? receipt.contract_id : (executionDetails.position_id || null),
          action: decision.action,
          amount: mode === "cfd" ? lots : stake,
          purchase_price: purchasePrice,
          timestamp: timestampStr,
          decision_reason: decision.reason + (logs.length > 0 ? " | Logs: " + logs.join("; ") : ""),
          confidence: decision.confidence,
          status: tradeStatus
        });

        // 🧠 Evolutionary Self-Learning Phase (Up to 3k tokens memory budget)
        try {
          console.log("Acrion Agent: Running background evolutionary self-learning analysis...");
          const recentTrades = await dbHelper.getRecentTrades(10);
          const recentCfdPositions = await dbHelper.getAllCfdPositions(10);
          
          const updatedMemory = await poolsideClient.evolveMemory({
            symbol,
            currentMemory,
            recentTrades,
            recentCfdPositions,
            currentTick,
            ticksHistory
          });

          if (updatedMemory && updatedMemory.trim() !== "") {
            await dbHelper.saveAgentMemory(symbol, updatedMemory);
            console.log("Acrion Agent: Evolved trading memory saved successfully.");
          }
        } catch (memError: any) {
          console.error("Acrion Agent: Evolution learning phase failed:", memError.message);
        }

        // Fetch latest state for reporting
        const latestOpenCfdPositions = await dbHelper.getOpenCfdPositions(symbol);

        // Generate report content
        const reportContent = `<b>Deriv AI Trading Run Report</b>
<b>Timestamp:</b> ${timestampStr}
<b>AI Model:</b> ${poolsideModel}
<b>Mode:</b> ${mode.toUpperCase()}
<b>Symbol:</b> ${symbol}
<b>Decision:</b> ${decision.action} (Confidence: ${(decision.confidence * 100).toFixed(1)}%)
<b>Reasoning:</b> ${decision.reason}

<b>Market Summary</b>
• Current Tick Price: $${currentTick}
• Recent Ticks: ${ticksHistory.join(" -> ")}
• Balance: $${accountInfo.balance}

<b>CFD Portfolio Status</b>
• Active Simulated CFD Positions: ${latestOpenCfdPositions.length}
${latestOpenCfdPositions.map(p => `  • Position #${p.id}: <b>${p.direction}</b> ${p.lots} lots @ $${p.entry_price} (Current: $${p.current_price}, Floating P/L: <b>$${p.floating_pl.toFixed(2)}</b>, Margin: $${p.margin.toFixed(2)})`).join("\n")}

<b>Execution Logs</b>
${logs.length > 0 ? logs.map(l => `• ${l}`).join("\n") : "• No logs"}
`;

        try {
          await dbHelper.initializeSchema();
          await dbHelper.saveReport(reportContent);
          console.log(`Saved execution report to D1 database`);
        } catch (e) {
          console.error(`Failed to save execution report to DB:`, e);
        }

        return jsonResponse({
          message: "Trading cycle processed successfully",
          timestamp: timestampStr,
          mode,
          decision,
          execution: {
            status: tradeStatus,
            details: executionDetails,
            logs
          }
        });
      }

      return jsonResponse({ error: "Endpoint not found" }, 404);

    } catch (error: any) {
      console.error("Worker error:", error);
      return jsonResponse({ error: `Internal Server Error: ${error.message}` }, 500);
    }
  }
};

export default workerHandler;
