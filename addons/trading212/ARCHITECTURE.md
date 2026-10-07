# Architecture

Developer-facing documentation for the Trading 212 → Wealthfolio add-on. For
install/deploy instructions see [README.md](README.md).

## Overview

Two cooperating pieces:

```
┌─────────────────────────────┐         ┌──────────────────────┐        ┌──────────────────────┐
│ Wealthfolio (host app)      │         │ Stateless proxy      │        │ Trading 212 API      │
│                             │         │ (FastAPI, main.py)   │        │ live/demo.trading212 │
│  ┌───────────────────────┐  │  HTTPS  │                      │ HTTPS  │                      │
│  │ Trading 212 add-on    │──┼────────▶│  forwards request +  │───────▶│  /api/v0/equity/...  │
│  │ (addon.js, in webview)│  │  + key  │  Authorization hdr   │        │                      │
│  └───────────────────────┘  │◀────────│  (holds nothing)     │◀───────│                      │
│   keyring  ▲  market-data    │  JSON   └──────────────────────┘        └──────────────────────┘
│   (API key)│  searchTicker   │
└────────────┴────────────────┘
```

- **The add-on** runs inside Wealthfolio's webview. It owns all state: the API
  key (in the OS keyring), the account mapping, the sync watermark, the symbol
  cache. It calls the host SDK (`ctx.api.*`) for accounts, activity import,
  symbol search, and secret storage.
- **The proxy** exists for one reason: Trading 212's API does not send permissive
  CORS headers, so a browser/webview cannot call it directly. The proxy forwards
  the add-on's request (including the `Authorization` header the add-on supplies)
  to Trading 212. It is stateless and credential-free.

### Why this split?

The API key grants full read access to the user's account, so it must be stored
securely (Wealthfolio's encrypted keyring) and never baked into a server. Keeping
the proxy stateless means the only place the credential lives is the keyring; the
proxy just relays bytes and can be deployed anywhere without secret management.

## Module responsibilities

| Path | Responsibility |
|------|----------------|
| `main.py` | Stateless FastAPI proxy. Forwards 6 read endpoints; selects upstream host from a fixed `live`/`demo` allow-list; passes through `x-ratelimit-*` headers. |
| `addon/src/addon.tsx` | Add-on entry point. Registers the sidebar item and the dashboard/settings routes. |
| `addon/src/types.ts` | TypeScript shapes for the Trading 212 payloads we consume + internal `T212Settings`/`T212Connection`/`SyncResult`/`MultiSyncResult`. |
| `addon/src/lib/proxy-client.ts` | HTTP client to the proxy: builds the auth header, retries on `429`, exposes per-endpoint + cursor-paging methods. One instance per connection. |
| `addon/src/lib/symbol-resolver.ts` | Maps a Trading 212 ticker to a Wealthfolio symbol via `market.searchTicker`, with in-memory + persisted caching. Shared across all connections (mapping is account-independent). |
| `addon/src/lib/mapper.ts` | Pure functions: Trading 212 order/dividend/transaction → `ActivityImport` (take `accountId` as a param). |
| `addon/src/hooks/use-config.ts` | All keyring reads/writes (shared settings, the connections list, per-connection sync state, shared symbol map) + one-time legacy migration. |
| `addon/src/hooks/use-sync.ts` | Sync orchestration: `syncAll()` loops connections sequentially → fetch → resolve → map → `checkImport` → `import`. |
| `addon/src/pages/settings-page.tsx` | Shared proxy/env settings, connected-accounts list, "Add account" form (Invest/ISA picker → editable name), per-row remove/reset. |
| `addon/src/pages/dashboard-page.tsx` | "Sync All" button + per-account status/result cards. |

## Trading 212 API specifics

Base URLs (chosen by the `env` query param the add-on sends to the proxy):
`https://live.trading212.com` and `https://demo.trading212.com`. All endpoints
are under `/api/v0/equity`.

**Authentication** — two schemes, both supported. `proxy-client.ts#buildAuthHeader`
emits HTTP Basic (`base64(keyId:secret)`) when an API secret is present, otherwise
the raw key (legacy). The proxy forwards whichever header it receives.

**Endpoints consumed** (all GET, all read-only scopes):

| Proxy path | Upstream | Used for |
|------------|----------|----------|
| `/account/summary` | `equity/account/summary` | Account id + primary currency (connect/account-create). |
| `/positions` | `equity/positions` | (Reserved — not used in the sync path.) |
| `/instruments` | `equity/metadata/instruments` | (Reserved — heavy/cached; not used in the sync path.) |
| `/orders` | `equity/history/orders` | Filled trades → BUY/SELL. |
| `/dividends` | `equity/history/dividends` | Dividends + interest. |
| `/transactions` | `equity/history/transactions` | Deposits/withdrawals/fees/transfers. |

**Rate limits** are strict and per-endpoint (instruments 1/50s, history 6/min,
account 1/5s). `proxy-client.ts` retries once on `429`, honoring `Retry-After` /
`x-ratelimit-reset`. A first sync over a long history can therefore take a while.

**Pagination** is cursor-based: each list response carries `items[]` and a
`nextPagePath` string. `cursorFromNextPage()` extracts the `cursor` query value to
request the next page; a `null` `nextPagePath` ends the loop.

## Sync flow (`use-sync.ts`)

`syncAll()` loads the shared settings + the connections list, builds **one shared**
`SymbolResolver` from the cached symbol map, then iterates the connections
**sequentially** (Trading 212 is rate-limited; parallel keys would multiply 429s).
Each connection is synced by `syncOne()`; one failing key is caught and reported per
account without aborting the rest. After the loop the symbol cache is written **once**.

`syncOne(ctx, settings, conn, resolver)`:

1. Build a `Trading212ProxyClient` from `connectionConfig(settings, conn)`; load this
   connection's `lastSync` watermark + imported-ref set from `t212_sync_{id}`.
2. **Orders** and **dividends**: page newest-first via `collectSince`, stopping once
   a record predates `lastSync`. **Transactions**: use the server-side `time` filter
   from `lastSync`, then follow the cursor.
3. For each record not already in this connection's imported-ref set:
   - Orders/dividends: resolve the symbol (see below). A trade with no resolvable
     symbol is skipped and counted as `unresolved`. Interest needs no symbol.
   - Build the `ActivityImport` via the mapper (with `conn.accountId`) and a **stable `id`**.
4. `checkImport(activities)` → drop rows flagged `duplicateOfId` or `isValid === false`
   → `import` the rest into `conn.accountId`.
5. Record the ids of imported + duplicate rows into this connection's imported-ref set,
   and set its `lastSync` watermark to now. Return a `SyncResult` tagged with the
   connection/account.

### Tracking modes (HOLDINGS vs TRANSACTIONS)

Each connection syncs into its Wealthfolio account in one of two modes, chosen **at
setup** (the "Sync mode" picker; default **Holdings**) and stored on the connection
(`trackingMode`, absent ⇒ `TRANSACTIONS` for connections created before this existed):

- **TRANSACTIONS** — the full flow above: CSV-export backfill on the first sync, JSON
  incrementals thereafter. Gives complete history/performance.
- **HOLDINGS** — `syncHoldings()` fetches `account/summary` + `positions` and writes a
  single **snapshot** via `snapshots.save(accountId, holdings, cashBalances)` — instant,
  no history, no rate-limited backfill. Positions whose symbol can't be resolved are
  counted as `unresolved` and omitted.

The Wealthfolio account's own `trackingMode` is **authoritative**: the SDK's `accounts`
API has no `update`, so the add-on can only set the mode at `accounts.create(...)`. If a
user changes the mode natively in Wealthfolio afterwards, `syncOne` **detects the drift**
(live `account.trackingMode` ≠ the connection's recorded mode). Because reconciling means
deleting the data synced under the old mode, the dashboard shows an **AlertDialog** and only
the confirmed connections (passed to `syncAll(confirmedModeSwitches)`) are cleared via
`clearAccountData` (`activities.saveMany({deleteIds})` for TRANSACTIONS, `snapshots.delete`
per date for HOLDINGS) and re-synced; unconfirmed drifted connections are skipped.

### Background auto-sync (`auto-sync.ts`)

HOLDINGS snapshots are **keyed by calendar date** (`snapshots.save` stamps the day when no
date is passed), so a daily cadence builds a position history; only a *same-day* re-sync
overwrites the day's snapshot. To make that history accrue without a manual click, the
add-on runs a small background scheduler.

`startAutoSync(ctx)` is started from `enable()` (so it runs regardless of which page is
open) and torn down in `onDisable`. It fires on three triggers — shortly after load, hourly
while the app stays open (to cross midnight), and on `events.portfolio.onUpdateComplete` —
and on each one syncs only the connections that are **due**. `isDueForBackgroundSync` deems a
connection due when it has a prior `lastSync` *and* that sync was on an earlier calendar day:

- Requiring a prior sync keeps the **first** sync (a multi-minute backfill for TRANSACTIONS)
  a deliberate manual action — the scheduler only *refreshes* already-synced accounts.
- The calendar-day gate yields at most one background sync per day and makes the
  portfolio-update trigger self-limiting (once today's sync lands, the account isn't due
  again, so the snapshot it writes can't loop back through `onUpdateComplete`).

Both modes participate (HOLDINGS gets a fresh daily snapshot; TRANSACTIONS a cheap JSON
incremental). The core sync was lifted out of the React hook into the framework-agnostic
`runSyncAll(ctx, { onlyConnectionIds })` so both the dashboard button and the scheduler share
it. Background runs pass an empty `confirmedModeSwitches`, so a drifted account is **skipped**
(never cleared) until the user confirms in the dashboard. A re-entrancy guard and the
`autoSync` setting (opt-out, default on, toggled in Settings) gate the whole thing.

### UI (`pages/`, `components/`)

The two pages render through a shared `PageShell` (Phosphor icon + heading + actions slot) and
use `@wealthfolio/ui` primitives (`Switch`, `ToggleGroup`, `Tabs`, `Tooltip`, `ScrollArea`,
`EmptyPlaceholder`, `AlertFeedback`, `ActionConfirm`, semantic `Badge` variants) to match the
first-party look.

- **`SyncActivity`** (`components/sync-activity.tsx`) renders the live sync view: a 4-node phase
  stepper (Export → Match → Import → Done) driven by the current `SyncProgress.phase`, the
  determinate/indeterminate `Progress` bar, and a scrolling **activity feed** of every step the
  sync emitted. The feed is built from `useSync`'s `steps: SyncStep[]`, populated by appending
  each `onProgress` event (consecutive duplicates coalesced so chunked imports show as one row
  with a live `current/total`).
- **`ConnectionCard`** shows per-account results with `StatTiles` (Imported / Duplicates /
  Unmatched / Card) on top and a **Summary / Symbols / Log** tab block. *Summary* is the per-
  type activity breakdown (`SyncResult.breakdown`, populated from the existing `tally`).
  *Symbols* renders the persisted **symbol map** (account-independent; from `getSymbolMap`) as
  matched ticker → symbol@exchange rows plus the known unresolved set, so the user can see what
  resolved and what didn't without reading the raw log. *Log* keeps the raw verbose lines.
- **`ConnectionHealth`** runs the existing `getAccountSummary` probe and surfaces `ok`/`auth`/
  `err` as semantic Badge variants (`success`/`destructive`/`warning`) with a coloured dot.
- Relative timestamps (`relativeTime`, `lib/format.ts`) are used everywhere a last-sync time is
  shown, with the absolute time on a `Tooltip`.

### Activity mapping (`mapper.ts`)

| Trading 212 source | `activityType` | Notes |
|--------------------|----------------|-------|
| Filled order, `side: BUY` | `BUY` | `quantity`/`unitPrice` from the fill; `fee` = Σ taxes; non-`TRADE` fills (splits/distributions) are skipped. |
| Filled order, `side: SELL` | `SELL` | |
| Dividend, `type !== INTEREST` | `DIVIDEND` | symbol resolved from the embedded instrument. |
| Dividend, `type === INTEREST` | `INTEREST` | no symbol. |
| Transaction `DEPOSIT` | `DEPOSIT` | |
| Transaction `WITHDRAW` | `WITHDRAWAL` | amount stored positive. |
| Transaction `FEE` | `FEE` | |
| Transaction `TRANSFER` | `TRANSFER_IN` / `TRANSFER_OUT` | by sign of amount. |

Stable id scheme (drives idempotency): `t212-order-{orderId}`,
`t212-div-{reference}`, `t212-txn-{reference}`.

### Card spending → dedicated account + category map (`spending-category.ts`, opt-in)

Trading 212 issues a debit card, and its CSV export carries card rows (`Card debit`/`Card
credit` + `Spending cashback`) with a trailing **`Merchant category`** column
(`RETAIL_STORES`, `TRANSPORT`, `RESTAURANTS`, …). When the **"Card transactions → Separate
account"** setting (`T212Settings.extractCard`, default off) is on, `syncOne` (TRANSACTIONS
mode) calls `ensureCardAccount` to create a dedicated **CASH** account `"<name> Card"`
(`providerAccountId: "${id}-card"`, recorded as `T212Connection.cardAccountId`) and routes
card rows there via `mapCsvRow(row, accountId, resolver, cardAccountId)` — so card spend stays
out of the investing account and Wealthfolio 3.5.0's Spending module can categorise it.

`spending-category.ts` maps the T212 `Merchant category` onto a Wealthfolio spending label
(`mapSpendingCategory`), appended to the activity comment as `"MERCHANT · Label"`. The add-on
SDK (3.3.0) has **no structured spending-category field** on `ActivityImport`, so the label is
surfaced via the comment (Wealthfolio's own rules/AI engine remains authoritative); the map is
isolated so it can be wired to a real categories API if one ships.

Because card data is **CSV-only** (the JSON `/transactions` feed has no card type), the card
pipeline runs on its own watermark (`ConnectionSyncState.cardLastSync`): the first sync
backfills card history via the windowed CSV export, and incremental syncs top it up with a
recent window (`fetchCardActivities`, deduped via `importedRefs`). The card account is an
independent CASH activity account, so extraction works in **both** modes: TRANSACTIONS full
backfills route card rows inline through the shared CSV loop, while HOLDINGS syncs (and
incremental TRANSACTIONS syncs) import them via `syncCardAccount` alongside the positions
snapshot.

### Symbol resolution (`symbol-resolver.ts`)

Trading 212 tickers look like `AAPL_US_EQ`. `resolveTicker` queries the host
`market.searchTicker` and resolves in two stages:

1. **ISIN is authoritative.** A search *by ISIN* returns the security's own
   listings, so if its best hit agrees with the expected currency/exchange we
   trust it directly. This resolves `META` from a `FB_US_EQ` ticker (the base
   `FB` now belongs to a different security) and keeps a stock's primary listing
   over a same-name Cboe Europe mirror.
2. **Fall through to a pooled base-ticker + name search.** When the ISIN hit
   *contradicts* the expectation (TSMN/MXN for a USD ticker, a Canadian bank's
   TSX line, BioNTech's Hamburg `22UA`), the candidates from the base-ticker and
   name queries are pooled and `pickBest` picks the right listing from the union.

`pickBest` runs five filters before ranking by `isExisting`/score:

1. **Currency** — drop results whose currency doesn't match the instrument's (or, as
   fallback, the currency implied by the `_US_`/`_GB_`/… market segment). Stops a
   NYSE ADR being silently replaced by a Mexican cross-listing (TSM vs TSMN.MX).
2. **Exchange MIC** — when the market segment maps to known MICs, prefer those
   listings. Stops `RR_GB_EQ` resolving to `RR` (Richtech, XNAS) instead of
   `RR.L` (Rolls-Royce, XLON).
3. **ISIN-shaped symbols** — drop hits whose symbol *is* an ISIN (or starts with
   one, e.g. `IE00BFMXXD54.SG`). These come from prior bad imports where
   Wealthfolio stored the asset under its ISIN and `isExisting:true` then boosted
   it above the genuine ticker.
4. **Cboe Europe / MTF deprioritisation** — the CXE/DXE/BXE venues mirror a
   stock's primary listing under a mangled symbol (`RRL`/CXE for `RR`/XLON,
   `VUAAM`/DXE for `VUAA`/XMIL). When a non-MTF listing is also present, drop the
   MTF ones so the primary exchange wins (kept only if they're the sole option).
   Catches venues the segment→MIC map in step 2 doesn't cover. US `BATS` (Cboe
   BZX) is excluded — it's a legitimate primary venue. Runs *after* the ISIN-shape
   drop, so an EUR position whose only real ticker is an MTF listing (`VUAAM`/DXE,
   its sole non-MTF sibling being an ISIN-shaped hit) still resolves instead of
   being stranded with nothing and skipped.
5. **Base-ticker exact match** — within survivors, prefer one whose symbol equals
   the base ticker (or `base.SUFFIX`). Deterministic tiebreaker for same-currency,
   same-exchange collisions like TSM vs TSMN at XNYS/XNAS.

`resolveTicker` returns `{ symbol, exchangeMic? }`; the HOLDINGS sync forwards the
MIC into `SnapshotHoldingInput.exchangeMic` so Wealthfolio pins the asset to the
right listing (without it, ticker collisions resolve to Yahoo's default). It also
takes an optional `onDiag` callback: on a live lookup (cache miss) the HOLDINGS
sync logs the raw candidate pool + chosen symbol into the sync report's Details
panel, so cross-listing resolution can be verified against real search output.

When two positions still resolve to the **same** symbol — a same-ISIN
cross-listing the search couldn't keep distinct (e.g. US `NVDA` + its Xetra leg)
— `mergeHoldingsBySymbol` sums their quantity and quantity-weights the average
cost before the snapshot is saved. A snapshot keeps one holding per symbol, so
without this the second leg would silently overwrite the first and its value
would vanish; merging preserves the total.

`SymbolResolver` caches each lookup (including known misses, stored as `""`) for
the duration of a sync and persists the map to the keyring. Values are encoded
`"SYMBOL"` (no MIC) or `"SYMBOL|MIC"`; back-compat read-only for pre-v1.7.2
entries. "Reset sync history" clears it.

## Idempotency model (defence in depth)

Three independent guards ensure re-syncs never duplicate:

1. **Watermark** (`lastSync`, per connection) — we only fetch records newer than the last sync.
2. **Imported-ref set** (per connection) — locally remembers every reference already
   accounted for, so anything that slips past the watermark is filtered before import.
   It is **per connection** because Trading 212 reference ids are scoped per T212
   account — an Invest and an ISA account can each independently produce `order id 1`,
   so a global set would wrongly drop the second.
3. **Host `checkImport`** — Wealthfolio's own duplicate detection is the final
   backstop; rows flagged `duplicateOfId` are dropped.

The local guards exist because the exact key Wealthfolio uses for `checkImport`
deduplication is not documented; the stable `id` is supplied to give it the best
chance, and the watermark + ref-set make the add-on correct regardless. Note the
stable `id` (`t212-order-{id}` etc.) is **not** namespaced by account; if two of your
T212 accounts ever shared a reference id and Wealthfolio's `checkImport` dedup turned
out to be global, the second could be dropped. T212 ids are effectively per-user-unique,
so this is a documented, low-risk limitation rather than an observed problem.

## Security model

- API key/secret live only in Wealthfolio's keyring (`ctx.api.secrets`), entered via
  password fields, never logged.
- The proxy stores no credentials and only ever connects to the fixed `live`/`demo`
  allow-list — a caller cannot point it at an arbitrary host (no SSRF).
- `.env` is git-ignored; the proxy needs no env credentials (only an optional `PORT`).

## Stored keyring keys (`use-config.ts`)

| Key | Contents |
|-----|----------|
| `t212_settings` | `{ proxyUrl, env }` — shared by all connections |
| `t212_connections` | `T212Connection[]` = `{ id, name, apiKey, apiSecret?, accountId }` |
| `t212_sync_{id}` | Per-connection `{ lastSync, importedRefs[] }` |
| `t212_symbol_map_v6` | Shared `{ ticker: "SYMBOL\|MIC" }` cache (`""` = known miss; bare `"SYMBOL"` = MIC unknown). v1–v5 are deleted by migration. |

### Migration from the single-account layout

`migrateLegacyConfig()` runs once at page mount (dashboard + settings). If the legacy
keys `t212_config` + `t212_account_id` exist and no `t212_connections`/`t212_settings`
do, it writes `t212_settings`, creates one connection named `"Trading 212 (Invest)"`
linked to the legacy account, copies `t212_last_sync`/`t212_imported_refs` into
`t212_sync_{id}`, deletes the four legacy keys, and drops any prior symbol
caches (`t212_symbol_map`, `t212_symbol_map_v2`, `t212_symbol_map_v3`,
`t212_symbol_map_v4`, `t212_symbol_map_v5`) so v6 starts fresh. It is idempotent.

## Build, test, release

```bash
cd addon
npm install
npm run test         # vitest — mapper, symbol resolver, sync orchestration
npm run type-check   # tsc --noEmit (strict)
npm run bundle       # vite build → dist/addon.js + zip
```

Releases are cut by `.github/workflows/release.yml` on a `v*` tag (or manual
dispatch): it installs, tests, type-checks, builds, and attaches
`trading212-addon.zip` to a GitHub Release. Note this workflow runs only on tags,
not on PRs.

## Extension points & known limitations

- **Stock splits / distributions**: non-`TRADE` fills are currently skipped. Mapping
  them to `SPLIT` is the natural next step (`mapper.ts`).
- **Instruments metadata / positions**: the proxy exposes these and `types.ts`/the
  client model them, but the sync path relies on the instrument data embedded in
  each order/dividend instead (avoids the 5 MB, 1-req/50s instruments call). They're
  available if a future feature needs a position snapshot or a metadata fallback.
- **Auth scheme**: confirm key+secret vs legacy single-key against the user's actual
  key on first connect (the settings form supports both).
- **History depth**: bounded by what Trading 212's history endpoints return; there is
  no separate backfill of pre-API-era data via these endpoints.
