# Repo notes for Claude

pnpm monorepo of Wealthfolio add-ons targeting Wealthfolio / addon SDK **3.11** (sandboxed runtime).

- `addons/<name>/` — one add-on each; `manifest.json` and `package.json` versions must match
  (`tooling/package-addon.mjs` refuses otherwise).
- `packages/addon-kit` (`@wf-addons/kit`, `@wf-addons/kit/ui`) — shared code. Put anything a
  second add-on would copy here instead of duplicating it.
- Dependency versions: `catalog:` in `pnpm-workspace.yaml`. Host-provided packages are
  externalised in `tooling/vite.addon.ts` and must match manifest `hostDependencies`.

Sandbox rules that bite:
- No `fetch`/localStorage/popups. HTTP only via `ctx.api.network.request` (use the kit's
  `brokeredRequest`): HTTPS, hosts in `manifest.network.allowedHosts`, no LAN hosts, no
  redirects, 2 MB response cap, `Authorization` only via `auth.secretKey`
  (needs the `secrets` → `use` permission).
- Settings/sync state → `ctx.api.storage`; credentials → `ctx.api.secrets`.
- Routes: kit `registerPages` (host-managed `component`), ids must match `contributes.routes`.
- Never name a class method `import` (`async import(…) {}`): the host's loader runs es-module-lexer
  (pinned in the catalog to the host's version) over the bundle and rewrites what it reports as a
  dynamic `import(`, which turns that method into a syntax error and the add-on fails to load.
  `tooling/check-bundle.mjs` runs in every `bundle` and fails on any dynamic import.
- Host calls answer 200 when they save nothing, and 3.11 changes what you send them: `checkImport`
  gives every row a **new id** (match rows by position) and fills in the resolved asset, which
  `import` then requires; `import` stores **none** of a call's rows if any row fails validation
  (`summary.success: false`, `imported: 0`, reasons on the returned rows). Read the result row by
  row; record an id as imported only for a row the host stored. For cash importers use the kit's
  `importStoredRows` (it reads the answer, rejects the rows that fail and retries the rest) and
  `withoutUnsaved` (keeps unsaved rows out of the ledger); feed the unsaved rows to the refused-rows
  store below with `pendingRows` (before reconciling) and `recordRefused` (after importing).
  Test against the kit's fake host (`@wf-addons/kit/testing`), which behaves that
  way, not a mock that accepts whatever is sent.
- A row the host refuses on every call (unresolvable symbol, bad date) must not hold a sync's
  watermark: move the watermark on and keep the row in the kit's `refused-rows` store (own storage
  key per connection: row, host reason, attempts), retry it at the start of every sync, remove it once
  stored, and keep the sync error while the list is not empty.
- One storage value is capped at ~244 KB ("too large to sync across devices"): never keep a list
  that grows with the user's history (imported ids, logs) in a single key. Shard it, or cap it.
- Manifest `permissions` must cover every `ctx.api.<category>.<fn>` the bundle calls.
- Cash activities use `cashSymbol(ccy)` (`$CASH-GBP`), never a bare currency code.
- Wealthfolio dedupes imports by content hash; for cash importers use the kit's
  `selectNewActivities` (reconcile + `forceImport`) so identical same-day rows survive.

Releasing: `pnpm bump <addon> <patch|minor|major>` and merge to main — `release.yml` publishes
every add-on whose `<addon>-v<version>` tag is missing (see `tooling/release-plan.mjs`). Bump in
the same PR as any user-facing add-on change you want shipped.

Check before pushing: `pnpm check` (type-check, tests, tooling tests, bundle).
