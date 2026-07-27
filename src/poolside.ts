import "./shim.ts";
import { GoogleGenAI, Type } from "@google/genai";

export interface TradeDecision {
  action: "BUY_CALL" | "BUY_PUT" | "HOLD";
  contract_type: "CALL" | "PUT" | null;
  reason: string;
  confidence: number;
  symbol: string;
  amount: number;
}

export class PoolsideClient {
  private apiKey: string;
  private apiUrl: string;
  private model: string;
  private provider: string;
  private geminiApiKey: string;

  constructor(apiKey: string, apiUrl: string, model: string, provider: string = "poolside", geminiApiKey: string = "") {
    this.provider = provider;
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this.model = model;
    this.geminiApiKey = geminiApiKey;
  }

  async getTradingDecision(marketContext: {
    symbol: string;
    currentTick: number;
    ticksHistory: number[];
    balance: number;
    portfolioSize: number;
    memory?: string;
  }): Promise<TradeDecision> {
    const systemPrompt = `You are a high-frequency algorithmic AI Trading Agent specializing in Deriv synthetic indices (e.g., Volatility 100 Index).
    Analyze the provided market context and determine whether to buy a CALL contract, a PUT contract, or HOLD.
    Your decision must be returned strictly as a JSON object matching the requested schema.
    Ensure you strictly adhere to any "LEARNED TRADING INSIGHTS & MEMORY" provided in the prompt to avoid repeating past mistakes.`;

    const userPrompt = `Market Context:
- Symbol: ${marketContext.symbol}
- Current Tick Price: ${marketContext.currentTick}
- Recent Ticks (last 10 ticks, oldest to newest): ${JSON.stringify(marketContext.ticksHistory)}
- Available Balance: $${marketContext.balance}
- Current Open Portfolio Size: ${marketContext.portfolioSize}
${marketContext.memory ? `\n=== LEARNED TRADING INSIGHTS & MEMORY ===\n${marketContext.memory}\n` : ""}

Analyze the micro-trend and make your trade decision immediately. Ensure amount is proportional (default to 1.0 or 2% of balance, whichever is safe).`;

    // Check if Poolside API Key is configured and is not a placeholder
    const hasPoolsideKey = this.apiKey && this.apiKey.trim() !== "" && !this.apiKey.includes("MY_POOLSIDE") && !this.apiKey.includes("PLACEHOLDER");
    if (this.provider === "gemini" || !hasPoolsideKey) {
      console.log(`Using Gemini for trend analysis... Model: ${this.model}`);
      try {
        const apiKeyToUse = this.geminiApiKey || process.env.GEMINI_API_KEY || "";
        const ai = new GoogleGenAI({
          apiKey: apiKeyToUse,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });
        const responsePromise = ai.models.generateContent({
          model: this.model.startsWith("gemini") ? this.model : "gemini-3.5-flash-lite",
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                action: {
                  type: Type.STRING,
                  enum: ["BUY_CALL", "BUY_PUT", "HOLD"]
                },
                contract_type: {
                  type: Type.STRING,
                  enum: ["CALL", "PUT"],
                  nullable: true
                },
                reason: {
                  type: Type.STRING
                },
                confidence: {
                  type: Type.NUMBER
                },
                symbol: {
                  type: Type.STRING
                },
                amount: {
                  type: Type.NUMBER
                }
              },
              required: ["action", "reason", "confidence", "symbol", "amount"]
            }
          }
        });

        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Gemini decision request timed out after 25s")), 25000)
        );

        const response: any = await Promise.race([responsePromise, timeoutPromise]);

        const text = response.text || "{}";
        const decision: TradeDecision = JSON.parse(text);
        return {
          action: decision.action,
          contract_type: decision.contract_type || (decision.action === "BUY_CALL" ? "CALL" : decision.action === "BUY_PUT" ? "PUT" : null),
          reason: decision.reason,
          confidence: decision.confidence,
          symbol: decision.symbol || marketContext.symbol,
          amount: decision.amount || 1.0
        };
      } catch (e: any) {
        console.error("Gemini decision-making failed:", e.message);
        return {
          action: "HOLD",
          contract_type: null,
          reason: `Resilient fallback fallback failed: ${e.message}`,
          confidence: 0,
          symbol: marketContext.symbol,
          amount: 0
        };
      }
    }

    const url = `${this.apiUrl}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt + `\nYour decision MUST be returned as a JSON object.
JSON Schema:
{
  "action": "BUY_CALL" | "BUY_PUT" | "HOLD",
  "contract_type": "CALL" | "PUT" | null,
  "reason": "Brief technical reason",
  "confidence": 0.85,
  "symbol": "${marketContext.symbol}",
  "amount": 1.0
}` },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Poolside API request failed with status ${response.status}: ${errorText}`);
      }

      const data: any = await response.json();
      console.log("Poolside Raw Response Data:", JSON.stringify(data, null, 2));
      const content = data.choices?.[0]?.message?.content?.trim() || "";
      
      // Clean potential markdown wrapper formatting
      let cleanJson = content.trim();
      if (cleanJson.startsWith("```json")) {
        cleanJson = cleanJson.substring(7);
      } else if (cleanJson.startsWith("```")) {
        cleanJson = cleanJson.substring(3);
      }
      cleanJson = cleanJson.trim();
      if (cleanJson.endsWith("```")) {
        cleanJson = cleanJson.substring(0, cleanJson.length - 3);
      }
      cleanJson = cleanJson.trim();

      try {
        const decision: TradeDecision = JSON.parse(cleanJson);
        return decision;
      } catch (e) {
        console.error("Failed to parse Poolside LLM output as JSON. Raw response content:", content);
        return {
          action: "HOLD",
          contract_type: null,
          reason: `LLM parsing failed. Raw response: ${content.substring(0, 100)}`,
          confidence: 0,
          symbol: marketContext.symbol,
          amount: 0
        };
      }
    } catch (e: any) {
      if (e.name === 'AbortError') {
        throw new Error("Poolside API request timed out after 25s");
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async evolveMemory(params: {
    symbol: string;
    currentMemory: string;
    recentTrades: any[];
    recentCfdPositions: any[];
    currentTick: number;
    ticksHistory: number[];
  }): Promise<string> {
    const systemPrompt = `You are the Core Strategic Evolutionary Engine for Acrion Agent.
Your job is to analyze the recent performance of the agent, identify successful strategies, pinpoint mistakes (e.g., false signals, bad entry timing, holding positions too long, getting stopped out), and update the persistent 'Trading Lessons & Micro-heuristics' memory.
Your output must be the updated Lessons and Micro-heuristics text.
DO NOT output any introductory text, markdown wrappers, or explanations. Return ONLY the raw updated lessons and guidelines text.
Target word budget: ~1500 to 2500 words. Keep it incredibly dense, structured, actionable, and analytical. Focus on market structure, momentum, and statistical tick behavior. Avoid fluff and corporate jargon. Ensure it is less than 3,000 tokens.`;

    const userPrompt = `Current Symbol: ${params.symbol}
Current Tick Price: ${params.currentTick}
Recent Tick Trend: ${JSON.stringify(params.ticksHistory)}

=== EXISTING MEMORY / RULES ===
${params.currentMemory || "None - Initial state."}

=== RECENT TRADE LEDGER ===
${JSON.stringify(params.recentTrades)}

=== RECENT CFD POSITIONS OUTCOMES ===
${JSON.stringify(params.recentCfdPositions)}

Analyze the outcomes. Check which trades succeeded (profitable or correct trend prediction) and which failed (loss or stopped out).
Refine the existing trading rules and lessons. Expand on subtle trend indicators, momentum traps, or risk management tips.
Maintain or prune existing memory to keep it extremely dense, actionable, and under the 3,000 tokens limit.
Return the complete updated 'Lessons & Micro-heuristics' text now.`;

    try {
      const apiKeyToUse = this.geminiApiKey || process.env.GEMINI_API_KEY || "";
      const ai = new GoogleGenAI({
        apiKey: apiKeyToUse,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      const responsePromise = ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          temperature: 0.2,
          maxOutputTokens: 4096
        }
      });

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Gemini evolution request timed out after 45s")), 45000)
      );

      const response: any = await Promise.race([responsePromise, timeoutPromise]);

      return response.text?.trim() || "";
    } catch (e: any) {
      console.error("Evolution memory phase failed:", e.message);
      return "";
    }
  }
}
