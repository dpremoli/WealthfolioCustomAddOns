# Trading 212 → Wealthfolio Addon

Automatically sync your **Trading 212** investment account into Wealthfolio via
Trading 212's official [public API](https://docs.trading212.com/api): trades,
dividends, interest, deposits, withdrawals and fees — each tagged to the correct
Wealthfolio activity type, with tickers matched to Wealthfolio symbols automatically.

**Architecture**: a tiny **stateless** proxy (solves the browser CORS restriction)
+ a TypeScript/React addon that runs inside Wealthfolio and holds your API key in
the OS keyring. For a developer deep-dive (data flow, modules, design decisions),
see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Why a proxy?

Trading 212's API is server-to-server only — browsers (and therefore Wealthfolio
addons) can't call it directly because of CORS. The proxy simply forwards your
request to Trading 212. **It stores no credentials and keeps no state**: your API
key lives only in Wealthfolio's encrypted keyring and is attached to each request
by the addon.

---

## ⚠️ Before deploying code changes

```bash
cd addon
npm install
npm run test
npm run type-check
npm run bundle
```

---

## Quick start

### 1. Create a Trading 212 API key

1. In the Trading 212 app/web (Invest or Stocks ISA), go to **Settings → API**.
2. Generate a key with at least these **read** scopes: `metadata`, `account`,
   `portfolio`, `history:orders`, `history:dividends`, `history:transactions`.
3. Copy the **API Key (ID)** and **API Secret**. (Older keys are a single value
   with no secret — that works too; leave the secret blank.)

> Keys are environment-specific: a **Live** key only works against Live, a
> **Demo/Practice** key only against Demo.

### 2. Deploy the proxy

```bash
docker run -d \
  --name trading212-proxy \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /path/to/your/appdata/trading212-proxy:/app \
  -w /app \
  python:3.11-slim \
  bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
```

(Clone this repo into `/path/to/your/appdata/trading212-proxy` first.)

Verify:
```bash
curl http://YOUR_SERVER_IP:8000/health
# {"status":"ok"}
```

### 3. Install the addon

```bash
cd addon
npm install
npm run bundle      # creates dist/trading212-addon-<version>.zip
```

In Wealthfolio: **Settings → Add-ons → Install from ZIP**.

### 4. Connect & sync

1. Open **Trading 212** in the sidebar → **Settings**.
2. Under **Connection settings**, enter the proxy URL (`http://YOUR_SERVER_IP:8000`),
   pick **Live** or **Demo**, and click **Save settings**. (Shared by every account.)
3. Under **Add account**, pick the type (**Invest** or **Stocks ISA** — this sets the
   account name, which you can edit), choose a **Sync mode** (see below), then paste that
   account's **API Key** (and Secret) and click **Add account**. A Wealthfolio
   **securities** account is created automatically in the chosen mode. Repeat to add more
   keys — each Trading 212 account has its own key.
4. Go back to the dashboard and click **Sync All**.

> **Sync mode (per account, chosen at setup):**
> - **Holdings** (default) — syncs only your *current positions and cash* as a snapshot.
>   Instant, no history, no rate-limited backfill. Best for a quick portfolio view.
> - **Transactions** — imports your *full* trade/dividend/cash history (the first sync
>   walks back year by year and can take a few minutes). Best for performance tracking.
>
> The mode is fixed when the account is created — the add-on can't change it afterwards.
> To switch, change the account's tracking mode in Wealthfolio, then **Sync All**: the
> add-on detects the change and asks before clearing the old data and re-syncing.

> **Automatic sync (on by default):** once an account has been synced once, the add-on
> refreshes it on its own — about once a day, and whenever Wealthfolio refreshes its
> portfolio — while the app is open. For **Holdings** accounts this writes one snapshot per
> day, so your position history builds up without clicking **Sync All**. Snapshots are keyed
> by date, so only a *same-day* re-sync overwrites the day's snapshot. The very first sync of
> a new account stays manual (a Transactions backfill can take a few minutes). Turn it off
> under **Settings → Connection settings → Automatic sync**.

> **Card transactions (off by default):** if you use the Trading 212 debit card, turn on
> **Settings → Connection settings → Card transactions → Separate account**. The add-on then
> creates a dedicated **"&lt;name&gt; Card"** cash account and routes your card spending,
> refunds and cashback there (instead of mixing them into the investing account), tagging each
> with the Trading 212 merchant category mapped to a Wealthfolio spending label
> (`"SAINSBURYS · Shopping"`) so Wealthfolio's Spending module can categorise it. Works in both
> Holdings and Transactions modes. (The add-on can't set a structured category via the API yet,
> so the label rides in the comment; Wealthfolio's own categorisation stays in charge.)
>
> You can also choose the **card account type** (Cash or Credit Card) right below the toggle.
> *Cash* is accurate for the debit card; *Credit Card* models it as a liability so Wealthfolio
> can link payments from a tracked cash account as transfers (avoiding double-counted spending).
> The type is applied when the card account is first created — to retype an existing one, use
> Wealthfolio's **Update Account** dialog.

> **Renaming / removing:** rename or delete the accounts in Wealthfolio's own **Accounts**
> page. Removing an account in the add-on only forgets the API key — the Wealthfolio
> account and its imported activity stay.

---

## How it works

### Activity mapping

| Trading 212 source | Wealthfolio activity |
|--------------------|----------------------|
| Filled order (BUY/SELL) | `BUY` / `SELL` |
| Dividend | `DIVIDEND` |
| Interest | `INTEREST` |
| Deposit | `DEPOSIT` |
| Withdrawal | `WITHDRAWAL` |
| Fee | `FEE` |
| Transfer | `TRANSFER_IN` / `TRANSFER_OUT` |

Holdings are derived by Wealthfolio from these activities — make sure the account
stays in **`TRANSACTIONS`** tracking mode.

### Symbol matching

Each Trading 212 ticker (e.g. `AAPL_US_EQ`) is matched to a Wealthfolio symbol
using Wealthfolio's own market-data search (`searchTicker`), trying the instrument
ISIN, then the base ticker, then the name, and preferring symbols you already hold.
Resolutions are cached. Trades whose symbol can't be matched are skipped and
reported as "unmatched symbols" on the dashboard.

### Incremental & idempotent sync

Each connected account keeps its **own** `lastSync` watermark and set of
already-imported Trading 212 reference ids, and the addon uses Wealthfolio's
`checkImport` duplicate detection — so re-syncing never creates duplicates. Use the
per-account **Reset sync** button in Settings to force a full re-scan of that account.

### Rate limits

Trading 212 enforces strict per-endpoint limits (instruments 1/50s, history
6/min, account 1/5s). The client backs off and retries on `429`, so a first sync
of a long history can take a little while.

---

## Security

- The API key/secret live only in Wealthfolio's OS keyring (encrypted at rest) and
  are sent only to Trading 212 (via the proxy).
- The proxy is stateless, holds no credentials, and only talks to a fixed
  allow-list of Trading 212 hosts (no arbitrary URLs).
- Never commit `.env`.

---

## Project structure

```
/
├── main.py                 # Stateless FastAPI proxy
├── requirements.txt
└── addon/
    ├── manifest.json
    └── src/
        ├── addon.tsx
        ├── types.ts
        ├── lib/
        │   ├── proxy-client.ts     # HTTP + auth + pagination + backoff
        │   ├── symbol-resolver.ts  # ticker → Wealthfolio symbol (+ tests)
        │   └── mapper.ts           # T212 record → ActivityImport (+ tests)
        ├── hooks/
        │   ├── use-config.ts       # keyring-backed config & sync state
        │   └── use-sync.ts         # sync orchestration (+ tests)
        └── pages/
            ├── dashboard-page.tsx
            └── settings-page.tsx
```

---

## License

GNU GPL v3 — see [LICENSE](LICENSE).
