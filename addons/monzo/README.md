# Monzo → Wealthfolio Addon

Automatically sync Monzo Bank cash transactions into Wealthfolio. Supports incremental sync, deduplication, and automatic account setup.

**Architecture**: FastAPI proxy (holds OAuth credentials securely) + TypeScript/React addon (runs inside Wealthfolio).

---

## Quick Start

### 1. Create a Monzo OAuth App

1. Go to [https://developers.monzo.com](https://developers.monzo.com) and sign in
2. Click **"New OAuth Client"**
3. Fill in:
   - **Name**: Wealthfolio
   - **Redirect URLs**: `http://YOUR_SERVER_IP:8001/callback` — must be your NAS/server IP, **not** `localhost` or `172.x.x.x`
   - **Confidentiality**: Confidential
4. Click **Submit** — copy your **Client ID** and **Client Secret**

> **Important**: The Redirect URL must exactly match the `REDIRECT_URI` you set in the proxy container. Even a trailing slash difference will cause "Woops! We couldn't identify..." errors.

### 2. Deploy the Proxy

Clone the repo to your server first:

```bash
cd /mnt/user/appdata
git clone https://github.com/dpremoli/MonzoAddOn.git monzo-proxy
```

> If you get a credentials error, use a GitHub Personal Access Token:
> `git clone https://YOUR_PAT@github.com/dpremoli/MonzoAddOn.git monzo-proxy`

Then start the proxy container:

```bash
docker run -d \
  --name monzo-proxy \
  --restart unless-stopped \
  -p 8001:8000 \
  -e MONZO_CLIENT_ID="oauth2client_xxxx" \
  -e MONZO_CLIENT_SECRET="mnzconf.xxxx" \
  -e REDIRECT_URI="http://YOUR_SERVER_IP:8001/callback" \
  -v /mnt/user/appdata/monzo-proxy:/app \
  -w /app \
  python:3.11-slim \
  bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
```

> We use port `8001` on the host (mapped to `8000` inside the container) to avoid conflicts. Adjust as needed.

Test it:
```bash
curl http://YOUR_SERVER_IP:8001/health
# Expected: {"status":"ok"}
```

### 3. Install the Addon in Wealthfolio

Build the addon ZIP:

```bash
cd /mnt/user/appdata/monzo-proxy/addon
npm install
npm run bundle
# Creates: dist/monzo-addon-1.0.0.zip
```

In Wealthfolio: **Settings → Add-ons → Install from ZIP** → select the ZIP file.

### 4. Connect & Sync

1. Open **Monzo Sync** in the sidebar
2. Click **Settings**
3. Enter proxy URL: `http://YOUR_SERVER_IP:8001`
4. Click **Save**, then **Connect Monzo**
5. Approve the connection in your **Monzo mobile app** (see note below)
6. Wealthfolio accounts are created automatically for each Monzo account
7. Return to the dashboard and click **Sync Now**

---

## Known Issues & Solutions

### "Woops! We couldn't identify who you'd like to connect..."

This error comes from Monzo during OAuth. Causes:

- **Redirect URL mismatch**: The URL in your Monzo app settings must exactly match `REDIRECT_URI` in the proxy container. Check both with:
  ```bash
  docker exec monzo-proxy env | grep REDIRECT
  ```
- **Wrong IP**: Use your NAS/server IP (e.g. `192.168.1.x` or `nas.local`), never `172.x.x.x` (Docker internal) or `localhost`

### Must approve in Monzo mobile app

After clicking "Connect Monzo" and completing the browser OAuth flow, you **must open the Monzo app on your phone** and approve the connection. Until you do, the OAuth client stays in "NEW" status and all `/accounts` requests return 403.

Steps:
1. Complete the OAuth flow in the browser
2. Open the **Monzo app** on your phone
3. You'll see a notification or prompt to approve the connection
4. Tap **Approve**
5. Go back to Wealthfolio — accounts should now load

### Only 90 days of transactions sync

This is a **Monzo API limitation**, not a bug. Monzo only returns transaction history from the last 90 days by default. There is no way to fetch older transactions via the API. Future syncs will be incremental from the last sync point.

### Proxy container crashes immediately (`requirements.txt not found`)

The volume mount is empty — the repo wasn't cloned to the right location. Fix:

```bash
# Stop and remove the broken container
docker stop monzo-proxy && docker rm monzo-proxy

# Clone the repo to the correct path
rm -rf /mnt/user/appdata/monzo-proxy
git clone https://github.com/dpremoli/MonzoAddOn.git /mnt/user/appdata/monzo-proxy

# Then restart the container (use the run command from Step 2 above)
```

### Settings page not opening from addon cards

Wealthfolio's Add-ons Manager cards are not clickable links to the addon UI. To access the Monzo addon settings, click **"Monzo Sync"** in the left sidebar, then click the **Settings** button in the top right of the page.

### Sync shows wrong account balance

Monzo only syncs the last 90 days of transactions. If your Wealthfolio account has no prior transactions, the balance will only reflect 90 days of activity. To set the correct opening balance, manually add a balance adjustment activity in Wealthfolio.

### Proxy 403 on /accounts after connecting

The token was not received after OAuth. Try:
1. Go to Settings → **Disconnect**
2. Click **Connect Monzo** again
3. Complete the OAuth flow fully
4. Approve in the Monzo mobile app

---

## Deployment (Unraid)

### Via Unraid Docker UI

1. **Docker** tab → **Add Container**
2. Set:
   - **Name**: `monzo-proxy`
   - **Repository**: `python:3.11-slim`
3. **Volumes**: `/mnt/user/appdata/monzo-proxy` → `/app`
4. **Ports**: `8001` → `8000` (TCP)
5. **Environment Variables**:
   - `MONZO_CLIENT_ID` = your client ID
   - `MONZO_CLIENT_SECRET` = your client secret
   - `REDIRECT_URI` = `http://nas.local:8001/callback` (or your NAS IP)
6. **Post Arguments**:
   ```
   bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
   ```

> Make sure to clone the repo to `/mnt/user/appdata/monzo-proxy` before starting the container.

---

## Architecture

### Token Flow

```
User clicks "Connect Monzo"
  ↓
Addon → Proxy GET /auth → returns auth URL + state token
  ↓
Browser opens Monzo OAuth page
  ↓
User approves in browser + approves in Monzo mobile app
  ↓
Monzo → Proxy GET /callback?code=X&state=Y
  ↓
Proxy exchanges code for tokens (using Client Secret)
  ↓
Addon polls Proxy GET /token-status?state=Y every 2s
  ↓
Tokens returned → stored in Wealthfolio OS keyring
```

### Sync Flow

```
User clicks "Sync Now"
  ↓
Addon reads tokens from OS keyring
  ↓
If token expires in < 5 min → Proxy POST /refresh
  ↓
For each mapped account:
  - GET /transactions?account_id=X&since=last_sync
  - Filter: skip pending, skip pot transfers
  - checkImport → detect duplicates
  - import non-duplicates
  ↓
Update last_sync timestamp
```

### Proxy Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check |
| GET | `/auth` | Get Monzo OAuth URL + state |
| GET | `/callback` | OAuth callback from Monzo |
| GET | `/token-status?state=X` | Poll for tokens after OAuth |
| POST | `/refresh` | Refresh expired access token |
| GET | `/accounts` | List Monzo accounts |
| GET | `/transactions` | Fetch transactions |

---

## Development

### Build the Addon

```bash
cd addon
npm install
npm run build        # Creates dist/addon.js
npm run bundle       # Creates dist/monzo-addon-1.0.0.zip
```

### Update Addon on Server

```bash
cd /mnt/user/appdata/monzo-proxy
git pull origin main
cd addon
npm run bundle
cp dist/addon.js /mnt/user/appdata/wealthfolio/addons/monzo-addon/addon.js
cp manifest.json /mnt/user/appdata/wealthfolio/addons/monzo-addon/manifest.json
docker restart wealthfolio
```

### Proxy Logs

```bash
docker logs monzo-proxy --tail 50
```

### Project Structure

```
/
├── main.py                     # FastAPI proxy
├── requirements.txt            # Python deps
├── .env.example                # Env var template
├── README.md
└── addon/
    ├── manifest.json
    ├── package.json
    └── src/
        ├── addon.tsx           # Entry point + QueryClient setup
        ├── types.ts            # Monzo API types
        ├── lib/
        │   ├── proxy-client.ts # HTTP calls to proxy
        │   └── mapper.ts       # Monzo tx → Wealthfolio ActivityImport
        ├── hooks/
        │   ├── use-tokens.ts   # Token storage (OS keyring)
        │   └── use-sync.ts     # Sync orchestration
        └── pages/
            ├── dashboard-page.tsx  # Sync UI
            └── settings-page.tsx   # Config + account mapping
```

---

## Security

- **Client Secret** never leaves the proxy
- **Tokens** stored in Wealthfolio OS keyring (encrypted), never on disk
- **Proxy** is stateless — tokens held in memory only during the brief OAuth callback window
- Never commit `.env` files or expose credentials

---

## License

MIT
