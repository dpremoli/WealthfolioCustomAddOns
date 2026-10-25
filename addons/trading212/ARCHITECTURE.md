# Architecture

Developer-facing documentation for the Trading 212 → Wealthfolio add-on. For
install/deploy instructions see [README.md](README.md).

## Overview

One piece, running in Wealthfolio's sandbox:

```
┌──────────────────────────────────────────┐            ┌──────────────────────┐
│ Wealthfolio (host app)                   │            │ Trading 212 API      │
│                                          │            │ live/demo.trading212 │
│  ┌────────────────────────────────────┐  │   HTTPS    │                      │
│  │ Trading 212 add-on (sandboxed      │──┼───────────▶│  /api/v0/equity/...  │
│  │ iframe, no fetch, opaque origin)   │  │ network    │                      │
│  └────────────────────────────────────┘  │ .request   │  signed CSV export   │
│   storage ▲   secrets ▲   market-data     │ (+ auth:   │  URL → *.amazonaws   │
│  (settings,│  (API key │  searchTicker    │  secretKey)│                      │
│   sync     │   ID +    │                  │◀───────────│                      │
│   state)   │   secret) │                  │   JSON/CSV │                      │
└────────────┴───────────┴──────────────────┘            └──────────────────────┘
```

- **The add-on** owns all state: connections, sync watermarks and the symbol cache (add-on
  storage), and the API credentials (keyring secrets). It calls the host SDK (`ctx.api.*`)
  for accounts, activity import, snapshots, symbol search, storage and secrets.
- **Network** — Wealthfolio 3.6+ runs add-ons in a sandboxed iframe (opaque origin, CSP
  `connect-src 'none'`): no `fetch`, no `localStorage`. The only way out is
  `ctx.api.network.request({ url, method, headers, body, auth, timeoutSecs })`, which the
  *host* executes server-side and returns `{ status, headers, body: string }`. Rules that shape
  the client: HTTPS only; the host must be in manifest `network.allowedHosts` (wildcards
  allowed) and approved at install; private/LAN hosts blocked; **redirects are not followed**;
  request body ≤ 1 MB; **response body ≤ 2 MB** (larger → a thrown "…response body is too
  large"); timeout default 10 s, max 120 s; non-2xx is returned, not thrown.
- **No proxy.** v1.x needed a stateless Python CORS proxy because a webview can't call
  Trading 212 directly. The host performs the request, so CORS is moot and the proxy (and its
  Docker/Unraid deployment) is gone.

### Why credentials never touch add-on code

The add-on may **not** set an `Authorization` header. Instead it names a secret:
`auth: { type: "basic", secretKey: "t212_auth_<id>" }`, and the host injects
`Authorization: Basic <secret>` (needs the `secrets` → `use` permission). The stored secret is
therefore already the base64 of `keyId:secret`. The add-on writes it once (on connect /
"Update key") and never reads it back; only the last 4 characters of the key ID are kept in
plain storage for display. Consequence: the old single-value `Authorization: <key>` scheme
can no longer be expressed, so a key ID **and** secret are required.

## Module responsibilities

| Path | Responsibility |
|------|----------------|
| `src/addon.tsx` | Sandbox entry. `registerPages` (dashboard + settings), kicks off the v1→v2 migration, starts the auto-sync scheduler, stops it in `ctx.onDisable`. Sidebar link + routes are declared in `manifest.json`. |
| `src/constants.ts` | `ADDON_ID`, route ids, storage/secret key names (`syncKey`, `authSecretKey`), the v1 key names, API base URLs. |
| `src/types.ts` | TypeScript shapes for the Trading 212 payloads we consume + internal `T212Settings`/`T212Connection`/`SyncResult`/`MultiSyncResult`. |
| `src/lib/t212-client.ts` | The API client on the kit's `brokeredRequest`: per-endpoint + cursor-paging methods, 429/transport retry, export lifecycle with **2 MB window splitting**, signed-URL download. One instance per connection. |
| `src/lib/symbol-resolver.ts` | Maps a Trading 212 ticker to a Wealthfolio symbol via `market.searchTicker`, with in-memory + persisted caching. Shared across all connections (mapping is account-independent). |
| `src/lib/mapper.ts` / `csv.ts` | Pure functions: Trading 212 order/dividend/transaction (JSON) and export CSV rows → `ActivityImport` (take `accountId` as a param). Final-cash and FX rules live here. |
| `src/lib/auto-sync.ts` | Background scheduler (startup, hourly, `onUpdateComplete`). |
| `src/lib/importer.ts` | `ActivityImporter`: reconcile (kit `selectNewActivities`, each account read once per sync) → `checkImport` → `activities.import` in 1000-row calls (the method is `importRows`: es-module-lexer reports a class method named `import` as a dynamic import, which the host rewrites into a syntax error), halving a refused call, keeping an `ImportUnit` (rows that must land in one call) together, and returning every row it could not import with Wealthfolio's reason. |
| `src/lib/card-funding.ts` | The transfer pair that funds each card row from the investing account (and the pairs for card rows imported before). |
| `src/lib/verify.ts` | The backfill check: Wealthfolio's holdings/cash vs `/positions` + `/account/summary`, and `PortfolioUpdates`, which waits for the recalculation an import queued. |
| `src/lib/interest.ts` | Optional folding of daily interest on cash into monthly totals during a backfill. |
| `src/hooks/use-config.ts` | All storage/secret reads/writes (shared settings, connections list, credentials, per-connection sync state, shared symbol map) + the one-time v1→v2 migration (`ensureMigrated`). |
| `src/hooks/use-sync.ts` | Sync orchestration: `runSyncAll()` loops connections sequentially → fetch → resolve → map → `checkImport` → `import`; `useSync` wraps it for React. |
| `src/pages/settings-page.tsx` | Shared env/auto-sync/card settings, connected-accounts list (health, update key, reset, remove), "Add account" form (Invest/ISA picker → editable name, key ID + secret). |
| `src/pages/dashboard-page.tsx` | "Sync All" button, "needs credentials" banner, per-account status/result cards. |
| `@wf-addons/kit` (+ `/ui`) | Shared: `registerPages`/`addonRoute`, `brokeredRequest`/`withQuery`/`retryDelayMs`, `jsonStore`/`migrateSecretsToStorage`, `cashSymbol`/`round2`, `appendStep`/`markLastDone`, `PageShell`/`StatTiles`/`SyncActivity`, `relativeTime`. |

## Trading 212 API specifics

Base URLs (chosen by the connection's environment): `https://live.trading212.com` and
`https://demo.trading212.com`. All endpoints are under `/api/v0/equity`.

**Authentication** — HTTP Basic from API key ID + secret, injected by the host from the
connection's `t212_auth_<id>` secret (see above). A 401 is mapped to `UNAUTHORIZED`
("Trading 212 rejected this API key"); keys are environment-specific (Live vs Demo).

**Endpoints consumed** (read-only scopes; paths relative to `/api/v0/equity`):

| Path | Used for |
|------|----------|
| `GET account/summary` | Account id + primary currency (connect/account-create, health probe, HOLDINGS cash). |
| `GET positions` | HOLDINGS snapshot. |
| `GET metadata/instruments` | Optional HOLDINGS enrichment only. ~5 MB upstream → **exceeds the 2 MB cap**, so it fails with "too large"; only attempted when a position lacks ISIN/currency, and a failure is just logged. |
| `GET history/orders` | Filled trades → BUY/SELL. |
| `GET history/dividends` | Dividends + interest. |
| `GET history/transactions` | Deposits/withdrawals/fees/transfers. |
| `GET/POST history/exports` | CSV export lifecycle (full-history backfill + card rows). The finished report's `downloadLink` is a signed storage URL downloaded **without** `auth`. |

**Rate limits** are strict and per-endpoint (instruments 1/50s, history 6/min, account 1/5s,
export POST 1/30s, export list 1/min). The kit's `brokeredRequest` waits out a `429` (up to 12
times) using `retry-after` or `x-ratelimit-reset`, and retries transient transport errors with
backoff; policy errors from the host ("not approved", "too large", secret problems) are not
retried. A first sync over a long history can therefore take a while. Timeouts: 30 s for JSON
endpoints, 60 s for export endpoints and the CSV download.

**The 2 MB response cap and export window splitting.** A one-year CSV for an active trader can
exceed 2 MB. `Trading212Client.runExport` catches the host's "too large" error, **splits the
window in half** and exports each half separately (recursively, down to ≥ 7 days per window),
merging the CSVs under one header (rows on the split boundary repeat; callers dedupe by
activity id). A report whose CSV was too large is remembered for the call and never reused for
the halves (otherwise a covering report would loop). Below ~14 days the window can't be
halved and the sync reports a clear error (a failed first window falls back to JSON paging).

**Export download host.** The `downloadLink` host isn't documented, so `*.amazonaws.com`
is declared alongside `*.trading212.com`. If the broker rejects the host as not approved, the
error names it (`Trading 212 export download host "x" is not approved…`) so it can be added to
`network.allowedHosts`. Because the broker follows no redirects, the client follows up to 3 `3xx`
hops itself — still without credentials.

**Pagination** is cursor-based: each list response carries `items[]` and a
`nextPagePath` string. `cursorFromNextPage()` extracts the `cursor` query value to
request the next page; a `null` `nextPagePath` ends the loop.

## Sync flow (`use-sync.ts`)

`syncAll()` loads the shared settings + the connections list, builds **one shared**
`SymbolResolver` from the cached symbol map, then syncs the connections **side by side**
(Trading 212 rate-limits per API key, and each connection has its own; the resolver shares a
lookup already in flight). Each connection is synced by `syncOne()`; one failing key is caught
and reported per account without aborting the rest. Afterwards each Transactions-mode account's
deposits and withdrawals are linked with the bank side of the move (kit `linkMovesBetween`, bank
rows whose payee is Trading 212 or one of the user's Trading 212 account numbers), one account at
a time, and the symbol cache is written **once**.

`syncOne(ctx, settings, conn, resolver)`:

0. A connection flagged `needsCredentials` (legacy single-key, see migration) is skipped with a
   "re-enter key ID + secret" result — no network calls.
1. Build a `Trading212Client` from `connectionConfig(settings, conn)` (env + the connection's
   secret name); load this connection's `lastSync` watermark + imported-ref set from
   `t212_sync_{id}` (add-on storage).
2. **Orders**, **dividends** and **transactions**: page newest-first, stopping once a
   record is at or before `lastSync` (compared as instants). Transactions carry the
   `cursor` + `time` pair from `nextPagePath` (Trading 212 requires both or neither).
3. For each record not already in this connection's imported-ref set:
   - Orders: map first (cancelled/rejected orders have no fill; non-`TRADE` fills such as
     splits or stock dividends are counted and logged, not imported), then resolve the
     symbol (see below). A trade with no resolvable symbol is skipped and counted as
     `unresolved`. Interest needs no symbol.
   - Build the `ActivityImport` via the mapper (with `conn.accountId`) and a **stable `id`**.
4. Hand the rows to the connection's `ActivityImporter`: reconcile against the account's
   activities (read once per sync, kept current in memory) with the kit's
   `selectNewActivities` (content key, **by count**), `checkImport` the rest, leave out
   `isValid === false` rows (reported with Wealthfolio's reason), and `import` with
   `forceImport` in calls of up to 1000 rows. checkImport's own `duplicateOfId` is ignored: it is
   a content hash, so it would drop the second of two genuinely identical same-day rows (two
   equal deposits). **What 3.11's two calls really do** (2.6.0/2.6.1 got both wrong and saved no
   trade at all): `checkImport` returns the rows in order **with a new random id on every row**
   and the resolved asset filled in (quote currency, MIC, instrument type), so the checked rows
   are matched by *position* and are what gets imported (an equity row without its quote
   currency fails validation); and `import` answers **200 with `success: false`, `imported: 0`
   and no import run when any one row fails validation, storing none of the call's rows**, with
   the reasons on the returned rows (a row its writer policy refuses is marked invalid on the
   returned row while the rest are stored). So the answer is read row by row: a call that stored
   nothing has its failing rows rejected and the rest retried; a row counts as imported only if
   the host stored it; and every row ends up stored, already there, or rejected (the importer
   throws if the counts do not add up). A call refused as a whole is halved until the offending
   row is isolated. The sync carries on, and ends with an error if *any* row was not saved.
   **Refused rows do not hold the watermark.** A row Wealthfolio refuses on every call
   (an unresolvable or delisted symbol, a bad date) would otherwise keep `lastSync` null, so every
   sync, auto-sync included, would re-run the multi-year CSV export, and an incremental sync would
   never advance. The watermark moves on as usual and each refused unit (the row, or a card row
   with its funding pair) is kept in `t212_refused_{id}` (kit `refused-rows`: the rows as sent,
   Wealthfolio's reason, attempt count, first/last time; capped at 300 entries / 120 KB, with the
   overflow counted). Every sync **retries them first** (only them are sent), and a unit leaves the
   list when all its rows are stored or already there. While the list is not empty the sync result
   has an error and the log lists the rows; the same applies to card rows and to the funding pairs
   for earlier card rows. The dividend-based split inference is switched off while any row is
   refused, since a missing trade looks like a split.
5. Record the ids of stored + already-present rows (never rows that were only sent) into this connection's imported-ref
   set, and set its `lastSync` watermark to when this run **started** (pages are read
   newest-first from that instant; a full backfill uses the instant it first started,
   persisted as `backfillStartedAt` so a resumed backfill leaves no gap). Return a `SyncResult` tagged with the
   connection/account.

### Tracking modes (HOLDINGS vs TRANSACTIONS)

Each connection syncs into its Wealthfolio account in one of two modes, chosen **at
setup** (the "Sync mode" picker; default **Holdings**) and stored on the connection
(`trackingMode`, absent ⇒ `TRANSACTIONS` for connections created before this existed):

- **TRANSACTIONS** — the full flow above: CSV-export backfill on the first sync, JSON
  incrementals thereafter. Gives complete history/performance.
- **HOLDINGS** — `syncHoldings()` fetches `account/summary` + `positions` (and, only if a
  position lacks ISIN/currency, tries the over-cap instruments feed) and writes a
  single **snapshot** via `snapshots.save(accountId, holdings, cashBalances)` — instant,
  no history, no rate-limited backfill. Positions whose symbol can't be resolved are
  counted as `unresolved` and omitted.

The Wealthfolio account's own `trackingMode` is **authoritative**: the SDK's `accounts`
API has no `update`, so the add-on can only set the mode at `accounts.create(...)`. If a
user changes the mode natively in Wealthfolio afterwards, `syncOne` **detects the drift**
(live `account.trackingMode` ≠ the connection's recorded mode). Because reconciling means
deleting the data synced under the old mode, the dashboard shows an **AlertDialog** and only
the confirmed connections (passed to `syncAll(confirmedModeSwitches)`) are prepared by
`clearAccountData` and re-synced; unconfirmed drifted connections are skipped. Away from
TRANSACTIONS the imported activities are deleted (`activities.saveMany({deleteIds})`). Away from
HOLDINGS nothing is deleted: Wealthfolio reads a TRANSACTIONS account from its activities and
keeps the old snapshots aside, unread (`snapshot_service.rs` `is_read`), and it refuses to
delete a snapshot of an account with a provider id unless the date is invalid — which is why
the old `snapshots.delete` loop failed on every try and the backfill never started. A refused
delete ends the sync with a clear error and leaves the connection on its old mode.

**Backfill check.** When a TRANSACTIONS backfill finishes (and on every later sync until it
matches), `verifyAccount` waits for the recalculation the import queued (`PortfolioUpdates`:
an `onUpdateStart` after the last import, then its `onUpdateComplete`; up to 3 min), then
compares `portfolio.getHoldings(accountId)` with `/equity/positions` (resolved with the same
resolver) and the cash from `/account/summary`. Trading 212 reports one cash figure in the account
currency for all wallets, so with cash in other currencies Wealthfolio's wallets are converted at
its exchange rates (`currency.getAll`) and compared within 1%. Differences are logged, fail the
sync, and are kept in `t212_sync_{id}.verification` for the dashboard badge.

**Silent splits.** Trading 212 applies older splits to a position without a history row, so the
imported trades fall short. For each position whose quantity differs, `repairSplits` replays the
account's activities with the known splits for the position's ISIN (`known-splits.ts`) and adds
the `SPLIT` activities only if the quantity then equals Trading 212's to within rounding
(`proposeSplits`; the smallest set that fits, never a tie). The date has to come from the table:
Wealthfolio's stored quotes are split-adjusted (Yahoo's `close`), and the host never fetches split
events (`events=div` only), so there is no price jump to find. Positions no known split explains
are tried against the position's dividend rows (`inferSplit`, below), and else described in the
log with the ratio they imply. The repair compares activities, not Wealthfolio's holdings, so it
does not wait for the recalculation.

**Splits inferred from dividend rows.** A dividend row's `No. of shares` is the holding it was paid
on. The sync keeps `[day, shares]` per ISIN in `t212_divs_{id}` (CSV rows via
`dividendShareOf`, JSON items from `quantity`; recorded even for rows already imported, merged,
dropped by Reset); stored in `t212_divs_{id}`. `inferSplit` replays the position's activities without the split. A dividend is
*unchanged* when its count equals one of the replayed holdings in the 100 days before it (the
record date precedes the pay date, so trades in between are not in the count); the first
*changed* one and the last unchanged one before it bound the split (every later dividend must be
changed). The last unchanged one must match the replay's holding on its own pay date: if a trade
came between its record and pay dates the split could hide before that trade, so nothing is
inferred. For each candidate day in the window, the holding at a later time is linear in the ratio
(`f0 + ratio·a`, a split scales the lots held before it), so each changed dividend gives the
ratios `(count − f0)/a` that would produce it; those that are usual (`cleanRatio`: whole,
reciprocal, 3:2, 2:3, 5:2, 2:5) and shared by all changed dividends are tried against Trading 212's
quantity, at `proposeSplits`' tolerance, and the winner is re-checked with `simulateQuantity`. The
SPLIT goes in only when exactly one ratio reproduces it; it is dated in the middle of the days that
do. Without splits among the activities the holding is a prefix sum (lookups), otherwise each query
replays them within a work budget (it gives up beyond it). A split and a trade missing from the
account are indistinguishable here, so `use-sync` withholds the counts from any sync that left out
a trade or corporate action, and `cleanRatio` leaves out fractions a missing trade could fake.
It runs only when the known-splits table proposed nothing (and did not tie).

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
it. Connections flagged `needsCredentials` are never due. Background runs pass an empty `confirmedModeSwitches`, so a drifted account is **skipped**
(never cleared) until the user confirms in the dashboard. A re-entrancy guard and the
`autoSync` setting (opt-out, default on, toggled in Settings) gate the whole thing.

### UI (`pages/`, `components/`)

The two pages render through the kit's shared `PageShell` (Phosphor icon + heading + actions slot) and
use `@wealthfolio/ui` primitives (`Switch`, `ToggleGroup`, `Tabs`, `Tooltip`, `ScrollArea`,
`EmptyPlaceholder`, `AlertFeedback`, `ActionConfirm`, semantic `Badge` variants) to match the
first-party look.

- **`SyncActivity`** (kit, `@wf-addons/kit/ui`, given the four T212 phases) renders the live sync view: a 4-node phase
  stepper (Export → Match → Import → Done) driven by the current `SyncProgress.phase`, the
  determinate/indeterminate `Progress` bar, and a scrolling **activity feed** of every step the
  sync emitted. The feed is built from `useSync`'s `steps: SyncStep[]`, populated by the kit's `appendStep`
  for each `onProgress` event (consecutive duplicates coalesced so chunked imports show as one row
  with a live `current/total`; the account name is prefixed onto the message).
- **`ConnectionCard`** shows per-account results with the kit's `StatTiles` (Imported / Duplicates /
  Unmatched / Card) on top and a **Summary / Symbols / Log** tab block. *Summary* is the per-
  type activity breakdown (`SyncResult.breakdown`, populated from the existing `tally`).
  *Symbols* renders the persisted **symbol map** (account-independent; from `getSymbolMap`) as
  matched ticker → symbol@exchange rows plus the known unresolved set, so the user can see what
  resolved and what didn't without reading the raw log. *Log* keeps the raw verbose lines.
- **`ConnectionHealth`** runs the `getAccountSummary` probe and surfaces `ok`/`auth`/`err` (and
  `creds` for a flagged connection, without a request) as semantic Badge variants with a
  coloured dot.
- Relative timestamps (`relativeTime`, from the kit) are used everywhere a last-sync time is
  shown, with the absolute time on a `Tooltip`.

### Activity mapping (`mapper.ts`, `csv.ts`) and Wealthfolio 3.8 "final cash"

Since 3.8 an activity's `amount` is the **final cash** (fees/taxes included) and runtime code
uses it as-is — nothing re-derives it. What each mapping emits:

| Trading 212 source | `activityType` | `amount` | Notes |
|--------------------|----------------|----------|-------|
| Filled order, `side: BUY` | `BUY` | **omitted** | `quantity`/`unitPrice` from the fill; `fee` = Σ charges. Wealthfolio derives `amount` = qty × price + fee. Non-`TRADE` fills (splits/distributions) are skipped. |
| Filled order, `side: SELL` | `SELL` | **omitted** | derived qty × price − fee. |
| Dividend, `type !== INTEREST` | `DIVIDEND` | cash paid (net of withholding) | symbol resolved from the embedded instrument. |
| Dividend, `type === INTEREST` | `INTEREST` | cash paid | `cashSymbol(ccy)`. |
| Transaction `DEPOSIT` | `DEPOSIT` | ledger amount | no separate `fee` is ever emitted for plain cash rows (a fee no longer reduces the balance). |
| Transaction `WITHDRAW` | `WITHDRAWAL` | ledger amount (positive) | |
| Transaction `FEE` | `FEE` | the fee | |
| Transaction `INTEREST_ON_FREE_CASH` / `LENDING_INTEREST` | `INTEREST` | ledger amount | `cashSymbol(ccy)`; newer API types. |
| Transaction `TRANSFER` | `TRANSFER_IN` / `TRANSFER_OUT` | ledger amount (by sign) | |

CSV-only rows (`csv.ts`, `corporate-actions.ts`): `Stock split open`+`close` → one `SPLIT` with
`amount` = shares after ÷ before (snapped to a whole ratio or its reciprocal within the rounding of
the share counts, `snapRatio`); `Stock distribution` → `TRANSFER_IN` of the shares at unit price 0,
`isExternal: false`; `Currency conversion` → a `TRANSFER_OUT`/`TRANSFER_IN` pair in one account
with `isExternal: false` and the comment "Currency exchange", sent as one `ImportUnit` (Wealthfolio
links a same-account exchange only when both legs arrive in one import call — `is_fx_import_label`
in `activities_service.rs`), plus a `FEE` for the Total; `Dividend adjustment`/`Result adjustment`
→ income, or a `FEE` when the Total is negative; `Dividend (Return of capital …)` → `DIVIDEND` with
subtype `RETURN_OF_CAPITAL`.

Trades deliberately omit `amount` rather than send a total, so the writer's own derivation is
the single source of truth and charges can't be double-counted. All monetary fields are in the
**activity currency**, so for a cross-currency trade (instrument currency ≠ account currency)
the account-currency charges Trading 212 reports are converted into the activity currency, and
`fxRate` is set to *account-currency units per activity-currency unit* (what Wealthfolio's
`fx_rate` means; it then settles the trade's cash in the account currency). Trading 212's own
rate direction differs between the exports we have seen, so `accountPerActivityRate` picks `rate`
or `1/rate` by comparing with the rate implied by the trade's account-currency total, and
returns no rate (the trade stays in its own currency) if it can't tell. Same-currency trades get
no `fxRate`. Cash rows use the kit's `cashSymbol` (`$CASH-GBP`) and `round2`.

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

Trading 212 pays card spending out of the investing account's cash, so each card row is imported
as an `ImportUnit` with a transfer pair (`withCardFunding`): investing → card for a purchase,
card → investing for a refund or cashback, same date, currency and amount. Wealthfolio links a
TRANSFER_OUT/TRANSFER_IN pair in different accounts when both arrive in **one** import call, so
the importer never splits a unit. `fundExistingCardRows` adds the pair for card rows imported
before (deduplicated by content, so it is a no-op once done).

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

Trading 212 tickers look like `AAPL_US_EQ`, or, for a European listing, `VUAAm_EQ`: the base
ticker with a lowercase exchange letter (`l` London, `d` Xetra, `p` Paris, `a` Amsterdam, `m`
Milan, `e` Madrid), which `parseBaseSymbol` drops and `marketMics`/`marketCurrency` read like a
market segment. Without it `VUAAm` exactly matched Cboe's `VUAAM` and won over VUAA on Milan.
`resolveTicker` queries the host
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
MIC into `SnapshotHoldingInput.exchangeMic`, and every imported trade and dividend carries it
too (`importAssetFields`: symbol, `exchangeMic`, `instrumentType: "EQUITY"`), so Wealthfolio pins
the asset to the right listing in both modes. Without a MIC it resolves ticker collisions to its
default listing, and its import infers a bare `LTC`/`BTC`… as crypto
(`activities_service.rs` `infer_asset_kind`). Search hits that are crypto pairs, currencies or
indices (`isNonSecurity`) are never picked. It also
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
the duration of a sync and persists the map to add-on storage. Values are encoded
`"SYMBOL"` (no MIC) or `"SYMBOL|MIC"`; back-compat read-only for pre-v1.7.2
entries. "Reset sync history" clears it. One instrument reaches the resolver under two tickers
(the export's `VUAA`, the API's `VUAAm_EQ`) with different hints, so a resolution is also kept
under `isin:<ISIN>|<currency>` and that entry wins: the first ticker to resolve an instrument
decides its listing for both. A full backfill resolves the held positions (API tickers, which name
the market) before reading the export. Cached entries of lettered tickers that sit on another
venue's MIC are dropped on load and resolved again.

The check after a backfill (`compareWithTrading212`) pairs a position missing from Wealthfolio
with the one leftover holding of the same quantity (when no other leftover position shares that
quantity) and notes it as held under another listing, rather than reporting two differences.

## Idempotency model (defence in depth)

Three independent guards ensure re-syncs never duplicate:

1. **Watermark** (`lastSync`, per connection) — we only fetch records newer than the last sync.
2. **Imported-ref set** (per connection) — locally remembers every reference already
   accounted for, so anything that slips past the watermark is filtered before import.
   It is **per connection** because Trading 212 reference ids are scoped per T212
   account — an Invest and an ISA account can each independently produce `order id 1`,
   so a global set would wrongly drop the second.
3. **Host `checkImport`** — Wealthfolio's own duplicate detection is the final
   backstop. `checkImport` marks a row matching a stored activity `duplicateOfId` and one matching
   an earlier row of the call `duplicateOfLineNumber`. A row is sent with `forceImport` only when
   the host marked it and the add-on's own count proves it new (the second of two identical
   deposits on one day); the markers are stripped before `import`, and a row the host returns
   still marked is judged by `forceImport`, not by the marker (a forced row comes back marked but
   stored). When the stored count still disagrees with the rows, the account is read again and
   each row is judged by whether it is there (`settleByReading`); a call is never refused
   wholesale.

Card rows (`WITHDRAWAL`/`DEPOSIT`/`INTEREST` in the card account, not the funding legs) are matched
against the card account's rows by day, amount, type and currency, ignoring the comment: an older
version wrote other merchant text ("Lidl GB · Shopping" for "Lidl · Shopping"), and the host's key
includes the comment, so neither the content key nor the host would catch them. Rows of the same
export window already recorded as imported are counted first, so two identical spends on one day
still both land.

**Card funding legs.** Each card row is funded by a `TRANSFER_OUT` (Invest) + `TRANSFER_IN` (card)
pair. A leg whose partner is gone (its account deleted) is an orphan (`orphanFundingLegs`, which
looks for partners in every account before calling a leg an orphan): `fundExistingCardRows`
deletes the orphans and funds their card rows again, and removing a connection deletes the
card-side orphans as well (best effort; the next sync using that card account does it anyway).

**Minor-unit currencies.** Wealthfolio divides a GBX (GBp, ZAc, ILA, KWF, USX) row's price, amount
and fee into the major unit on import, whatever the row is, so a `SPLIT` sent in GBX stores a
hundredth of its ratio. Splits are sent in the major currency (kit `majorCurrency`), and
`healSplitRatios` re-imports any split whose stored ratio is a hundredth (or thousandth) of the one
its comment states, deleting the wrong row once the right one is stored.

The local guards exist because the exact key Wealthfolio uses for `checkImport`
deduplication is not documented; the stable `id` is supplied to give it the best
chance, and the watermark + ref-set make the add-on correct regardless. Note the
stable `id` (`t212-order-{id}` etc.) is **not** namespaced by account; if two of your
T212 accounts ever shared a reference id and Wealthfolio's `checkImport` dedup turned
out to be global, the second could be dropped. T212 ids are effectively per-user-unique,
so this is a documented, low-risk limitation rather than an observed problem.

**Why not content reconciliation?** Other add-ons in the monorepo dedupe by matching row content
(the kit's `selectNewActivities`). That doesn't work for trades here: Wealthfolio may store a
*canonical* symbol different from the one imported (the resolver's pick vs the asset it settles
on), so a content comparison would miss already-imported trades and double-import them. The
stable-id watermark + per-connection imported refs + host `checkImport` model is kept instead.

## Security model

- API key ID/secret live only in Wealthfolio's keyring (`ctx.api.secrets`), entered via
  password fields, never logged, and **never read back by the add-on**: requests reference the
  secret by name (`auth.secretKey`) and the host injects the header. The signed CSV download is
  sent with no `auth` at all.
- New credentials are verified under a temporary secret (`t212_auth_pending_<id>`, always
  deleted) so a typo can't clobber working ones.
- The add-on can only reach hosts declared in `manifest.network.allowedHosts`
  (`*.trading212.com`, `*.amazonaws.com`), over HTTPS; there is no server component.
- Connection records in storage hold only a masked last-4 of the key ID.

## Stored keys

Add-on **storage** (`ctx.api.storage`, non-secret):

| Key | Contents |
|-----|----------|
| `t212_settings` | `{ env, autoSync?, extractCard?, cardAccountType? }` — shared by all connections |
| `t212_connections` | `T212Connection[]` = `{ id, name, accountId, keyIdLast4?, needsCredentials?, trackingMode?, kind?, cardAccountId? }` — **no key/secret** |
| `t212_sync_{id}` | Per-connection `{ lastSync, backfillCheckpoint?, backfillStartedAt?, cardLastSync?, verification? }` — small and bounded (`importedRefs` here is legacy, moved out on first read) |
| `t212_refs_{id}_{00..1f}` | The ids of the rows imported for connection `{id}`, spread over 32 keys by a hash of the id, so no key approaches the host's ~244 KB cap (one value of 235 KB broke a real Invest account); only the shards that gain an id are rewritten |
| `t212_refused_{id}` | Rows Wealthfolio refuses, awaiting a retry at the start of every sync: `{ entries: [{ id, unit: ActivityImport[], reason, attempts, since, lastAt }], dropped }` — deleted when the list empties and by Reset |
| `t212_divs_{id}` | `{ ISIN: [[day, shares], …] }` — the dividend share counts used to infer splits |
| `t212_last_result_{id}` | The connection's last `SyncResult` (counts, breakdown, **log**, check), log cut to fit, so the dashboard shows it again after a reload; deleted by Reset |
| `t212_last_steps` | The last sync's activity feed (last 200 steps) |
| `t212_symbol_map_v6` | Shared `{ ticker: "SYMBOL\|MIC" }` cache (`""` = known miss; bare `"SYMBOL"` = MIC unknown). Older v1–v5 caches are deleted. |

**Secrets** (`ctx.api.secrets`, keyring):

| Key | Contents |
|-----|----------|
| `t212_auth_{id}` | base64(`keyId:secret`) for connection `{id}`; used only through `auth: { type: "basic", secretKey }` |
| `t212_auth_pending_{id}` | transient, while verifying new credentials (deleted immediately) |

### Migration v1 → v2 (`migrateV1ToV2`, run once per start via `ensureMigrated`)

v1 stored *everything* in secrets (including a proxy URL). The migration, on enable (and awaited
by the pages and the auto-sync tick), is idempotent and crash-safe — each write is skipped when
its destination already has a value, and the `t212_connections` / `t212_settings` secrets (the
"not migrated" markers) are deleted last:

1. For each v1 connection with key **and** secret → write secret `t212_auth_{id}` =
   base64(`key:secret`).
2. Connections list → storage without credentials (`keyIdLast4` kept). **A connection with only
   a legacy single key (no secret) is kept but flagged `needsCredentials`**, shown in Settings
   and on the dashboard, and skipped by sync/auto-sync until key ID + secret are entered.
3. Shared settings → storage minus `proxyUrl`; `t212_sync_{id}` and `t212_symbol_map_v6` →
   storage (copied only if storage has none, then deleted from secrets via the kit's
   `migrateSecretsToStorage`).
4. The even older single-account layout (`t212_config` + `t212_account_id` + `t212_last_sync` +
   `t212_imported_refs`) is folded in the same way (one "Trading 212 (Invest)" connection; flagged
   if it had no secret), and superseded `t212_symbol_map[_v2…_v5]` caches are dropped.

## Build, test, release

```bash
pnpm test          # vitest — mapper, csv, client, symbol resolver, config/migration, sync
pnpm type-check    # tsc --noEmit (strict)
pnpm bundle        # clean + vite build → dist/addon.js + dist/trading212-addon-<version>.zip
```

Run from `addons/trading212` (or the repo root with `pnpm -r`). `manifest.json` and `package.json`
versions must match or packaging refuses. The bundle imports only host-provided packages
(`react`, `react/jsx-runtime`, `@tanstack/react-query`, `@wealthfolio/ui`; the SDK is type-only).

## Extension points & known limitations

- **Corporate actions**: explicit split pairs, distributions and conversions are mapped; splits
  with no row in the export need the known-splits table for their date (it holds fractional
  ratios too: Pennon's 2-for-3 consolidation is 2/3). A split that is not in it is inferred from
  the position's dividend rows when they are clear (see above), and otherwise only described,
  with the overall ratio it implies. An incremental (JSON) sync does not see a
  new split's row; the check reports the position and a re-sync after **Reset** brings it in. A
  swap into a different ticker or ISIN is reported, not mapped. Wealthfolio's `SPLIT` takes the
  ratio in `amount`, needs the asset, and applies to lots bought strictly before the split day.
- **Instruments metadata**: the ~5 MB feed can't pass the 2 MB cap, so HOLDINGS relies on the
  instrument data embedded in positions/orders. A future metadata fallback would need a
  different source.
- **Export download host**: the signed `downloadLink` host is unconfirmed (`*.amazonaws.com`
  is declared); see the error text if the broker refuses it.
- **Legacy single-key auth is unsupported** (the broker only builds Basic auth from a stored
  base64 `keyId:secret`).
- **Trade charges**: `Charge amount`, `Currency conversion fee`, `Stamp duty reserve tax` and
  `French transaction tax` go into `fee`; any other charge column would make Wealthfolio's derived
  total differ from Trading 212's.
- **History depth**: bounded by what Trading 212's history endpoints return; there is
  no separate backfill of pre-API-era data via these endpoints.


## Cash ISA ↔ Monzo transfer matching

`importCashIsa` (`src/lib/cash-isa.ts`) keeps Cash ISA deposits and withdrawals as `DEPOSIT` /
`WITHDRAWAL`, because Wealthfolio's ISA allowance counts every `DEPOSIT` but an unlinked
`TRANSFER_IN` only when it is flagged external. After the ledger reconcile and import it calls
`matchWithOtherAccounts`, which hands the ISA's move rows and the other cash accounts' rows whose
comment matches `TRADING_212_PAYEE` to the kit's `convertAndLinkMoves` (`move-match.ts`). That
matches opposite-direction rows of equal amount and currency within 3 days (closest date, exact
ties skipped), then converts both legs with `activities.saveMany` and links them with
`activities.linkTransfer`, reverting the conversion if either step fails. Already-linked rows
are never candidates, and rows are not touched without a match. The Monzo add-on runs the same
matcher from its side (`matchWithCashIsa`). A converted row no longer matches its ledger hash,
so a later CSV import neither rewrites it nor imports it again. `adoptUntrackedRows` (kit
`reconcile.ts`) stops a transfer made by hand being imported a second time.
