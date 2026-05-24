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
| `addon/src/types.ts` | TypeScript shapes for the Trading 212 payloads we consume + internal `T212Config`/`SyncResult`. |
| `addon/src/lib/proxy-client.ts` | HTTP client to the proxy: builds the auth header, retries on `429`, exposes per-endpoint + cursor-paging methods. |
| `addon/src/lib/symbol-resolver.ts` | Maps a Trading 212 ticker to a Wealthfolio symbol via `market.searchTicker`, with in-memory + persisted caching. |
| `addon/src/lib/mapper.ts` | Pure functions: Trading 212 order/dividend/transaction → `ActivityImport`. |
| `addon/src/hooks/use-config.ts` | All keyring reads/writes (config, account id, watermark, symbol map, imported-refs). |
| `addon/src/hooks/use-sync.ts` | Sync orchestration: fetch → resolve → map → `checkImport` → `import`. |
| `addon/src/pages/settings-page.tsx` | Connect form (proxy URL, env, key/secret), connection test, securities-account creation, reset/disconnect. |
| `addon/src/pages/dashboard-page.tsx` | Sync button + status/result display. |

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

1. Load config, linked account id, `lastSync` watermark, imported-ref set, and the
   cached symbol map from the keyring.
2. **Orders** and **dividends**: page newest-first via `collectSince`, stopping once
   a record predates `lastSync`. **Transactions**: use the server-side `time` filter
   from `lastSync`, then follow the cursor.
3. For each record not already in the imported-ref set:
   - Orders/dividends: resolve the symbol (see below). A trade with no resolvable
     symbol is skipped and counted as `unresolved` (we never import a position-
     affecting trade with a wrong/blank symbol). Interest needs no symbol.
   - Build the `ActivityImport` via the mapper with a **stable `id`**.
4. Persist the symbol cache if it changed.
5. `checkImport(activities)` → drop rows flagged `duplicateOfId` or `isValid === false`
   → `import` the rest.
6. Record the ids of imported + duplicate rows into the imported-ref set, and set the
   `lastSync` watermark to now.

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

### Symbol resolution (`symbol-resolver.ts`)

Trading 212 tickers look like `AAPL_US_EQ`. `resolveTickerSymbol` queries the host
`market.searchTicker` in priority order — **ISIN → base ticker (`AAPL`) → instrument
name** — and `pickBestSymbol` prefers a result that already exists in Wealthfolio,
then the highest search score. `SymbolResolver` caches each lookup (including known
misses, stored as `""`) for the duration of a sync and persists the map to the
keyring, so repeated syncs don't re-query. "Reset sync history" clears it.

## Idempotency model (defence in depth)

Three independent guards ensure re-syncs never duplicate:

1. **Watermark** (`lastSync`) — we only fetch records newer than the last sync.
2. **Imported-ref set** — locally remembers every reference already accounted for,
   so anything that slips past the watermark is filtered before import.
3. **Host `checkImport`** — Wealthfolio's own duplicate detection is the final
   backstop; rows flagged `duplicateOfId` are dropped.

The local guards exist because the exact key Wealthfolio uses for `checkImport`
deduplication is not documented; the stable `id` is supplied to give it the best
chance, and the watermark + ref-set make the add-on correct regardless.

## Security model

- API key/secret live only in Wealthfolio's keyring (`ctx.api.secrets`), entered via
  password fields, never logged.
- The proxy stores no credentials and only ever connects to the fixed `live`/`demo`
  allow-list — a caller cannot point it at an arbitrary host (no SSRF).
- `.env` is git-ignored; the proxy needs no env credentials (only an optional `PORT`).

## Stored keyring keys (`use-config.ts`)

| Key | Contents |
|-----|----------|
| `t212_config` | `{ proxyUrl, env, apiKey, apiSecret? }` |
| `t212_account_id` | Linked Wealthfolio securities account id |
| `t212_last_sync` | ISO timestamp watermark |
| `t212_symbol_map` | `{ ticker: resolvedSymbol }` cache (`""` = known miss) |
| `t212_imported_refs` | Array of already-imported Trading 212 reference ids |

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
