# Apex Trader Backend — Deploy Guide

## Deploy to Railway (free, ~5 minutes)

### 1. Create a GitHub repo
Go to github.com → New repository → name it `apex-backend` → Create repository

On your Mac, open Terminal:
```bash
cd ~/Downloads/apex-backend
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/apex-backend.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to **railway.app** → Sign up free with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `apex-backend` repo → Deploy
4. Wait ~2 minutes for build
5. Go to **Settings** → **Networking** → **Generate Domain**
6. Copy the URL (e.g. `https://apex-backend-production-abc123.up.railway.app`)

### 3. Connect in Apex Trader
1. Open Apex Trader → **Connect** tab (⚙️)
2. Paste your Railway URL in Step 1
3. Click Save, then enter your Tastytrade credentials
4. Click **Sync Trades Now**

Done! Your real trade history will load automatically.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | / | Health check |
| POST | /login | Authenticate, returns token + accounts |
| GET | /transactions | Full trade history |
| GET | /positions | Current open positions |
| GET | /balances | Account balances + buying power |

---

## Local testing
```bash
npm install
npm run dev
# Runs on http://localhost:3001
```
