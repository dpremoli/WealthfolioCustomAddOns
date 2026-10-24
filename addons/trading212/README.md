# Trading 212 → Wealthfolio Addon

Automatically sync your **Trading 212** investment account into Wealthfolio via
Trading 212's official [public API](https://docs.trading212.com/api): trades,
dividends, interest, deposits, withdrawals and fees — each tagged to the correct
Wealthfolio activity type, with tickers matched to Wealthfolio symbols automatically.

Part of the [Wealthfolio custom add-ons monorepo](../../README.md). Requires
**Wealthfolio 3.11+** (add-on SDK 3.11.0).

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
> add-on detects the change and asks before re-syncing. **Holdings → Transactions** imports
> the full history and keeps the old snapshots (Wealthfolio ignores them in Transactions mode
> and uses them again if you switch back; it would not let an add-on delete them anyway).
> **Transactions → Holdings** deletes the imported activities and writes a snapshot.

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
> Card purchases are paid out of the investing account's cash, so each card row comes with a
> linked **transfer** that moves the money from the investing account to the card account
> (refunds and cashback go back the other way). The card account therefore stays at zero, the
> investing account's cash matches Trading 212, and the purchases still count as spending. Card
> rows imported by earlier versions get their transfer on the next sync.
>
> You can also choose the **card account type** (Cash or Credit Card) right below the toggle.
> *Cash* is accurate for the debit card; *Credit Card* models it as a liability so Wealthfolio
> can link payments from a tracked cash account as transfers (avoiding double-counted spending).
> The type is applied when the card account is first created — to retype an existing one, use
> Wealthfolio's **Update Account** dialog.

> **Monthly interest totals (off by default):** Trading 212 pays interest on cash every day,
> which adds up to thousands of rows. With **Settings → Connection → Monthly interest totals**
> on, a Transactions-mode backfill imports one interest row per month (for the months before
> the backfill; the current month stays daily). It applies to the next full backfill, and
> switching it never counts interest twice.

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
| Stock split open + close (one pair) | `SPLIT`, ratio = shares after ÷ before |
| Stock distribution (spin-off) | `TRANSFER_IN` of the shares at no cost (internal: no cash, no contribution) |
| Currency conversion | `TRANSFER_OUT` + `TRANSFER_IN` in the same account (linked as a currency exchange), plus a `FEE` |
| Dividend adjustment / Result adjustment | cash income, or a `FEE` when negative (a clawback) |
| Dividend (Return of capital …) | `DIVIDEND` with subtype `RETURN_OF_CAPITAL` (lowers the cost basis) |
| Card debit / credit / cashback (with card extraction on) | `WITHDRAWAL` / `DEPOSIT` / `INTEREST` on the card account, plus a linked transfer pair with the investing account |

Holdings are derived by Wealthfolio from these activities — make sure the account
stays in **`TRANSACTIONS`** tracking mode.

Trade fees include the stamp duty reserve tax and French transaction tax columns, since
Trading 212's total includes them.

**Several currencies.** An account topped up in GBP or USD keeps a wallet per currency: a
deposit stays in the currency it was made in, and a currency conversion moves cash between
wallets. Wealthfolio shows each wallet; Trading 212's API reports one cash total in the account
currency, so the check below compares the wallets' total, converted at Wealthfolio's rates.

**Splits Trading 212 does not list.** Older splits (Amazon and Alphabet 20:1, Sherwin-Williams
and Walmart 3:1, NVIDIA 10:1 …) are applied to your position by Trading 212 but have **no row in
its history export**, so the imported trades fall short by the split. The add-on notices from
the check below (Trading 212 holds 2.1649, the trades add up to 0.108245) and, for a security in
its built-in list of known splits (`src/lib/known-splits.ts`, keyed by ISIN), adds the `SPLIT`
**only if applying it reproduces Trading 212's quantity exactly**. Wealthfolio's stored prices are
split-adjusted, so the date cannot be found from them; that is why the list supplies it. It also
holds consolidations, such as Pennon's 2-for-3 of July 2021 (ratio 2/3).

**A split that is not on the list** can still be found when the position paid dividends. Each
dividend row in the export says how many shares you held when it was paid ("No. of shares"), and
the add-on keeps those counts. It replays your trades without the split: the last dividend whose
count the replay agrees with and the first whose count it does not bracket the split, and the ratio
is the count Trading 212 quotes divided by the holding the replay gives (it must be one of the
usual ratios: a whole ratio such as 3:1 or 20:1, a reverse split such as 1:10, or 3:2, 2:3, 5:2 or
2:5, and the same for every dividend after it). The `SPLIT` is added, dated inside that window,
**only if it makes the trades add up to Trading 212's quantity exactly**; the log gives the window
and the ratio. Nothing is added when the evidence is unclear: no dividend on one side of the
window, a last matching dividend whose count a later trade had already moved, ratios that are
unusual or differ, or a dividend that contradicts the order.

**What this cannot tell apart is a split and a trade missing from the account**: either changes
every later count by the same factor. So it is not used in a sync that left out any trade (the log
says so; add the rows, then sync again), and fractions such as 6:5 are never read as splits. If you
add a missing trade by hand after a `SPLIT` was inferred for the same position, delete that
`SPLIT`. The counts are read from a full backfill (and from the dividends of later syncs), so a
position whose dividends predate an upgrade needs **Reset** and a sync to have them. Counts are
kept per ISIN, so two listings of one security share them. Otherwise
the position is described in the log with the overall ratio it implies (a position of which only
part predates the event changes by less than the event's own ratio), so you can add a `SPLIT` in
Wealthfolio's Activities by hand, or add the ISIN and date to the list.

### Checking a backfill against Trading 212

When a Transactions-mode backfill finishes, the add-on waits for Wealthfolio to recalculate the
account and compares what it shows with Trading 212 — every position from `/equity/positions`
(the call Holdings mode uses) and the cash from `/equity/account/summary`. Each difference is
listed in the sync log (a wrong quantity, a position on one side only, an instrument that did not
match a symbol, cash in the wrong amount), the sync ends with an error, and the dashboard shows **"N differences from Trading 212"** with the list on hover. The
check runs again on every sync until the account matches, then shows **"Matches Trading 212"**.

Every row Wealthfolio did not import is listed too, with its type, date, symbol, Trading 212
id and Wealthfolio's reason, as is every trade whose instrument did not match a symbol; a sync
that left out a trade ends with an error saying holdings will not match.

### Moves to and from your bank

After a Transactions-mode sync, each deposit and withdrawal is paired with the bank side of the
move in your other Wealthfolio accounts (a Monzo or Revolut account another add-on keeps, say)
and turned into a **linked transfer**: same amount and currency within 3 days, and the bank row's
payee must point at Trading 212 — "Trading 212", "Trading TwoOneTwo", or one of your Trading 212
account numbers as the reference. Ties are left alone, and so is a deposit with no counterpart:
it stays a deposit, which is what Wealthfolio's ISA allowance counts.

### Symbol matching

Each Trading 212 ticker (e.g. `AAPL_US_EQ`) is matched to a Wealthfolio symbol
using Wealthfolio's own market-data search (`searchTicker`), trying the instrument
ISIN, then the base ticker, then the name, and preferring symbols you already hold. The export
names an instrument by its plain ticker (`VUAA`) and the API by its own (`VUAAm_EQ`); both share
one resolution through the ISIN and currency, so an instrument always lands on one listing.
Crypto pairs, currencies and indices are never picked. Resolutions are cached and shared by
both sync modes, and every imported trade and dividend carries the listing's exchange (MIC),
like Holdings snapshots do, so both modes land on the same asset (without it Wealthfolio picks
its own default listing, and a ticker such as `LTC` becomes Litecoin). Trades whose symbol
can't be matched are skipped and listed in the sync log.

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
little while. The limits are per API key, so your accounts sync side by side, and activities
are imported up to 1,000 per call (each call makes Wealthfolio recalculate the portfolio).

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

**Moves to and from Monzo.** Deposits and withdrawals stay `DEPOSIT` and `WITHDRAWAL`: that
is right for everyone, and it is what makes a deposit count towards the ISA allowance. If the
other half of a move is in Wealthfolio too (a Monzo current account synced by the Monzo
add-on), the import looks for it among your other cash accounts: a row whose payee reads
"Trading 212", with the same amount and currency, the opposite direction, dated within 3 days
and not linked yet. For a confident match (the closest date; an exact tie is skipped and logged)
both rows are turned into a `TRANSFER_IN` / `TRANSFER_OUT` in place and linked as an internal
transfer; if linking fails they are put back. A deposit from a bank that is not in Wealthfolio
(Chase, say) has no counterpart and stays a deposit on purpose: an unlinked transfer into an
ISA would not count towards the allowance. A transfer you already made by hand is recognised as
the same row, not imported again. The Monzo add-on does the same from its side, so it does not
matter which one sees the pair second. Anything left can be linked in Wealthfolio's **Link
Transfer** dialog.

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

## Upgrading to 2.6.4

Fixes from a real Transactions switch on Wealthfolio 3.11.0:

- **Rows Wealthfolio stored are no longer listed as refused.** Wealthfolio returns a row it was
  told to store despite looking like a duplicate (two identical deposits on one day) still marked
  as a duplicate, and 2.6.2 took the whole call for refused although every row was saved. A row is
  now judged by what the call says it stored; when the counts still disagree, the account is read
  again to see which rows are there, and no call is refused wholesale. The next sync clears the
  rows 2.6.2 listed by mistake (they are found in the account).
- **Card spending is no longer imported twice.** Card rows already in the card account are
  matched by day, amount and type, whatever the merchant text an older version wrote ("Lidl GB" or
  "Lidl"). A row Wealthfolio already has is never forced in again; only a second identical row
  (two coffees on one day) is.
- **Card funding with half missing is repaired.** A funding transfer whose other half is gone
  (its account was deleted, say) is deleted, and its card row is funded again. Removing a
  connection in Settings also deletes the card-side halves left without a partner (after you
  deleted its Wealthfolio account).
- **Splits and consolidations of London shares are no longer off by 100.** Wealthfolio divides
  the amount of a row in pence by 100, a split's ratio included (Reckitt showed a hundredth of
  its shares). Splits are now sent in pounds, and the next sync puts right the splits an earlier
  version stored that way.
- **The split repair reads the account itself**, so it sees every stored row (2.6.2 missed the
  rows it had wrongly listed as refused and added no split).
- **One listing per instrument.** The export's rows and Trading 212's positions name an instrument
  differently (`VUAA` and `VUAAm_EQ`), and could land on two listings (VUAA on Milan, VUAAM on
  Cboe). Both now share one resolution through the ISIN, and the European tickers' exchange letter
  (`m` Milan, `l` London, `d` Xetra, `p` Paris, `a` Amsterdam, `e` Madrid) picks the listing. The
  check after a backfill notes a position held under another listing's symbol with the same number
  of shares instead of reporting a difference. Assets an earlier version created on another
  listing stay as they are: switch the account again (or **Reset** and sync) to rebuild it.
- **Shares a corporate action takes away for nothing** (a "Market sell" with no price and no
  proceeds, such as the old line of a spin-off) are booked as a transfer out at zero value instead
  of being left out.


- **The Cash ISA CSV import no longer records rows Wealthfolio did not store.** Wealthfolio
  answers "OK" even when it saves nothing, and the import used to remember every row as imported
  regardless, so such a row was skipped on every later import. Now only stored rows are
  remembered; a row Wealthfolio refuses waits in a small list of its own (with its reason and how
  often it was refused), is sent again with every later import, and the error stays until it is
  stored.

## Upgrading to 2.6.2

- **2.6.0 and 2.6.1 saved no trades, dividends or deposits to Transactions accounts** (only card
  spending went in) while recording them as imported. 2.6.2 fixes the import, and an account in
  that state repairs itself: when the add-on has ids recorded as imported but the account holds no
  trades (or nothing at all), the next sync forgets those ids and reads the whole history again.
  Nothing is deleted. If you only have some trades missing, **Reset** the connection in Settings
  and sync.
- **A sync now fails loudly** when Wealthfolio does not store rows that were sent: the error names
  the first row and why, the log lists them, and the ids of unsaved rows are not recorded.
- **Rows Wealthfolio refuses keep being retried, without slowing the sync.** A row it refuses on
  every call (a symbol it cannot find, a delisted instrument) is kept in a short list of its own
  (with Wealthfolio's reason and how often it was refused). The history is still marked as read, so
  no sync re-downloads it; only the listed rows are sent again at the start of every sync, and a row
  leaves the list once Wealthfolio has stored it. The error stays while the list is not empty. Card
  rows are treated the same way.
- **Long histories no longer hit Wealthfolio's storage limit** ("too large to sync across
  devices"): the imported-row ids are kept in 32 small keys instead of one value.
- **The sync log stays after a refresh**: each account's last result (summary, symbols, Log
  tab) and the activity feed come back when you open the dashboard again. **Reset** clears it.

## Upgrading to 2.6.1

- **2.6.0 does not load in Wealthfolio 3.11** ("Addon 'trading212-addon' failed to load:
  Unexpected token '.'"). Install 2.6.1. Nothing else changes for the fix: your connections,
  imported activities and settings are untouched.

- **Splits that are not on the known list can be inferred from dividend rows** (see "A split that
  is not on the list" above). It starts with the next full backfill, which keeps the dividends'
  share counts; **Reset** an account and sync once to have them for an account backfilled earlier.
  No new permissions.

## Upgrading to 2.6.0

- **Stock splits, spin-offs, adjustments and currency conversions are imported** (see the
  mapping table). An account that was never backfilled needs nothing. One that an earlier version
  backfilled holds rows the old mapping got wrong: a "Currency conversion" was booked as a fee of
  its whole amount, and a negative "Dividend adjustment" as income. Clear that account's
  activities in Wealthfolio's Activities page, then **Reset** it in Settings and sync, so the
  history is rebuilt with the new mapping (switching an account's tracking mode away and back
  does the same).
- **Per-currency cash is expected.** A GBP deposit stays in a GBP wallet; the check compares
  the total in the account currency (within 1% for the exchange rates).
- Updating adds a permission for exchange rates (`currency.getAll`).

- **Switching an account from Holdings to Transactions works now.** It used to stop at
  "Clearing holdings data…" because Wealthfolio refuses to delete an add-on account's snapshots;
  the old snapshots are now kept (Wealthfolio ignores them in Transactions mode).
- **Card accounts get their funding transfers** on the next sync, so the card account's balance
  goes to zero and the investing account's cash goes down by what the card spent.
- **A Transactions-mode backfill is checked against Trading 212** (see above). Existing accounts
  are checked after their next full backfill; use **Reset** in Settings to run one.
- Deposits and withdrawals are linked with your bank's side of the move.
- Updating adds two permissions (`portfolio.getHoldings`, `events.onUpdateStart`), so
  Wealthfolio asks you to approve the add-on's permissions again.

## Upgrading to 2.5.0 (Cash ISA moves)

Nothing to re-import. Old Cash ISA deposits and withdrawals stay as they are; when the Monzo
add-on (2.7.0) imports the matching savings moves, or the next time you import a Cash ISA CSV,
each pair is converted to a linked transfer. To bring in Monzo's side of past moves, follow the
upgrade note in the Monzo add-on's README (reconnect and sync straight away, or import the
current-account CSV). Updating adds two activity permissions (`getTransferPair`,
`linkTransfer`), so Wealthfolio asks you to approve the add-on's permissions again.

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
