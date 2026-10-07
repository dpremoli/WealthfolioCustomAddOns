# Wealthfolio Monzo Add-On

Sync your **Monzo** transactions straight into [Wealthfolio](https://wealthfolio.app) cash
accounts, so they feed the spending module. Part of the
[Wealthfolio custom add-ons monorepo](../../README.md). Requires **Wealthfolio 3.9+**.

Version 2 talks to the Monzo API **directly** from inside Wealthfolio. There is no proxy
server, no Docker container and nothing to host: you register a small OAuth client with
Monzo, paste its details into the add-on, and connect.

## What it does

- Connects to Monzo with OAuth (a confidential client that you own) and keeps the
  connection alive by refreshing the access token automatically.
- Creates a Wealthfolio **cash account** for each of your Monzo accounts (current, joint,
  Flex, ...) and syncs new transactions into them, incrementally.
- Imports debits as `WITHDRAWAL` and credits as `DEPOSIT` cash activities, using
  Wealthfolio's `$CASH-<currency>` cash symbol. The merchant, Monzo category, location,
  foreign-currency amount and your notes are kept in the activity comment, so
  **Wealthfolio's Spending module can categorise these cash activities** for you.
- Skips what should not count as spending: declined and zero-value transactions, pending
  transactions (Flex purchases are the exception, they never "settle"), pot transfers, the monthly Flex repayment (the purchases
  are already on the Flex account) and savings-category moves such as investment transfers.
- Lets you rename Monzo categories (Settings -> Category labels).
- Imports a **Monzo CSV export** for history older than the API shares (see below).

## Setup

### 1. Create a Monzo OAuth client

1. Sign in at [developers.monzo.com](https://developers.monzo.com) (a login link is emailed
   to you).
2. Go to **Clients -> New OAuth Client** and fill in:
   - **Name**: Wealthfolio (anything you like)
   - **Redirect URLs**: `https://localhost/monzo-callback`
   - **Confidentiality**: **Confidential** (required: only confidential clients receive
     refresh tokens, without which the connection would expire every 6 hours)
3. Save, then copy the **Client ID** and **Client Secret**.

The redirect URL never has to load. After you approve the login, your browser is sent
there, shows an error page, and you simply copy the address from the address bar. It can be
any URL you like, but it **must match exactly** what you register (even a trailing slash).

### 2. Install the add-on

Build the package (or use a release zip):

```bash
cd addons/monzo
pnpm bundle          # creates dist/monzo-addon-2.0.0.zip
```

In Wealthfolio: **Settings -> Add-ons -> Install from ZIP**, pick the zip, and review the
permissions. The add-on asks for:

| Permission | Why |
|---|---|
| network: `api.monzo.com` | Exchange OAuth codes and fetch accounts/transactions. The only host it can reach. |
| secrets: set / get / delete / use | Keep your client secret and tokens in the OS keyring; `use` lets Wealthfolio attach the access token to Monzo requests so the add-on never handles it. |
| accounts: getAll / create | Create a cash account per Monzo account. |
| activities: getAll / import | Import transactions and skip ones that are already there. |
| ui | The Monzo pages and sidebar link. |

### 3. Connect

1. Open **Monzo Sync** in the sidebar -> **Settings**.
2. Enter the **Client ID**, **Client secret** and **Redirect URL** and press **Save**.
3. Press **Connect Monzo**. The add-on shows a **login link** (Wealthfolio add-ons cannot
   open browser tabs themselves). Press **Copy** and open it in any browser.
4. Enter your email on the Monzo page, then approve the login from the **email** Monzo sends.
5. Your browser lands on the redirect URL (an error page is expected). Copy the **whole
   address** from the address bar, or just the `code=...` value, and paste it into the
   add-on. Do it promptly: the code is single-use and short-lived.
6. Press **Complete connection**.
7. **Approve access in the Monzo app.** Monzo requires strong customer authentication: until
   you approve the new connection in the app, every API call returns **403** and nothing
   syncs.

Wealthfolio cash accounts are then created automatically. Return to the dashboard and press
**Sync Now**.

The add-on checks the `state` value in the pasted URL against the one it generated, so a
link that did not come from your own Connect click is rejected.

## Syncing

- **Sync Now** fetches transactions since the last sync, 100 per request, for each mapped
  account, filters them, and imports what is new.
- Re-syncing is safe. Instead of relying on Wealthfolio's content-hash duplicate detection
  (which would silently drop two genuinely identical same-day transactions, such as two
  coffees at the same price), the add-on tags each activity's comment with its Monzo
  transaction id (`[ref:tx_…]`) and skips ids the account already holds, so a transaction
  whose notes or category changed in Monzo is still recognised. Rows imported before these
  tags existed are matched by content, by count. The same applies to CSV imports, which use
  the same transaction ids, so a CSV and the API sync can overlap freely.
- A transaction that is still **pending** when you sync is not lost: the next sync starts
  from the oldest recent pending transaction, so it is picked up once it settles.
- **Disconnect** revokes the tokens at Monzo (`/oauth2/logout`) as well as forgetting them.
- **Reset sync history** (Settings -> Advanced) makes the next sync start from scratch.
  Anything already imported is recognised and skipped.

### The 90-day limit and CSV backfill

Monzo shares your **full history** only for 5 minutes after you authenticate; after that, API
clients can read just the **last 90 days**. So **sync straight after approving the connection
in the Monzo app**: the first sync asks for everything, and if Monzo refuses (the window has
passed) it falls back to the last 90 days and says so in the log. Later syncs never ask for
more than 90 days back, so a long gap between syncs is logged rather than failing with 403.

For anything older, export a CSV from the Monzo app (**Account -> Export transactions ->
CSV**) and use **Import CSV** in the add-on: choose the file, pick the target Wealthfolio
account, and import. Columns are matched by header name (Transaction ID, Date, Time, Name,
Category, Amount, Currency, Local amount, Local currency, Notes and #tags, Description, ...),
so small changes to Monzo's export layout do not break it. Overlapping API and CSV imports
are reconciled the same way as re-syncs. "Skip transfers & savings" is on by default.

Because older history is not available, an account's balance in Wealthfolio reflects only
the transactions imported. If you need it to match Monzo, add an opening-balance deposit
dated just before your first imported transaction.

## Upgrading from v1.x

v2 replaces the proxy, so most of the old setup can be thrown away.

1. **Reinstall the zip.** Install `monzo-addon-2.0.0.zip` over the old version
   (Settings -> Add-ons). Approve the new permissions.
2. **Your data is migrated automatically** the first time the add-on enables: the account
   mapping, last-sync time and category labels move from the keyring to add-on storage, the
   old tokens are split into the new keys, and the saved proxy URL is deleted.
3. **Enter your Client ID and Client Secret** in Settings (the same ones the proxy used, from
   developers.monzo.com) and set the **Redirect URL** to the one registered on that client.
   v1 kept the credentials in the proxy, so Wealthfolio does not have them. Until you enter
   them, the carried-over connection works until its access token expires (up to 6 hours),
   then cannot be renewed.
4. If renewal is rejected, or anything looks off, press **Reconnect Monzo** and go through
   the paste-the-URL step again. Your account mapping and history are kept.
5. Stop and remove the proxy container (`monzo-proxy`) and delete its checkout. It is no
   longer used and the `proxies/monzo` directory no longer exists in this repo.

### Fixing cash imported by v1

v1 imported cash activities with a bare currency code (`GBP`) as the symbol, which Wealthfolio
values as a *security*, inflating account totals. v2 uses `$CASH-GBP`. Rows imported by v1 are
still recognised when reconciling, so nothing is duplicated, but they keep the bad symbol. To
clean up, delete the affected activities (or the Monzo cash accounts) in Wealthfolio, press
**Reset sync history**, sync, and re-import any older history from CSV.

The merchant name now comes from Monzo's expanded merchant object rather than the raw card
description, so comments on newly imported rows may read slightly differently from v1 rows.
Only rows near the sync boundary could be affected, and only if Monzo returns them again.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Monzo says it "couldn't identify who you'd like to connect" | The redirect URL does not match the one on your Monzo client exactly. Fix one of them, save, and click Connect again. |
| **403** / "Monzo refused access" | The connection has not been approved in the **Monzo app** yet. Approve it there, then sync again. If you already did, disconnect and reconnect. |
| "Monzo rejected the code" | The code was used already, expired, or the client ID/secret/redirect URL differ from the registered ones. Press **Connect Monzo** (or **New link**) and paste a fresh result straight away. |
| "state does not match" | The pasted URL is from an older attempt. Use the newest link, or paste only the `code`. |
| "Monzo rejected the saved refresh token" | The tokens are no longer valid or the client details do not match. Check Settings, or reconnect. |
| "Enter your Monzo client ID and secret" | Upgrading from v1: see the upgrade notes. |
| Only 90 days of transactions | A Monzo API limit; use CSV import for older history. |
| "Account mapping is out of date" | A mapped Wealthfolio account was deleted. Open Settings to re-create and re-map it. |

## Security

- The **client secret**, **access token** and **refresh token** are stored in Wealthfolio's
  OS keyring (`secrets`). The access token is only ever used through the network broker's
  `auth` option: the add-on never reads it back, and Wealthfolio injects the
  `Authorization` header itself.
- The client secret is sent only to `api.monzo.com`, in the token exchange and refresh. The
  add-on can reach no other host.
- Non-secret state (client ID, redirect URL, token expiry, account mapping, last-sync time,
  category labels) is kept in add-on storage.
- The add-on runs in Wealthfolio's sandbox: no direct network access, no popups, no
  browser storage.

### Storage layout

| Where | Key | Content |
|---|---|---|
| secrets | `monzo_client_secret` | OAuth client secret |
| secrets | `monzo_access_token` | access token (broker `auth` only) |
| secrets | `monzo_refresh_token` | refresh token |
| storage | `monzo_client_id` | OAuth client ID |
| storage | `monzo_redirect_url` | registered redirect URL |
| storage | `monzo_expires_at` | access token expiry (ms since epoch) |
| storage | `monzo_oauth_state` | `state` of a connection in progress |
| storage | `monzo_account_mapping` | Monzo account id -> Wealthfolio account id |
| storage | `monzo_last_sync` | `since` watermark for the next sync |
| storage | `monzo_last_run` | when the last sync finished (display) |
| storage | `monzo_category_labels` | custom category labels |

## Development

```bash
cd addons/monzo
pnpm test            # unit tests (OAuth, pagination, reconcile, migration, CSV, ...)
pnpm type-check
pnpm bundle          # build + package dist/monzo-addon-<version>.zip
```

Shared helpers (CSV parsing, cash symbol, reconcile, network broker wrappers, sync progress
and page shell) come from `@wf-addons/kit` in `packages/addon-kit`.

```
addons/monzo/
├── manifest.json
├── package.json
└── src/
    ├── addon.tsx              # sandbox entry: routes + v1 migration
    ├── constants.ts           # add-on id, endpoints, storage/secret keys
    ├── types.ts
    ├── lib/
    │   ├── oauth.ts           # state, auth URL, paste parsing, token request bodies
    │   ├── auth.ts            # settings, token storage, code exchange, refresh
    │   ├── monzo-client.ts    # accounts + paginated transactions via the broker
    │   ├── sync.ts            # fetch -> filter -> reconcile -> import
    │   ├── mapper.ts          # Monzo transaction -> cash activity (+ filters)
    │   ├── csv-parser.ts      # Monzo CSV export
    │   ├── migrate.ts         # v1 -> v2 state migration
    │   ├── accounts.ts        # Monzo -> Wealthfolio account mapping
    │   ├── clipboard.ts
    │   └── category-map.ts
    ├── hooks/use-sync.ts
    ├── components/status-card.tsx
    └── pages/                 # dashboard, settings, csv-import
```

## License

GPL-3.0-only
