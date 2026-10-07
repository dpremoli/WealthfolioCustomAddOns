# Wealthfolio Custom Add-ons

Personal [Wealthfolio](https://wealthfolio.app) add-ons, built against
**Wealthfolio 3.9 / addon SDK 3.9** (the sandboxed add-on runtime introduced in 3.6).

| Add-on | What it does | Data source |
|---|---|---|
| [`addons/monzo`](addons/monzo) | Syncs Monzo current/Flex accounts into cash accounts; CSV backfill beyond the API's 90 days | Monzo API (OAuth) + CSV |
| [`addons/revolut`](addons/revolut) | Imports Revolut statements into one cash account per currency, with opening balances | CSV (Revolut has no personal API) |
| [`addons/trading212`](addons/trading212) | Syncs Trading 212 Invest/ISA trades, dividends, cash and card spending, or daily holdings snapshots | Trading 212 API |

All three feed Wealthfolio's Spending module (cash and credit-card accounts), and
none needs a server any more: Wealthfolio's network broker makes the API calls the
old Python proxies used to relay.

Related, kept in its own repo: **StocksBot** (FT fund prices as a Wealthfolio custom
market-data provider, plus fund sector/region look-through).

## Layout

```
addons/<name>/          one Wealthfolio add-on each (manifest.json at its root)
packages/addon-kit/     @wf-addons/kit — shared code, bundled into every add-on
tooling/                shared Vite/Vitest config and the packaging script
```

`@wf-addons/kit` holds what the add-ons used to copy between repos:

- `parseCsv` / `headerIndex` — RFC 4180 CSV parsing
- `cashSymbol`, `round2`, `fnv1a`
- `selectNewActivities` — reconcile against the account and force-import, so genuine
  same-day repeats survive Wealthfolio's content-hash dedupe while re-imports add nothing
- `brokeredRequest` / `brokeredJson` — `ctx.api.network` with 429 and transient-error retries
- `jsonStore`, `migrateSecretsToStorage` — settings in add-on storage, credentials in secrets
- `registerPages` — sandbox-safe routes wrapped in the add-on's React Query client
- UI: `PageShell`, `StatTiles`, `SyncActivity`

## Develop

```bash
pnpm install
pnpm check            # type-check + tests + build, all packages
pnpm --filter ./addons/revolut bundle   # → addons/revolut/dist/revolut-addon-<version>.zip
```

Dependency versions live once, in the `catalog:` of `pnpm-workspace.yaml`. Host-provided
packages (React, `@wealthfolio/ui`, the SDK, React Query) are externalised by
`tooling/vite.addon.ts` and listed in each manifest's `hostDependencies`.

To try an add-on live, run Wealthfolio with `VITE_ENABLE_ADDON_DEV_MODE=true` and
`pnpm dev:server` inside the add-on directory.

## Install

Download the add-on's zip from [Releases](https://github.com/dpremoli/WealthfolioCustomAddOns/releases) (or build it), then in
Wealthfolio: **Settings → Add-ons → Install from file**. Approve the permissions and,
for Monzo and Trading 212, the network hosts the add-on declares.

## Release

Releases are automatic and driven by each add-on's version:

```bash
pnpm bump revolut patch      # or minor / major / 2.1.0 — updates manifest.json and package.json
```

Open a PR with the bump. CI shows a **Releases on merge to main** preview; once it merges,
`.github/workflows/release.yml` tests, type-checks and bundles every add-on whose
`<addon>-v<version>` tag doesn't exist yet, then publishes a GitHub release with the zip
(creating the tag). Unbumped add-ons are left alone.

To (re)release by hand, run the **Release** workflow from the Actions tab with a tag such as
`revolut-v2.0.1`, or push that tag; it must match the add-on's manifest version.

## History

Each add-on's full history was imported from its original repository
(`Wealthfolio-Monzo-AddOn`, `Wealthfolio-Revolut-AddOn`, `Wealthfolio-Trading212-Add-On`);
`git log --follow addons/<name>/src/...` traces back through it.

## License

GPL-3.0 — see [LICENSE](LICENSE).
