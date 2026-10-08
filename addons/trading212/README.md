# Trading 212 → Wealthfolio Addon

Automatically sync your **Trading 212** investment account into Wealthfolio via
Trading 212's official [public API](https://docs.trading212.com/api): trades,
dividends, interest, deposits, withdrawals and fees — each tagged to the correct
Wealthfolio activity type, with tickers matched to Wealthfolio symbols automatically.

Part of the [Wealthfolio custom add-ons monorepo](../../README.md). Requires
**Wealthfolio 3.9+** (add-on SDK 3.9.0).

**Architecture**: a TypeScript/React add-on that runs in Wealthfolio's sandbox and calls
the Trading 212 API **directly** through the host's network broker — there is no proxy
or server to run any more. Your API key ID and secret live in Wealthfolio's encrypted
keyring and are attached to requests by the host, never by the add-on. For a developer
deep-dive (data flow, modules, design decisions), see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## No proxy any more (v2.0)

Wealthfolio 3.6+ runs add-ons in a sandboxed iframe with no `fetch`; outbound HTTPS goes
through `ctx.api.network.request`, which the host performs server-side — so Trading 212's
lack of CORS headers no longer matters. v1.x needed a small Python proxy; **v2.0 removes
it** (the `proxies/trading212` Docker/Unraid deployment is gone — you can stop and delete
that container).

The manifest declares the network hosts the add-on may reach, and Wealthfolio asks you to
approve them when you install it:

| Host | Why |
|------|-----|
| `*.trading212.com` | `live.trading212.com` / `demo.trading212.com` — the Trading 212 REST API |
| `*.amazonaws.com` | Trading 212 serves CSV exports (used for the full-history backfill) from a pre-signed cloud-storage URL. The exact host of that `downloadLink` isn't documented, so the broad AWS wildcard is declared. If an export download is ever refused, the sync log and error name the exact host — add it to `network.allowedHosts` in `manifest.json` and rebuild. |

The signed export URL is fetched **without** any credentials; the API key is only ever
attached (by the host) to `*.trading212.com` requests.

---

## Building

From the repo root (or this folder):

```bash
pnpm test
pnpm type-check
pnpm bundle        # creates dist/trading212-addon-<version>.zip
```

---

## Quick start

### 1. Create a Trading 212 API key

1. In the Trading 212 app/web (Invest or Stocks ISA), go to **Settings → API**.
2. Generate a key with at least these **read** scopes: `metadata`, `account`,
   `portfolio`, `history:orders`, `history:dividends`, `history:transactions`.
3. Copy the **API key ID** and the **API secret** — **both are required**. (Legacy
   single-value keys can no longer be used: Wealthfolio's network broker only supports
   HTTP Basic auth built from a key ID + secret.)

> Keys are environment-specific: a **Live** key only works against Live, a
> **Demo/Practice** key only against Demo.

### 2. Install the add-on

Build the ZIP (above), then in Wealthfolio: **Settings → Add-ons → Install from ZIP**, and
approve the network hosts.

### 3. Connect & sync

1. Open **Trading 212** in the sidebar → **Settings**.
2. Under **Connection**, pick **Live** or **Demo** and click **Save settings**. (Shared by
   every account.)
3. Under **Add account**, pick the type (**Invest** or **Stocks ISA** — this sets the
   account name, which you can edit), choose a **Sync mode** (see below), then enter that
   account's **API key ID** and **API secret** and click **Add account**. The credentials
   are checked against Trading 212 first. A Wealthfolio **securities** account is created
   automatically in the chosen mode. Repeat to add more keys — each Trading 212 account has
   its own key.
4. Go back to the dashboard and click **Sync All**.

To rotate a key, use **Update key** on the account row in Settings (**Add credentials** on a flagged one): the new key ID + secret
are verified before they replace the stored ones.

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
> under **Settings → Connection → Automatic sync**.

> **Card transactions (off by default):** if you use the Trading 212 debit card, turn on
> **Settings → Connection → Extract card transactions**. The add-on then
> creates a dedicated **"&lt;name&gt; Card"** cash account and routes your card spending,
> refunds and cashback there (instead of mixing them into the investing account), tagging each
> with the Trading 212 merchant category mapped to a Wealthfolio spending label
> (`"SAINSBURYS · Shopping"`). Each sync also keeps one categorisation rule per label
> (Settings → Spending → Rules, "Trading 212 card: Shopping" and so on) that files those rows
> under the matching Wealthfolio spending category, and re-runs rules over uncategorised
> activities. Categories you set by hand are never overwritten. Works in both Holdings and
> Transactions modes.
>
> You can also choose the **card account type** (Cash or Credit Card) right below the toggle.
> *Cash* is accurate for the debit card; *Credit Card* models it as a liability so Wealthfolio
> can link payments from a tracked cash account as transfers (avoiding double-counted spending).
> The type is applied when the card account is first created — to retype an existing one, use
> Wealthfolio's **Update Account** dialog.

> **Renaming / removing:** rename or delete the accounts in Wealthfolio's own **Accounts**
> page. Removing an account in the add-on only forgets the stored credentials — the Wealthfolio
> account and its imported activity stay.

---

## How it works

### Activity mapping

| Trading 212 source | Wealthfolio activity |
|--------------------|----------------------|
| Filled order (BUY/SELL) | `BUY` / `SELL` |
| Dividend | `DIVIDEND` |
| Interest (dividend feed, interest on cash, share-lending interest) | `INTEREST` |
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
already-imported Trading 212 reference ids, and compares what it fetched with what the
account already holds (by count, so two genuinely identical same-day rows — say two £50
deposits — both land instead of being merged by Wealthfolio's content-hash duplicate
check) — so re-syncing never creates duplicates. Use the
per-account **Reset sync** button in Settings to force a full re-scan of that account.

### Rate limits & the 2 MB response cap

Trading 212 enforces strict per-endpoint limits (instruments 1/50s, history
6/min, account 1/5s). The client backs off and retries on `429`, honouring
`Retry-After` / `x-ratelimit-reset`, so a first sync of a long history can take a
little while.

Card transactions only exist in CSV exports, and Trading 212 takes 15–80 s to prepare each
export under its rate limits. So recent card history is refreshed **at most every 3 hours**
(the sync log says when the next refresh is due), an account whose card history turns out
to be empty is not walked again, and Stocks ISA connections never export card history.
Connections carried over from v1 are recognised as ISA by their name (e.g.
"Trading 212 (ISA)").

### Cash ISA (CSV import)

Trading 212's API only covers Invest and Stocks ISA accounts, so a **Cash ISA** cannot be
connected with an API key. Import its history from the app instead:

1. In the Trading 212 app, open the Cash ISA → History → Export, and save the CSV
   (`Action, Time (UTC), Notes, ID, Total, Currency (Total)`). Export as many date ranges
   as you need.
2. In Wealthfolio, open **Trading 212 → Settings → Add account**, pick **Cash ISA**, choose
   one or more CSV files, check the deposit / withdrawal / interest counts, and press
   **Import**.

The first import creates a **"Trading 212 Cash ISA"** Cash account (named in the form, or
pick an existing Cash account). After that the Cash ISA is listed on the dashboard and under
**Connected accounts**; its **Import CSV** button brings in newer exports. Deposits, withdrawals and interest become `DEPOSIT`, `WITHDRAWAL` and `INTEREST`
cash activities. Re-importing, or importing overlapping exports, adds nothing twice: rows
are recognised by their Trading 212 id (taken from the Notes when the ID column is empty,
or derived from the row when there is none), and two genuinely identical deposits on the
same day are both kept.

### "Wealthfolio has not approved network access to …"

Wealthfolio only lets an add-on reach the network hosts you ticked in its permission
dialog, and installing an update that asks for a new permission can leave them unticked.
Open **Settings → Add-ons → Trading 212 Sync → Permissions**, tick `*.trading212.com` and
`*.amazonaws.com` (where the CSV exports download from), save, and sync again.

Wealthfolio's network broker also rejects any response body over **2 MB**. The add-on
works around it where it matters:

- **CSV export backfill** — if a downloaded export is "too large", that time window is
  split in half and exported as two smaller reports, recursively down to 7 days, then the
  CSVs are stitched back together. (Only an extremely busy 7-day window would still fail.)
- **Instruments metadata** (~5 MB upstream) can never be fetched; it is only requested as
  an optional enrichment for Holdings syncs when a position lacks ISIN/currency, and a
  failure is just logged.

### Amounts (Wealthfolio 3.8+ "final cash")

Wealthfolio now treats an activity's `amount` as the final cash that moved, fees and taxes
included. Accordingly: **BUY/SELL** carry quantity, price and `fee` (in the trade currency)
and omit `amount`, so Wealthfolio derives the final total itself (and gets an
account-currency `fxRate` only for genuinely cross-currency trades); **deposits,
withdrawals, transfers, fees, dividends and interest** carry the exact cash `amount` and
never a separate fee.

---

## Security

- The API key ID/secret live only in Wealthfolio's OS keyring (encrypted at rest), as one
  secret per connection (`t212_auth_<connectionId>` = base64 of `keyId:secret`). The add-on
  never reads them back: it only names the secret in `auth: { type: "basic", secretKey }`
  and the host injects the `Authorization` header.
- Everything that isn't a credential (connections list, settings, sync state, symbol
  cache) is in add-on storage. A connection record keeps only the last 4 characters of the
  key ID, for display.
- Requests can only reach the hosts declared in the manifest, over HTTPS.

---

## Upgrading from v1.x

v1 kept everything — including the API key + secret and your proxy URL — in the keyring.
On first start v2 migrates automatically (idempotent, nothing to do):

1. Each connection's key ID + secret → a per-connection secret `t212_auth_<id>`.
2. The connections list (without keys), shared settings (the proxy URL is dropped), each
   connection's sync watermark/imported-reference set, and the symbol cache → add-on
   storage. The old keyring entries are deleted.
3. **Connections that only had a legacy single API key (no secret) are kept but flagged
   "Needs credentials"** and skipped by sync (and the background scheduler) until you open
   **Settings → Update key** and enter the key ID + secret. Their sync history is
   preserved, so re-entering credentials resumes where they left off.
4. You can stop and remove the old proxy container.

No re-import is needed: stable activity ids and the sync watermark carry over.

---

## Project structure

```
addons/trading212/
├── manifest.json
├── ARCHITECTURE.md
└── src/
    ├── addon.tsx             # registerPages + migration + auto-sync (sandbox entry)
    ├── constants.ts          # ids, storage/secret key names, API base URLs
    ├── types.ts
    ├── lib/
    │   ├── t212-client.ts    # brokered API client: auth, paging, 429 backoff, export + window splitting
    │   ├── symbol-resolver.ts  # ticker → Wealthfolio symbol
    │   ├── mapper.ts / csv.ts  # T212 record → ActivityImport
    │   └── auto-sync.ts      # background scheduler
    ├── hooks/
    │   ├── use-config.ts     # storage/secret access + v1 → v2 migration
    │   └── use-sync.ts       # sync orchestration
    ├── components/           # connection card + health
    └── pages/                # dashboard, settings
```

Shared UI/helpers come from [`@wf-addons/kit`](../../packages/addon-kit).

---

## License

GNU GPL v3 — see [LICENSE](LICENSE).
