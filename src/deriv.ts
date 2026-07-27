export interface DerivAccountInfo {
  email: string;
  currency: string;
  balance: number;
  loginid: string;
  fullname: string;
}

export interface DerivTick {
  symbol: string;
  quote: number;
  epoch: number;
  id: string;
}

export interface DerivProposal {
  ask_price: number;
  id: string;
  payout: number;
  spot: number;
}

export interface DerivBuyReceipt {
  contract_id: number;
  purchase_time: number;
  buy_price: number;
  shortcode: string;
}

export class DerivClient {
  private token: string;
  private appId: string;
  private wsUrl: string | null = null;
  private ws: WebSocket | null = null;
  private reqIdCounter = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private messageListeners = new Set<(msg: any) => void>();
  private activeAccount: any = null;

  constructor(token: string, appId: string = "33VKvdJA8yrAFlw0tC9Fn") {
    this.token = token;
    this.appId = appId;
  }

  private async fetchAccounts(): Promise<any[]> {
    const res = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
      headers: {
        "Deriv-App-ID": this.appId,
        "Authorization": `Bearer ${this.token}`
      }
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch accounts: ${res.status} ${await res.text()}`);
    }
    const parsed: any = await res.json();
    return parsed.data || parsed.accounts || parsed;
  }

  private async generateOtp(accountId: string): Promise<string> {
    const res = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${accountId}/otp`, {
      method: "POST",
      headers: {
        "Deriv-App-ID": this.appId,
        "Authorization": `Bearer ${this.token}`
      }
    });
    if (!res.ok) {
      throw new Error(`Failed to generate OTP: ${res.status} ${await res.text()}`);
    }
    const parsed: any = await res.json();
    if (!parsed.data || !parsed.data.url) {
      throw new Error(`OTP response did not contain a WebSocket URL: ${JSON.stringify(parsed)}`);
    }
    return parsed.data.url;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      return;
    }

    // 1. Fetch accounts
    const accounts = await this.fetchAccounts();
    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts found for the provided Deriv token.");
    }

    // Pick demo account if available, otherwise pick the first one
    const demoAccount = accounts.find((a: any) => a.account_type === "demo") || accounts[0];
    this.activeAccount = demoAccount;

    // 2. Request OTP and get WS URL
    const wsUrl = await this.generateOtp(demoAccount.account_id);
    this.wsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deriv WebSocket connection timed out (15s)"));
      }, 15000);

      try {
        // In CF Workers/modern Node, use global WebSocket
        this.ws = new WebSocket(this.wsUrl!);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          resolve();
        };

        this.ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket connection failed: ${JSON.stringify(err)}`));
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data.toString());
            
            // Route message by req_id if present
            if (data.req_id && this.pendingRequests.has(data.req_id)) {
              const { resolve: reqResolve, reject: reqReject } = this.pendingRequests.get(data.req_id)!;
              this.pendingRequests.delete(data.req_id);
              if (data.error) {
                reqReject(new Error(data.error.message || JSON.stringify(data.error)));
              } else {
                reqResolve(data);
              }
            }

            // Also notify general message listeners
            for (const listener of this.messageListeners) {
              listener(data);
            }
          } catch (e) {
            console.error("Error handling onmessage:", e);
          }
        };

        this.ws.onclose = () => {
          this.ws = null;
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  }

  private sendRequest(payload: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
        return reject(new Error("WebSocket is not connected."));
      }

      const reqId = this.reqIdCounter++;
      const fullPayload = { ...payload, req_id: reqId };
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`Deriv request ${reqId} timed out after 10s`));
      }, 10000);

      this.pendingRequests.set(reqId, { 
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        }, 
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        } 
      });
      this.ws.send(JSON.stringify(fullPayload));
    });
  }

  async authorize(): Promise<DerivAccountInfo> {
    try {
      const accounts = await this.fetchAccounts();
      const currentId = this.activeAccount ? this.activeAccount.account_id : accounts[0]?.account_id;
      const matching = accounts.find((a: any) => a.account_id === currentId) || accounts[0];
      if (matching) {
        this.activeAccount = matching;
      }
    } catch (e) {
      console.error("Failed to refresh accounts in authorize:", e);
    }

    if (!this.activeAccount) {
      throw new Error("No active account set.");
    }

    return {
      email: "demo@deriv.com",
      currency: this.activeAccount.currency,
      balance: parseFloat(this.activeAccount.balance),
      loginid: this.activeAccount.account_id,
      fullname: "Deriv Options Trader"
    };
  }

  async getTicksHistory(symbol: string, limit: number = 10): Promise<number[]> {
    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: limit,
      end: "latest",
      style: "ticks"
    });
    if (!res.history || !res.history.prices) {
      throw new Error(`Ticks history request failed or returned empty: ${JSON.stringify(res)}`);
    }
    return res.history.prices.map((p: any) => parseFloat(p));
  }

  async getLatestTick(symbol: string): Promise<DerivTick> {
    const res = await this.sendRequest({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: 1,
      end: "latest",
      style: "ticks"
    });
    if (!res.history || !res.history.prices || !res.history.times) {
      throw new Error("Ticks history request for latest tick failed");
    }
    return {
      symbol,
      quote: parseFloat(res.history.prices[0]),
      epoch: parseInt(res.history.times[0]),
      id: "latest"
    };
  }

  async getProposal(options: {
    symbol: string;
    contractType: "CALL" | "PUT";
    amount: number;
    duration: number;
    durationUnit: "t" | "m" | "h";
  }): Promise<DerivProposal> {
    const res = await this.sendRequest({
      proposal: 1,
      amount: options.amount,
      basis: "stake",
      contract_type: options.contractType,
      currency: this.activeAccount?.currency || "USD",
      duration: options.duration,
      duration_unit: options.durationUnit,
      underlying_symbol: options.symbol
    });
    if (!res.proposal) {
      throw new Error(`Proposal request failed: ${JSON.stringify(res)}`);
    }
    return {
      ask_price: parseFloat(res.proposal.ask_price),
      id: res.proposal.id,
      payout: parseFloat(res.proposal.payout),
      spot: parseFloat(res.proposal.spot)
    };
  }

  async buyContract(proposalId: string, price: number): Promise<DerivBuyReceipt> {
    const res = await this.sendRequest({
      buy: proposalId,
      price: price
    });
    if (!res.buy) {
      throw new Error(`Buy request failed: ${JSON.stringify(res)}`);
    }
    return {
      contract_id: res.buy.contract_id,
      purchase_time: res.buy.purchase_time,
      buy_price: parseFloat(res.buy.buy_price),
      shortcode: res.buy.shortcode
    };
  }

  async getMt5Logins(): Promise<any[]> {
    try {
      const res = await this.sendRequest({
        mt5_login_list: 1
      });
      return res.mt5_login_list || [];
    } catch (e) {
      console.error("Failed to fetch MT5 logins:", e);
      return [];
    }
  }
}
