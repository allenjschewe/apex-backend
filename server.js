import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());
app.use(express.json());

const TT = "https://api.tastytrade.com";

// Health check
app.get("/", (req, res) => res.json({ status: "Apex Backend running ✓" }));

// ── OAUTH LOGIN ──────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { clientId, clientSecret, refreshToken } = req.body;
  if (!clientId || !clientSecret || !refreshToken)
    return res.status(400).json({ error: "clientId, clientSecret and refreshToken required" });
  try {
    const r = await fetch(`${TT}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const d = await r.json();
    console.log("OAuth token status:", r.status, "body:", JSON.stringify(d));
    if (!r.ok) return res.status(401).json({ error: d?.error_description || d?.error || JSON.stringify(d) });

    const token = d.access_token;
    const ar = await fetch(`${TT}/customers/me/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    const ad = await ar.json();
    console.log("Accounts status:", ar.status);
    const accounts = (ad.data?.items || []).map(item => ({
      accountNumber: item.account["account-number"],
      nickname: item.account.nickname || item.account["account-type-name"],
    }));
    res.json({ token, accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TRANSACTIONS ─────────────────────────────────────────────────────────────
app.get("/transactions", async (req, res) => {
  const { token, account, startDate } = req.query;
  if (!token || !account) return res.status(400).json({ error: "token and account required" });
  try {
    const params = new URLSearchParams({ "per-page": "500", sort: "Desc", "transaction-type": "Trade" });
    if (startDate) params.set("start-date", startDate);
    const r = await fetch(`${TT}/accounts/${account}/transactions?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    console.log("Transactions status:", r.status, "body:", JSON.stringify(d).slice(0, 200));
    if (!r.ok) return res.status(r.status).json({ error: d?.error?.message || JSON.stringify(d) });
    res.json({ trades: transform(d.data?.items || [], account) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POSITIONS ────────────────────────────────────────────────────────────────
app.get("/positions", async (req, res) => {
  const { token, account } = req.query;
  if (!token || !account) return res.status(400).json({ error: "token and account required" });
  try {
    const r = await fetch(`${TT}/accounts/${account}/positions`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.error?.message || "Failed" });
    const positions = (d.data?.items || []).map(p => ({
      symbol: p.symbol,
      underlying: p["underlying-symbol"],
      type: p["instrument-type"],
      quantity: parseFloat(p.quantity),
      direction: p["quantity-direction"],
      avgOpen: parseFloat(p["average-open-price"]),
      closePrice: parseFloat(p["close-price"]),
    }));
    res.json({ positions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BALANCES ─────────────────────────────────────────────────────────────────
app.get("/balances", async (req, res) => {
  const { token, account } = req.query;
  if (!token || !account) return res.status(400).json({ error: "token and account required" });
  try {
    const r = await fetch(`${TT}/accounts/${account}/balances`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d?.error?.message || "Failed" });
    const b = d.data;
    res.json({
      netLiquidatingValue: parseFloat(b["net-liquidating-value"]),
      cashBalance: parseFloat(b["cash-balance"]),
      equityBuyingPower: parseFloat(b["equity-buying-power"]),
      derivativeBuyingPower: parseFloat(b["derivative-buying-power"]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TRANSFORM ─────────────────────────────────────────────────────────────────
function transform(items, account = "") {
  return items
    .filter(item => item["transaction-type"] === "Trade")
    .filter(item => {
      const action = (item.action || "").toLowerCase();
      const inst = (item["instrument-type"] || "").toLowerCase();
      // "Equity" = plain stock, "Equity Option" = option on stock, "Future Option" etc
      if (inst === "equity") {
        // Plain stock — only include when selling (closing a long position)
        return action === "sell to close" || action === "sell";
      }
      if (inst.includes("option")) {
        // Options (Equity Option, Future Option) — only closing/expiry/assignment
        return action.includes("close") || action.includes("expir") || action.includes("assign") || action.includes("exercise");
      }
      // Futures and everything else — include all
      return true;
    })
    .map(item => {
      const netVal = parseFloat(item["net-value"] || 0);
      const pnl = item["value-effect"] === "Credit" ? netVal : -netVal;
      const inst = item["instrument-type"] || "";
      const type = inst.includes("Option") ? "Options" : inst.includes("Future") ? "Futures" : "Stock";
      const action = item.action || "";
      let direction = "LONG";
      if (action.toLowerCase().includes("call")) direction = "CALL";
      else if (action.toLowerCase().includes("put")) direction = "PUT";
      else if (action.toLowerCase().includes("sell") && action.toLowerCase().includes("open")) direction = "SHORT";
      const grade = pnl > 800 ? "A" : pnl > 200 ? "B" : pnl > 0 ? "B" : pnl > -300 ? "C" : "D";
      return {
        id: item.id,
        account,
        date: (item["transaction-date"] || item["executed-at"] || "").slice(0, 10),
        ticker: item["underlying-symbol"] || item.symbol || "?",
        type, direction, grade,
        strike: item["strike-price"] ? String(item["strike-price"]) : "",
        expiry: item["expiration-date"] || "",
        entry: parseFloat(item.price || 0),
        exit: 0,
        contracts: parseFloat(item.quantity || 1),
        pnl: Math.round(pnl * 100) / 100,
        emotion: "Neutral",
        setup: "Import",
        notes: item.description || "",
        duration: 0,
        delta: null, gamma: null, theta: null, vega: null, iv: null, ivRank: null,
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Apex Backend on :${PORT}`));
