# Repo notes for Claude

pnpm monorepo of Wealthfolio add-ons targeting Wealthfolio / addon SDK **3.9** (sandboxed runtime).

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
- Manifest `permissions` must cover every `ctx.api.<category>.<fn>` the bundle calls.
- Cash activities use `cashSymbol(ccy)` (`$CASH-GBP`), never a bare currency code.
- Wealthfolio dedupes imports by content hash; for cash importers use the kit's
  `selectNewActivities` (reconcile + `forceImport`) so identical same-day rows survive.

Releasing: `pnpm bump <addon> <patch|minor|major>` and merge to main — `release.yml` publishes
every add-on whose `<addon>-v<version>` tag is missing (see `tooling/release-plan.mjs`). Bump in
the same PR as any user-facing add-on change you want shipped.

Check before pushing: `pnpm check` (type-check, tests, tooling tests, bundle).
