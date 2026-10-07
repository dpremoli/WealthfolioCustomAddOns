# Monzo → Wealthfolio Addon

Automatically sync Monzo Bank cash transactions into Wealthfolio. Supports incremental sync, deduplication, and automatic account setup.

**Architecture**: FastAPI proxy (holds OAuth credentials securely) + TypeScript/React addon (runs inside Wealthfolio).

---

## ⚠️ Before Deploying Code Changes

**Always run tests first** to catch bugs before they reach production:

```bash
cd addon
npm install
npm run test
npm run type-check
npm run bundle
```

---

## Quick Start

### 1. Create a Monzo OAuth App

1. Go to [https://developers.monzo.com](https://developers.monzo.com) and sign in
2. Click **"New OAuth Client"**
3. Fill in:
   - **Name**: Wealthfolio (or any name you prefer)
   - **Redirect URLs**: `http://YOUR_SERVER_IP:8001/callback` — use your server's IP or hostname, **not** `localhost` or a Docker internal IP (`172.x.x.x`)
   - **Confidentiality**: Confidential
4. Click **Submit** — copy the **Client ID** and **Client Secret**

> **Important**: The redirect URL must exactly match the `REDIRECT_URI` set in the proxy container. Even a trailing slash difference will cause OAuth errors.

### 2. Deploy the Proxy

Clone the repo to your server:

```bash
cd /path/to/your/appdata
git clone https://github.com/dpremoli/MonzoAddOn.git monzo-proxy
```

> If you get a credentials error, use a GitHub Personal Access Token:
> `git clone https://YOUR_PAT@github.com/dpremoli/MonzoAddOn.git monzo-proxy`

Start the proxy container:

```bash
docker run -d \
  --name monzo-proxy \
  --restart unless-stopped \
  -p 8001:8000 \
  -e MONZO_CLIENT_ID="oauth2client_xxxx" \
  -e MONZO_CLIENT_SECRET="mnzconf.xxxx" \
  -e REDIRECT_URI="http://YOUR_SERVER_IP:8001/callback" \
  -v /path/to/your/appdata/monzo-proxy:/app \
  -w /app \
  python:3.11-slim \
  bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
```

> Port `8001` on the host maps to `8000` inside the container. Adjust if needed.

Verify it's running:
```bash
curl http://YOUR_SERVER_IP:8001/health
# Expected: {"status":"ok"}
```

### 3. Install the Addon in Wealthfolio

Build the addon:

```bash
cd /path/to/your/appdata/monzo-proxy/addon
npm install
npm run test            # Always run tests before deploying
npm run bundle
# Creates: dist/monzo-addon-1.0.10.zip
```

In Wealthfolio: **Settings → Add-ons → Install from ZIP** → select the ZIP file.

### 4. Connect & Sync

1. Open **Monzo Sync** in the Wealthfolio sidebar
2. Click **Settings**
3. Enter your proxy URL: `http://YOUR_SERVER_IP:8001`
4. Click **Save**, then **Connect Monzo**
5. Approve the connection in your **Monzo mobile app** (required — see below)
6. Wealthfolio accounts are created automatically for each Monzo account
7. Return to the dashboard and click **Sync Now**

---

## Known Issues & Solutions

### "Woops! We couldn't identify who you'd like to connect..."

OAuth redirect URL mismatch. The URL in your Monzo developer app must exactly match `REDIRECT_URI` in your proxy container.

Check what the proxy is using:
```bash
docker exec monzo-proxy env | grep REDIRECT
```

Use your server's real IP or hostname — not `localhost` or a `172.x.x.x` Docker address.

---

### Must approve in Monzo mobile app

After completing the browser OAuth flow, you **must open the Monzo app on your phone** and approve the connection. Without this, the app stays in "NEW" status and all API calls return 403.

Steps:
1. Complete the OAuth flow in your browser
2. Open the **Monzo app** on your phone
3. Approve the access request (you'll see a notification or prompt)
4. Return to Wealthfolio — accounts will load automatically

---

### Only 90 days of transactions sync

This is a **Monzo API limitation** — the API only returns the last 90 days of transactions. There is no way to retrieve older history via the API. Future syncs are incremental from the last sync point.

---

### Proxy container crashes immediately (`requirements.txt not found`)

The Docker volume is empty — the repo wasn't cloned before starting the container.

Fix:
```bash
docker stop monzo-proxy && docker rm monzo-proxy
rm -rf /path/to/your/appdata/monzo-proxy
git clone https://github.com/dpremoli/MonzoAddOn.git /path/to/your/appdata/monzo-proxy
# Then re-run the docker run command from Step 2
```

---

### Settings page not accessible from addon cards

The Wealthfolio Add-ons Manager card doesn't link to the addon UI. Instead:
1. Click **Monzo Sync** in the left sidebar
2. Click the **Settings** button in the top right

---

### Sync shows incorrect account balance

Monzo only syncs the last 90 days. If your account has older transactions, the balance will only reflect the synced period. To correct this, manually add an opening balance activity in Wealthfolio.

---

### 403 Forbidden after connecting

Your tokens don't have the required permissions — usually because Monzo mobile approval is still pending.

Fix:
1. Go to Settings → **Disconnect**
2. Click **Connect Monzo** again
3. Complete the OAuth flow and approve in the Monzo mobile app

---

### Duplicate empty accounts created

This was a bug in versions before v1.0.10. If you have many empty accounts:

1. In Wealthfolio → Accounts, delete all empty `Monzo (...)` accounts — keep only the one with transaction data
2. Use SQLite to bulk-delete empty duplicates:
   ```bash
   sqlite3 /path/to/wealthfolio.db "
   DELETE FROM accounts
   WHERE name LIKE 'Monzo (%'
   AND id NOT IN (SELECT DISTINCT account_id FROM activities);
   "
   ```
3. Upgrade to v1.0.10+

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
   - `REDIRECT_URI` = `http://YOUR_NAS_IP:8001/callback`
6. **Post Arguments**:
   ```
   bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
   ```

> Clone the repo to `/mnt/user/appdata/monzo-proxy` before starting the container.

---

## User interface

The dashboard and settings use Wealthfolio's first-party `@wealthfolio/ui` design system
(Phosphor icons, `Tabs`, `Tooltip`, `EmptyPlaceholder`, `AlertFeedback`, `ActionConfirm`). A
sync shows a **live step timeline** (Fetch → Import → Done) with an activity feed; afterwards the
status card shows stat tiles (Imported / Duplicates / Skipped), a **Spending** tab breaking
transactions down by category (honouring your custom category labels), and a **Log** tab.
Last-sync times are shown relative ("2 hours ago") with the absolute time on hover.

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
Proxy exchanges code for tokens (Client Secret stays server-side)
  ↓
Addon polls Proxy GET /token-status?state=Y every 2s
  ↓
Tokens stored in Wealthfolio OS keyring
```

### Sync Flow

```
User clicks "Sync Now"
  ↓
Read tokens from OS keyring
  ↓
If token expired → Proxy POST /refresh
  ↓
For each mapped account:
  - GET /transactions?account_id=X&since=last_sync
  - Filter: skip pending, skip pot transfers
  - checkImport → detect duplicates & validate account IDs
  - import valid, non-duplicate activities
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

### Running Tests

```bash
cd addon
npm install
npm run test            # Run all unit tests
npm run test:watch      # Watch mode during development
npm run type-check      # TypeScript validation
```

Tests cover:
- Transaction mapping (required fields, timestamps, currencies)
- Sync logic (invalid activity filtering, stale mapping detection)
- Auto-create duplicate prevention

### Critical Files (test before changing)

- `src/lib/mapper.ts` — transaction mapping logic
- `src/hooks/use-sync.ts` — sync orchestration
- `src/pages/settings-page.tsx` — auto-create account logic

### Updating Addon on Server

```bash
cd /path/to/appdata/monzo-proxy
git pull origin main
cd addon
npm run test            # Always test first
npm run bundle
cp dist/addon.js /path/to/wealthfolio/addons/monzo-addon/addon.js
cp manifest.json /path/to/wealthfolio/addons/monzo-addon/manifest.json
docker restart wealthfolio
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
    ├── vitest.config.ts
    └── src/
        ├── addon.tsx           # Entry point + QueryClient setup
        ├── types.ts            # Monzo API types
        ├── lib/
        │   ├── proxy-client.ts # HTTP calls to proxy
        │   ├── mapper.ts       # Monzo tx → ActivityImport (+ tests)
        │   └── mapper.test.ts
        ├── hooks/
        │   ├── use-tokens.ts   # Token storage (OS keyring)
        │   ├── use-sync.ts     # Sync orchestration (+ tests)
        │   └── use-sync.test.ts
        └── pages/
            ├── dashboard-page.tsx
            ├── settings-page.tsx      # Auto-create logic (+ tests)
            └── settings-page.test.ts
```

---

## Security

- **Client Secret** never leaves the proxy
- **Tokens** stored in Wealthfolio OS keyring (encrypted at rest)
- **Proxy** is stateless — tokens held in memory only briefly during OAuth
- Never commit `.env` — use `.env.example` as a template

---

## License

MIT
