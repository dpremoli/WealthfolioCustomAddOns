# Wealthfolio Revolut Add-On

Import your **Revolut** account statements into [Wealthfolio](https://wealthfolio.app)
and feed your card spending into the spending module — all from a CSV export.

Part of the [Wealthfolio custom add-ons monorepo](../../README.md), alongside the Monzo
and Trading 212 add-ons; unlike those it is **CSV-only**. Requires **Wealthfolio 3.11+**.

## Why CSV (and not an API)?

Revolut does **not** offer a free API for personal accounts:

- The **Open Banking API** is restricted to regulated banking partners (AISPs) — you
  cannot use it for your own personal account.
- The **Business API** only covers Revolut *Business* accounts.

So there is no proxy or OAuth to set up here — you simply export a statement from the
Revolut app and import the CSV. (If Revolut ever ship a usable personal API, this can
be extended like the Monzo/Trading 212 add-ons.)

## What it does

- Parses a Revolut account-statement CSV
  (`Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance`).
- Imports only **completed** transactions (pending/declined/reverted rows are skipped).
- **One cash account per currency.** A single Revolut export can mix currencies
  (e.g. GBP, EUR, USD). The add-on detects each currency and imports its rows into a
  dedicated `Revolut <CCY>` account, so every account reconciles to Revolut's own
  per-currency balance instead of mixing currencies in one account.
- Maps each row to a Wealthfolio cash activity by its Revolut type:
  - Card Payment / ATM → `WITHDRAWAL`, card refunds / credits → `DEPOSIT`;
  - Transfers & Exchanges → `TRANSFER_IN`/`TRANSFER_OUT` — kept in the balance but
    **excluded from spending analytics** (a cross-currency exchange becomes a
    `TRANSFER_OUT` on one account and a `TRANSFER_IN` on the other, and both reconcile);
  - Top-ups → `DEPOSIT` (incoming funding / income);
  - the merchant/description is kept as the activity comment so **Wealthfolio's
    spending module can categorise it**;
  - any separate Revolut **fee** is imported as its own `FEE` activity so the cash
    balance stays accurate.
- Seeds each account's **opening balance** so the imported balance reconciles to
  Revolut. A statement only lists movements within its date range, so summing them
  would give the *net flow*, not the real balance — the account would be short by
  whatever it held before the first row (this is what makes a balance come out
  negative). The opening balance is recovered per currency from the earliest row's
  `Balance` column and imported as a single dated `Opening balance` activity.
- Lets you map each currency to an **existing** account or **create a dedicated
  `Revolut <CCY>` cash account** (CASH, transactions-tracked) with one click, and
  remembers the mapping for next time.
- Imports every transaction faithfully, even genuine duplicates. Wealthfolio's importer
  otherwise merges any two activities that share the same account, day, type and amount
  (e.g. two £1,000 transfers on one day, or a repeated charge), silently dropping real
  money. The add-on forces each row in and de-duplicates itself, by **row id**: every
  imported row's id (derived from its time, amount, description and balance) is recorded in
  an import ledger in add-on storage, so importing the same or an overlapping statement
  again adds nothing, genuinely repeated transactions are all kept, and a row you have since
  edited, converted to a transfer or linked is still recognised (and left as you made it).
- **Links what moved between your own accounts**, after each import (see below), and shows
  one line per kind, e.g. `Exchanges: 3 linked.`

## Linking transfers

Linking makes Wealthfolio treat both halves of a move as one transfer between your own
accounts instead of two unrelated rows. Only confident, unique matches are linked; a tie is
left alone (and reported), and a row that is already linked — by an earlier import, another
add-on or by hand — is never touched. Running the import again is safe.

- **Currency exchanges.** Revolut writes an exchange as two rows with the same timestamp: a
  debit in the currency sold and a credit in the currency bought, both described
  `Exchanged to <bought currency>` (`Exchanged from <sold currency>` is accepted too). Both
  are already transfers, so the add-on links the `TRANSFER_OUT` in one currency's account with
  the `TRANSFER_IN` in the other's when they are within 2 minutes of each other and the
  descriptions agree with the two currencies. Amounts are not compared (they differ by the
  exchange rate).
- **Trading 212.** With the [Trading 212 add-on](../trading212/README.md) installed, a Revolut
  row whose description points at Trading 212 (its name, or one of your Trading 212 account
  numbers quoted as the reference) is matched with the same amount moving into or out of a
  Trading 212 Invest, Stocks ISA or Cash ISA account within 3 days. Both rows become transfers
  and are linked, so an ISA deposit made from Revolut counts once toward the allowance.
- **Savings.** Pick your **Savings account** on the import page (e.g. a `Revolut Savings`
  account you keep in Wealthfolio; optional, remembered). Rows described `Depositing savings`
  (money into a savings pot) and `Withdrawing savings` (back out) are then matched with the
  same amount moving in that account within 3 days, converted to transfers and linked. Rows
  with no counterpart stay as they are.

If a pair cannot be linked, both rows are put back exactly as they were (an unlinked transfer
would otherwise be miscounted, e.g. against an ISA allowance).

## How to export your statement from Revolut

1. Open the Revolut app and tap your account.
2. Tap **⋯ → Statement**.
3. Choose **Excel/CSV** format, pick a date range, and generate it.
4. Save the `.csv` file to your computer.

## Install

1. Download `revolut-addon-<version>.zip` from the monorepo's
   [releases](https://github.com/dpremoli/WealthfolioCustomAddOns/releases) (tag `revolut-v…`), or build it (below).
2. In Wealthfolio: **Settings → Add-ons → Install from file** and select the zip.
3. Enable the add-on. A **Revolut Import** item appears in the sidebar.

### Upgrading from 1.x

Version 2.0 is rebuilt for Wealthfolio's sandboxed add-on runtime (3.6+), so 1.x no
longer loads on current Wealthfolio. Install the 2.0 zip over it; your saved
currency → account mapping moves from the keyring into add-on storage on first start.
Nothing else changes, and re-importing a statement you already imported adds nothing.

### Upgrading from 2.0

From 2.1 the add-on recognises rows by their id (kept in an import ledger) instead of by
content. Rows imported by 2.0 are matched by content once, the first time you import a
statement covering them, and recorded in the ledger, so **re-importing an old statement is
safe**: nothing is duplicated, including rows you have since converted to transfers or linked
by hand. That first import also links any exchanges, Trading 212 and savings moves already in
your accounts. The add-on now asks for three more permissions: `activities.saveMany` (to turn
a matched withdrawal/deposit into a transfer), `activities.getTransferPair` (to see whether a
row is already linked) and `activities.linkTransfer` (to link the pair).

## Import

1. Open **Revolut Import** in the sidebar, then **Import CSV**.
2. Choose your exported CSV.
3. For each currency detected, pick an account or click **+ Revolut <CCY>** to create
   one (or **Create all missing accounts**).
4. Optionally pick your **Savings account** (see [Linking transfers](#linking-transfers)).
5. Click **Import**. Each currency's rows go to its mapped account; re-importing the
   same or an overlapping statement is safe (it adds nothing). The result shows what was
   imported and one line per kind of linking.

If Wealthfolio refuses some rows (it answers "OK" even then), the import ends with an error that
names the first row and Wealthfolio's reason and lists them. Refused rows are not remembered as
imported: fix the cause and import the same statement again, and only those rows are added.

## Permissions

| Category | Functions | Why |
| --- | --- | --- |
| `accounts` | `getAll`, `create` | List your accounts; create a `Revolut <CCY>` cash account |
| `activities` | `import`, `getAll` | Import rows and reconcile against what is already there |
| `activities` | `saveMany`, `getTransferPair`, `linkTransfer` | Link exchanges, Trading 212 and savings moves as transfers (converting a matched withdrawal/deposit) |
| `secrets` | `get`, `delete` | Move the 1.x account mapping out of the keyring |
| `ui` | `router.add`, `navigation.navigate` | The dashboard and import pages |

## Development

From the monorepo root:

```bash
pnpm install
pnpm --filter ./addons/revolut test         # unit tests (vitest)
pnpm --filter ./addons/revolut type-check   # tsc --noEmit
pnpm --filter ./addons/revolut bundle       # → addons/revolut/dist/revolut-addon-<version>.zip
```

The add-on is a single ES module (`dist/addon.js`) built with the shared Vite config;
React, `@wealthfolio/ui`, the SDK and React Query are provided by the Wealthfolio
sandbox. Shared parsing/reconcile code lives in `packages/addon-kit`.

## License

GPL-3.0 — see [LICENSE](../../LICENSE).
