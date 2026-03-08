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
  const trades = items.filter(item => item["transaction-type"] === "Trade");

  // Group all legs by underlying symbol + date into round-trip trades
  // This handles spreads (multiple open/close legs on same symbol/day)
  const groups = {};
  trades.forEach(item => {
    const symbol = item["underlying-symbol"] || item.symbol || "?";
    const date = (item["transaction-date"] || item["executed-at"] || "").slice(0, 10);
    const inst = (item["instrument-type"] || "").toLowerCase();
    const action = (item.action || "").toLowerCase();
    const netVal = parseFloat(item["net-value"] || 0);
    const pnl = item["value-effect"] === "Credit" ? netVal : -netVal;

    // Skip plain stock buys (open positions) — only include when they close
    if (inst === "equity" && (action === "buy to open" || action === "buy")) return;

    const key = `${symbol}__${date}`;
    if (!groups[key]) {
      groups[key] = {
        id: item.id,
        account,
        date,
        ticker: symbol,
        inst: item["instrument-type"] || "",
        actions: [],
        pnl: 0,
        contracts: parseFloat(item.quantity || 1),
        expiry: item["expiration-date"] || "",
        notes: [],
      };
    }
    groups[key].pnl += pnl;
    groups[key].actions.push(item.action || "");
    if (item.description) groups[key].notes.push(item.description);
  });

  return Object.values(groups)
    .filter(g => Math.abs(g.pnl) > 0.01) // skip zero-P&L rows (fees only etc)
    .map(g => {
      const inst = g.inst;
      const type = inst.includes("Option") ? "Options" : inst.includes("Future") ? "Futures" : "Stock";
      const pnl = Math.round(g.pnl * 100) / 100;
      const grade = pnl > 800 ? "A" : pnl > 200 ? "B" : pnl > 0 ? "B" : pnl > -300 ? "C" : "D";
      // Determine direction from actions — if any "Sell to Open" it's a short/credit spread
      const hasShortLeg = g.actions.some(a => a.toLowerCase().includes("sell to open"));
      const direction = type === "Options" ? (hasShortLeg ? "PUT" : "CALL") : "LONG";
      return {
        id: g.id,
        account: g.account,
        date: g.date,
        ticker: g.ticker,
        type, direction, grade,
        strike: "",
        expiry: g.expiry,
        entry: 0,
        exit: 0,
        contracts: g.contracts,
        pnl,
        emotion: "Neutral",
        setup: "Import",
        notes: [...new Set(g.notes)].slice(0,2).join(" | "),
        duration: 0,
        delta: null, gamma: null, theta: null, vega: null, iv: null, ivRank: null,
      };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Apex Backend on :${PORT}`));
