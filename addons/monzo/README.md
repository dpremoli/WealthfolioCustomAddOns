# Wealthfolio Monzo Add-On

Sync your **Monzo** transactions straight into [Wealthfolio](https://wealthfolio.app) cash
accounts, so they feed the spending module. Part of the
[Wealthfolio custom add-ons monorepo](../../README.md). Requires **Wealthfolio 3.11+**.

Version 2 talks to the Monzo API **directly** from inside Wealthfolio. There is no proxy
server, no Docker container and nothing to host: you register a small OAuth client with
Monzo, paste its details into the add-on, and connect.

## What it does

- Connects to Monzo with OAuth (a confidential client that you own) and keeps the
  connection alive by refreshing the access token automatically.
- Creates a Wealthfolio account for each of your Monzo accounts and syncs new transactions
  into them, incrementally: a **cash** account for current and joint accounts, a **credit
  card** account for Flex (a credit line you repay). The type is set when the account is
  created; to retype one made by an older version, use Wealthfolio's **Update Account**
  dialog.
- Imports debits as `WITHDRAWAL` and credits as `DEPOSIT` cash activities (money back on a
  spending category, such as a refund, as a `CREDIT` refund so it reduces that spending
  instead of counting as income), using
  Wealthfolio's `$CASH-<currency>` cash symbol. The comment reads like the Monzo app: who
  you paid or who paid you (the merchant, or for transfers the payee/payer's name rather
  than the payment reference), the Monzo category, location, foreign-currency amount, a
  transfer's reference when it is more than your own name, and your notes.
- **Files transactions under Wealthfolio's spending categories.** Each sync keeps one
  categorisation rule per Monzo category (Settings → Spending → Rules, named
  "Monzo: Groceries" and so on) pointing at the matching Wealthfolio category (Groceries,
  Restaurants, Transport, …), then re-runs rules over uncategorised activities, so new and
  already-imported transactions get their category. Wealthfolio's own merchant rules take
  precedence where they match (they are more specific); "General" goes to Other Expenses as a
  last resort, and transfers are left alone. Spending rules apply to **outflows only**: one
  rule per category for withdrawals and one for refund credits, so a deposit is never filed
  as spending. Monzo's "Income" deposits go to Other Income (the income categories), and that
  rule outranks Wealthfolio's merchant rules. Categories you set by hand are never overwritten. Spending must be turned on for the account in
  Wealthfolio for the categories to show up there.
- Keeps already-imported transactions up to date: when a re-fetched transaction differs from
  its Wealthfolio row (new notes, a better payee name, a settled amount), the row is
  rewritten in place rather than imported again.
- Skips what should not count as spending: declined and zero-value transactions, pending
  transactions (Flex purchases are the exception, they never "settle"), and pot transfers.
- **Imports savings moves.** Money moved to or from a savings or investment account outside
  Monzo (the `savings` category, other than your own pots), such as to and from a Trading 212
  Cash ISA, is imported as an ordinary withdrawal or deposit, so the current account's balance
  is right even when the other account is not in Wealthfolio. No spending rule files them
  (they are your own money changing place), and they are left out of the dashboard's spending
  breakdown.
- **Links moves with your Trading 212 Cash ISA.** When the Trading 212 add-on's Cash ISA
  account is in Wealthfolio too (the account it creates, or one whose name mentions Trading 212 and ISA),
  each sync looks for the other half of every savings move whose payee points at Trading 212
  ("Trading 212", "Trading TwoOneTwo", or one of your Trading 212 account numbers as the
  reference): same
  amount and currency, opposite direction, dated within 3 days, neither row already linked. For
  a confident match (the closest date; an exact tie is skipped and logged) both rows are turned
  into a `TRANSFER_OUT` / `TRANSFER_IN` in place and linked through Wealthfolio's transfer-link
  API. If linking fails the rows are put back as they were. A move with no counterpart stays a
  plain withdrawal or deposit **on purpose**: an unlinked transfer into an ISA would not count
  towards its allowance. A transfer you already made by hand (and linked) is recognised as the
  same move, not imported again, even when its date is up to 3 days from the Monzo one. The
  Trading 212 add-on does the same from its side when you import the Cash ISA CSV, so it does
  not matter which add-on sees the pair second. (The Trading 212 add-on, from 2.6.0, links your
  Invest and Stocks ISA top-ups with these Monzo rows the same way.) Known limit: "Trading 212" is also the payee
  when you top up a Trading 212 Invest or Stocks ISA account, which this matcher cannot see, so
  if you fund both and two same-amount moves fall within 3 days, one can be linked to the wrong
  row (unlink it in Wealthfolio's Link Transfer dialog).
- **Keeps the current account and Flex balances right.** The monthly Flex repayment is
  imported as a `TRANSFER_OUT` on the current account and a matching `TRANSFER_IN` on the
  Flex account (same amount and date), so the Flex balance is paid down and the current
  account is no longer overstated. When a Flex purchase is refunded, Monzo moves the money
  off Flex into the current account ("Refunded (Flex)"); both legs are imported as the same
  kind of transfer pair (`TRANSFER_OUT` on Flex, `TRANSFER_IN` on the current account). Each
  pair is linked as an internal transfer through Wealthfolio's transfer API, so neither side
  counts as income or spending. Monzo's Flex feed has no row for a repayment, so the Flex side
  is written by the add-on from the current account's debit (its id is the Monzo transaction
  id plus `:flex-in`); the import ledger keeps re-syncs and CSV imports from duplicating it.
  The repayment needs the Flex account to be mapped (or chosen on the CSV page); without one
  it is skipped, and the log says so. (With several Flex accounts mapped, repayments are
  credited to the first.) A refund leg whose other half is not in the same
  sync or import is imported unlinked: link it from Wealthfolio's Activities page.
- Lets you rename Monzo categories (Settings -> Category labels).
- Imports **Monzo CSV exports** (several files at once, each to its own account) for history older than the API shares (see below).

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
pnpm bundle          # creates dist/monzo-addon-<version>.zip
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
   syncs. The request can take a minute to show up in the app; keep the Settings page open,
   it checks every few seconds.

As soon as the approval comes through, the Settings page creates the Wealthfolio cash
accounts and runs a sync by itself (after every connection, including a reconnect), inside the
5 minutes in which Monzo shares your full history. After that, use **Sync Now** on the
dashboard.

The add-on checks the `state` value in the pasted URL against the one it generated, so a
link that did not come from your own Connect click is rejected.

## Syncing

- **Automatic sync** (on by default; Settings -> Advanced to turn it off). Once you have synced
  at least once, the add-on syncs by itself in the background whenever the last sync is more
  than 6 hours old: shortly after Wealthfolio loads, every hour after that, and when Wealthfolio
  finishes refreshing its portfolio. It only runs **while Wealthfolio is open** (the add-on
  lives inside the app, there is no server-side job), so a self-hosted install needs a browser
  tab open, and Monzo's 90-day limit still applies if you stay away longer. The first sync
  after connecting stays manual, and so do the first one after **Reset sync history** and the
  one-off 90-day re-check that 2.4.0 added (the sync you start yourself does these). Background
  runs never overlap a manual sync or CSV import. If one fails (for instance Monzo wants the
  connection approved in its app), it is not retried for 6 hours, and the reason is shown on the
  dashboard and in Settings until a sync succeeds; **Sync Now** shows the full error. The
  dashboard shows the result of background syncs like any other.
- **Sync Now** fetches transactions since the last sync, 100 per request, for each mapped
  account, filters them, and imports what is new.
- Re-syncing is safe. Instead of relying on Wealthfolio's content-hash duplicate detection
  (which would silently drop two genuinely identical same-day transactions, such as two
  coffees at the same price), the add-on keeps its own ledger (in add-on storage) of the
  Monzo transaction ids it has imported, so a transaction whose notes, category or payee name
  changed is still recognised, and a new identical one is never mistaken for it. Rows
  imported by versions before the ledger are matched by content, by count. The same applies
  to CSV imports, which use the same transaction ids, so a CSV and the API sync can overlap
  freely. (v2.1–2.2 wrote the id into the comment as `[ref:tx_…]`; the next sync moves it to
  the ledger and removes the tag.)
- A transaction that is still **pending** when you sync is not lost: the next sync starts
  from the oldest recent pending transaction, so it is picked up once it settles.
- Only one sync or CSV import runs at a time, even across pages: while one is running, the
  dashboard's **Sync Now** and the CSV page's **Import** are disabled, and the dashboard shows
  the result when it finishes.
- The dashboard keeps the result and step list of the last successful sync, so it is still
  there after you leave the page or restart Wealthfolio. Disconnecting and **Reset sync
  history** clear it.
- **Disconnect** revokes the tokens at Monzo (`/oauth2/logout`) as well as forgetting them.
- **Reset sync history** (Settings -> Advanced) makes the next sync start from scratch.
  Anything already imported is recognised and skipped.

### The 90-day limit and CSV backfill

Monzo shares your **full history** only for 5 minutes after you authenticate (log in through
the connect flow); after that, API clients can read just the **last 90 days**. A token
refresh does not reopen that window.

- **Sync right after connecting** and you get the whole history, read in slices of about six
  months, newest first. The add-on starts a sync by itself after every connection, and a sync
  that starts within 15 minutes of connecting asks for everything even if you synced before
  (anything already imported is recognised and skipped).
- **Otherwise** a sync reaches back at most 90 days. If Monzo refuses the full history (the
  window has passed) the add-on falls back to the last 90 days and says so in the log. If it
  stops part-way through the slices, you keep what it fetched, and the log says how far back
  that reached. Later syncs never ask for more than 90 days back, so a long gap between syncs
  is logged rather than failing with 403.
- **Reconnecting later** (Disconnect, then connect again) and syncing straight away fetches the
  whole history again.

For anything older, export a CSV from the Monzo app (**Account -> Export transactions ->
CSV**) and use **Import CSV** in the add-on: choose one or more files at once (or add more later),
pick the target Wealthfolio account for each one, and import. Monzo exports one CSV per Monzo
account, so different files usually go to different accounts; files are imported one after
another, and a file that fails does not stop the rest. Columns are matched by header name
(Transaction ID, Date, Time, Name, Category, Amount, Currency, Local amount, Local currency,
Notes and #tags, Description, ...), so small changes to Monzo's export layout do not break it. Overlapping API and CSV imports
are reconciled the same way as re-syncs. "Skip bank transfers" is on by default; it does
not drop Flex repayments and refunds, which are imported as transfers, or savings moves, which
are imported as withdrawals and deposits. When a file contains
repayments the page asks for the **Flex account** that receives them (the only credit card
account is picked for you; choose "None" to skip the repayments).

Because older history is not available, an account's balance in Wealthfolio reflects only
the transactions imported. If you need it to match Monzo, add an opening-balance deposit
dated just before your first imported transaction. Remove or adjust that deposit if you later
import the full history (by reconnecting, or from CSV), or the balance will be off by the
opening amount.

### Upgrading to 2.8.0 (older rules, wrong categories on deposits and transfers)

Rules the add-on saved under a key the current ones no longer use would keep applying next to
the current outflow-only rules, so deposits and transfers could still get spending categories.
From 2.8.0 every sync removes the add-on's own rules that it did not just save, and the log says
so: `Spending: … N older rules removed`. Wealthfolio deletes a rule by the key it was saved under
and cannot give that key back, so the add-on remembers the keys it saves (in its own storage) and
knows the keys earlier versions used; it removes those that no longer apply and that really exist
in Wealthfolio. Rules created elsewhere, for instance by hand or in the database, are never
touched. The upgrade asks you
to approve two more Spending permissions, `getRules` and `deleteRule`. Rules are only saved when
Wealthfolio is opened over HTTPS or on localhost. A "Monzo: …" rule you created yourself that
outranks the add-on's rules (a higher priority, or no activity type) will keep filing deposits and
transfers as spending: delete or restrict it in Settings → Spending → Rules.

**Rows that already have a wrong category stay as they are.** Rules only fill in uncategorised
rows, and the SDK gives add-ons no way to clear a category, so the add-on cannot undo earlier
tags. Fix them once in Wealthfolio's Spending → Activities page: filter by type (Deposit,
Transfer in/out), select the rows that carry a spending category and clear or change it in bulk.
Salary deposits belong under Other Income (the add-on's Income rule files new ones there);
transfers and Flex repayments are meant to have no category.

### Upgrading to 2.7.0 (savings moves and the Cash ISA)

Before 2.7.0 savings-category moves, such as money to and from a Trading 212 Cash ISA, were
never imported, so the current account's balance in Wealthfolio drifted away from the Monzo
app's (too high by the net amount sent to the ISA). From 2.7.0 they are imported as withdrawals
and deposits. Past moves are not fetched by themselves (an ordinary sync only reaches back 90
days), so either

- **disconnect, reconnect and let the add-on sync straight away** (Monzo shares the whole
  history for 5 minutes after you connect), or
- **import your current-account CSV exports** from the Import CSV page (savings moves are kept
  even with "Skip bank transfers" on).

Anything already imported is recognised and skipped. When the Trading 212 Cash ISA is in
Wealthfolio, the add-on then converts and links each matching pair with the existing Cash ISA
rows (no Cash ISA re-import is needed); the log says how many it linked. Rows without a
counterpart, such as Cash ISA deposits from a bank that is not in Wealthfolio, stay deposits and
withdrawals, and anything left over can be linked by hand in Wealthfolio's **Link Transfer**
dialog. If you have already corrected the balance by hand (an adjustment, or hand-made
transfers other than ones you linked), remove the adjustment first, or the moves will count
twice.

### Upgrading to 2.5.0 (Flex repayments)

Before 2.5.0 the monthly Flex repayment was never imported, so the Flex account's balance
fell with every purchase and was never paid down, while the current account stayed overstated
by the same amount (net worth was right, both balances were wrong). From 2.5.0 repayments are
imported as transfers between the two accounts, as described above. Past repayments are not
fetched by themselves: an ordinary sync only looks at the last 90 days (and nothing earlier
than your last sync), so to bring in the earlier ones either

- **disconnect, reconnect and let the add-on sync straight away** (Monzo shares the whole
  history for 5 minutes after you connect), or
- **import your current-account CSV exports** (Account -> Export transactions -> CSV) from the
  Import CSV page, choosing your Flex account when asked.

Either way, anything already imported is recognised and skipped. Refunded Flex purchases that
an earlier version imported as a withdrawal on Flex and a deposit/refund on the current
account are converted to the transfer pair in place on the next sync that sees them. If you
already corrected the balances by hand (an adjustment or hand-made transfers), importing the
past repayments will count them a second time: remove your manual entries first.

### Upgrading to 2.4.0

Versions before 2.4.0 sent no `since` on a first sync or after **Reset sync history**, and
Monzo then returns only the last 30 days (with no error). Anyone who synced that way could be
missing transactions from 31 to 89 days back. 2.4.0 always sends `since`, and re-checks the
last 90 days once automatically on the first sync after the upgrade (anything already imported
is skipped). Older gaps still need a CSV import, or a reconnect followed by an immediate sync.

## Upgrading from v1.x

v2 replaces the proxy, so most of the old setup can be thrown away.

1. **Reinstall the zip.** Install the latest `monzo-addon-<version>.zip` over the old version
   (Settings -> Add-ons). Approve the new permissions.
2. **Your data is migrated automatically** the first time the add-on enables: the account
   mapping, last-sync time and category labels move from the keyring to add-on storage, the
   old tokens are split into the new keys, and the saved proxy URL is deleted.
3. **Stop and remove the proxy container first** (`docker stop monzo-proxy && docker rm
   monzo-proxy`, or `docker compose down` in its folder) and delete its checkout. Do this
   before reconnecting: your client's redirect URL probably points at the proxy's
   `/callback`, and while the proxy runs it redeems every login code itself (codes are
   single-use), so the add-on's own exchange is then rejected. Once it is stopped, that
   redirect URL can stay as it is: the page simply fails to load, and the code stays in the
   address bar for you to copy.
4. **Enter your Client ID and Client Secret** in Settings (the same ones the proxy used, from
   developers.monzo.com) and set the **Redirect URL** to the one registered on that client.
   v1 kept the credentials in the proxy, so Wealthfolio does not have them. Until you enter
   them, the carried-over connection works until its access token expires (up to 6 hours),
   then cannot be renewed.
5. If renewal is rejected, or anything looks off, press **Reconnect Monzo** and go through
   the paste-the-URL step again. Your account mapping and history are kept.
6. Accounts created by v1 or v2.0/2.1 may be named after Monzo's raw ids (`user_…`,
   `monzoflex_…`): those versions read the account type from the wrong field. Rename them
   in Wealthfolio if you like; the mapping is by id, so syncing is unaffected.

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
| "Wealthfolio has not approved network access to api.monzo.com" | Wealthfolio only lets an add-on reach the hosts you ticked in its permission dialog, and installing an update can leave them unticked. Open **Settings → Add-ons → Monzo Bank Sync → Permissions**, tick `api.monzo.com`, save, and try again. |
| **403** / "Monzo refused access" | The connection has not been approved in the **Monzo app** yet. Approve it there, then sync again. If you already did, disconnect and reconnect. |
| "Monzo rejected the code" | The code was used already, expired, or the client ID/secret/redirect URL differ from the registered ones. Press **Connect Monzo** (or **New link**) and paste a fresh result straight away. If the redirect URL points at a server that is still running (such as the v1 proxy's `/callback`), that server redeems the code first: stop it or use a redirect URL nothing answers. |
| "That is the Monzo login link itself" | You pasted the `auth.monzo.com` link. Open it, log in via the email, then paste the address you land on. |
| "state does not match" | The pasted URL is from an older attempt. Use the newest link, or paste only the `code`. |
| "Monzo rejected the saved refresh token" | The tokens are no longer valid or the client details do not match. Check Settings, or reconnect. |
| "Enter your Monzo client ID and secret" | Upgrading from v1: see the upgrade notes. |
| Only 90 days of transactions | A Monzo API limit: the whole history is shared only for 5 minutes after you connect. Disconnect, reconnect and let the add-on sync straight away, or use CSV import for older history. |
| Only about 30 days imported | You synced with a version before 2.4.0, which fetched just the last 30 days on a first sync or after a reset. Upgrade to 2.4.0: its first sync re-checks the last 90 days. |
| A salary or a friend's repayment is filed under a spending category (Education, Rideshare & Taxi, …) | Monzo's own rules only touch withdrawals and refund credits, and its Income rule outranks Wealthfolio's merchant presets. Wealthfolio's own **preset** merchant rules (for instance an Education rule matching a word like "University", or a Rideshare one) are outside the add-on's control, and if one is not limited to withdrawals it can still apply to a deposit whose comment contains such a word. Edit or delete that preset in **Settings → Spending → Rules**, or set the category by hand; categories you set by hand are never overwritten. Rows that were already categorised are not re-run, so fix those once by hand. |
| "N rows are refused by Wealthfolio" | Wealthfolio answers "OK" even when it refuses a row. The sync still moves on (so it never re-reads history, and Monzo's 90-day limit cannot lose the row): the refused rows wait in a small list of their own with Wealthfolio's reason and how often it refused them, the log lists them, and every sync (or CSV import) sends them again first. The error stays until Wealthfolio stores them. **Reset** forgets the list. |
| "A sync or import is already running" | Only one sync or CSV import runs at a time. Wait for the running one to finish. |
| "Account mapping is out of date" | A mapped Wealthfolio account was deleted. Open Settings to re-create and re-map it. |

## Security

- The **client secret**, **access token** and **refresh token** are stored in Wealthfolio's
  OS keyring (`secrets`). The access token is only ever used through the network broker's
  `auth` option: the add-on never reads it back, and Wealthfolio injects the
  `Authorization` header itself.
- The client secret is sent only to `api.monzo.com`, in the token exchange and refresh. The
  add-on can reach no other host.
- Non-secret state (client ID, redirect URL, token expiry, when you last logged in, account
  mapping, last-sync time, the import ledger of Monzo transaction ids, the last sync's result,
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
| storage | `monzo_authenticated_at` | when the last login completed (ms since epoch); a sync soon after reads the whole history |
| storage | `monzo_oauth_state` | `state` of a connection in progress |
| storage | `monzo_account_mapping` | Monzo account id -> Wealthfolio account id |
| storage | `monzo_last_sync` | `since` watermark for the next sync |
| storage | `monzo_last_run` | when the last sync finished (display) |
| storage | `monzo_rechecked_90_days` | set once a sync has covered the last 90 days (the one-off check after upgrading to 2.4.0) |
| storage | `monzo_imported_ids` | import ledger: Monzo transaction id -> account and content hash of the imported activity |
| storage | `monzo_last_result` | the last successful sync's result and steps, shown on the dashboard |
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
    │   ├── busy.ts            # one sync/import at a time
    │   ├── sync.ts            # fetch -> filter -> reconcile -> import
    │   ├── mapper.ts          # Monzo transaction -> cash activity (+ filters)
    │   ├── csv-parser.ts      # Monzo CSV export
    │   ├── csv-import.ts      # import several CSV files into accounts
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
