# Payslips & Pension add-on — design

Status: approved in chat (2026-10-28). Target: Wealthfolio / addon SDK 3.11, sandboxed runtime.

## Goal

A new add-on `addons/payslips` ("Payslips & Pension") that reads SAP payslip PDFs entirely in the
add-on sandbox, keeps their figures per UK tax year, matches each payslip's net pay to the salary
deposit already in a bank account, shows income tax / NI / student loan per tax year, tracks USS
pension contributions and statements, and — opt-in, previewed — records payroll in its own
Wealthfolio account.

## Hard constraints

- No `network` and no `secrets` permission. Payslips never leave the sandbox.
- Never read into stored state, log or display: employee name, NI number, employee number, tax
  reference, tax office. Keep only figures, pay date, tax period, tax code.
- The repo is public: synthetic fixtures only.
- Every write to the Wealthfolio ledger is explicit, previewed and opt-in.

## Decisions taken with the user

| Question | Decision |
| --- | --- |
| Payroll ledger account | Build it, opt-in, off by default, previewed. |
| How the payroll account appears in Spending | Kept out: the user leaves the "Payroll" account disabled for Spending (no API sets this; the UI and README say so). |
| Net-pay leg | Linked transfer: payroll `TRANSFER_OUT`, bank deposit converted `DEPOSIT → TRANSFER_IN`, linked through the host's transfer-link API (kit `convertAndLinkMoves`). Consequence (stated in UI/README, unverified host behaviour): the salary may then count as income nowhere in the spending report. |
| Default accounts searched for the deposit | All active GBP cash accounts (no high-risk `searchCashActivities` permission); the user can untick any. |
| DC pot mirroring into a Holdings account | Not now. DC values are recorded in statements and displayed only. |
| PDF parsing | Hand-written minimal extractor, no dependency (pdf.js would trip `check-bundle.mjs` with its dynamic `import(` and weighs >1 MB). |

## Units

All under `addons/payslips/src/lib/` unless noted.

- **`pdf-text.ts`** — `extractPdfLines(bytes: Uint8Array): Promise<PdfLine[]>`. Finds every
  `stream … endstream` whose dictionary is not an image/font/XObject, inflates `/FlateDecode`
  with `DecompressionStream("deflate")`, tokenises `BT … ET` blocks (`Td`, `TD`, `Tm`, `Tf`, `Tj`,
  `TJ`, `'`, `"`; hex `<…>` and literal `(…)` strings with escapes), decodes windows-1252 and
  returns lines `{ page, y, text }` sorted by page then y descending. Characters are placed in a
  line by `x / charWidth` (fixed-width Courier: width = 0.6 × font size) so columns are kept.
  Throws `PdfTextError` with a clear message for: not a PDF, encrypted, no text (scanned).
- **`payslip-parser.ts`** — `parsePayslipLines(lines: string[]): ParsedPayslip`. Reads by label:
  `Pay Date`, `Tax Period`, `Tax Code/Basis`, the Payments/Deductions table (left column =
  payments, right column = deductions, split at the `Deductions` header column), `Total Payments`,
  `Total Deductions`, `This Period`, `To date`, `Net Pay`. Amounts with a trailing `-` are negative.
  Lines carrying the name / employee number / NI number / tax ref / tax office are matched by the
  label on their left only to pick out the right-hand field; their left-hand values are never
  captured. Throws `PayslipFormatError` when a required field (pay date, tax period, net pay, the
  two tables' totals) is missing: "Not a recognised SAP payslip layout".
- **`validate.ts`** — `validatePayslip(p): string[]` (warnings):
  payments sum = Total Payments; deductions sum = Total Deductions;
  Total Payments − Total Deductions = Net Pay; This Period tax = "Tax paid" line(s); This Period
  EE's NIC = "Employee NIC" line(s). All compared at ±0.005.
- **`tax-year.ts`** — UK tax year helpers: `taxYearOf(date)` (starts 6 April),
  `taxYearLabel(start)` ("2026/27"), `periodMonth(period)` (1 = April … 12 = March),
  `parseTaxPeriod("07/2026")`.
- **`model.ts`** — the stored `Payslip` type: `{ payDate (YYYY-MM-DD), taxYear, period, taxCode,
  payments: Line[], deductions: Line[], totalPayments, totalDeductions, netPay, thisPeriod: Ytd,
  toDate: Ytd, warnings: string[], importedAt }` with `Line = { description, units?, amount }`,
  `Ytd = { grossPay, taxablePay, tax, eeNic }`. Derived figures (pure functions):
  `ussSacrifice` (− sum of payment lines matching `/^USS\b/i` with negative amount),
  `grossBeforeSacrifice` (= totalPayments + ussSacrifice), `incomeTax`, `employeeNi`,
  `studentLoan` (deductions matching `/student loan|\bSLC\b|\bPGL\b/i`), `otherDeductions`.
- **`store.ts`** — storage layout (all JSON via kit `jsonStore`):
  - `payslips/<taxYearStart>` → `Payslip[]` (one tax year: ≤ ~14 payslips, a few KB);
  - `payslips/index` → `number[]` tax years present;
  - `links/<taxYearStart>` → `Record<payDate, Link>` with
    `Link = { activityId, accountId, chosen: "auto" | "manual", tagged?: boolean }`;
  - `uss-statements` → `UssStatement[]`, capped at 100 entries;
  - `settings` → `{ accountIds?: string[]; windowDays: number; payroll: { enabled: boolean; accountId?: string } }`;
  - `payroll-refused` → kit refused-rows store for the payroll account.
  `savePayslips(list)` groups by tax year and replaces same-`payDate` entries.
- **`salary-match.ts`** — `matchSalaries(payslips, rows, windowDays, links)` →
  per payslip `{ status: "matched" | "ambiguous" | "missing", activity?, candidates }`. Candidate
  rows: `DEPOSIT` (and `TRANSFER_IN`, which is what a linked payroll transfer turns the deposit
  into) in GBP with |amount − netPay| < 0.005, dated within ±windowDays (default 4) of the pay date.
  A stored manual link wins when its row still exists. Otherwise the kit's new `matchNearest`
  decides (closest date; a tie, or a row wanted equally by two payslips, is ambiguous).
  `loadCandidateRows(ctx, accountIds)` reads `activities.getAll` per account.
  `tagDeposit(ctx, row, payDate)` writes `withSourceRef(comment, "payslip:<payDate>")` via
  `activities.saveMany` (opt-in button only).
- **`payroll.ts`** — `planPayroll(payslip, accountId)` → `ActivityImport[]` with ids
  `payslip:<payDate>:<n>` and refs in comments: `DEPOSIT` Total Payments ("Gross pay … after USS
  salary sacrifice £x"), `TAX` income tax, `TAX` employee NI, `WITHDRAWAL` each other deduction,
  `TRANSFER_OUT` net pay. Sums to 0. Only payslips with no warnings are offered.
  `ensurePayrollAccount(ctx)` reuses or creates `Payroll` (CASH, GBP, TRANSACTIONS, provider
  `payslips-addon`, providerAccountId `payroll`). `recordPayroll(ctx, payslips, …)`:
  reconcile against the account (`pendingRows` → `selectNewActivities` → `importStoredRows` →
  `recordRefused`), then for each payslip with a matched bank deposit, link its `TRANSFER_OUT`
  with the deposit through the kit's `convertAndLinkMoves`.
- **`uss.ts`** — `ussContributions(payslips)` per tax year and total; `latestStatement`;
  `dbCapitalEstimate(s) = pension × 20 + lumpSum` (display only, labelled estimate).

Kit change (`packages/addon-kit/src/move-match.ts`): extract `matchNearest(keys, candidates,
fits, distance)` — the generic "closest wins, ties ambiguous, contested candidate goes to the
nearest claimant" algorithm — and rebuild `matchMoves` on it (behaviour unchanged, existing tests
cover it). The kit's fake host gains `getTransferPair` / `linkTransfer` and `saveMany` patching
`activityType` / `comment`, so linking is tested on the fake host.

## Pages (kit `registerPages`, ids = manifest routes)

- `payslips` (root) — file input + DOM drag-and-drop of PDFs (many at once), per-file result
  (imported / replaced / failed: reason), list of payslips for the selected tax year with warnings
  and match status (matched / ambiguous → choose / missing), tag-deposit button.
- `payslips-tax` (`tax`) — tax-year picker; StatTiles: gross before USS, USS sacrifice, taxable
  pay, income tax, employee NI, student loan, net; effective rates (tax, NI, total deductions as %
  of gross before USS); monthly stacked bar chart (recharts, host-provided); YTD figures from the
  latest payslip; months with no payslip.
- `payslips-pension` (`pension`) — USS contributions per tax year and total; statements table with
  an add/delete form (date, DB annual pension, DB lump sum, DC pot?, employer contribution?);
  latest values; DB capital estimate labelled "Estimate — not included in net worth"; pointer to
  Wealthfolio's native retirement planner ("Add retirement income" / "Add pension fund").
- `payslips-settings` (`settings`) — accounts searched for salary, match window, payroll account
  opt-in with preview table and "Record" button, and the Spending caveat.

## Permissions (manifest)

`accounts: getAll, create`; `activities: getAll, import, saveMany, getTransferPair, linkTransfer`;
`ui: router.add, navigation.navigate`. (`checkImport` is not called.) No `network`, `secrets`,
`spending`, `snapshots`.

## Error handling

- Per-file failures are shown next to the file; other files still import.
- Validation mismatches never block storing; they show as warnings and exclude the payslip from
  the payroll ledger.
- Payroll import failures go to the refused-rows store and keep an error banner until settled.
- Linking failures leave rows as `convertAndLinkMoves` restores them; the outcome is shown.

## Testing

- `test-utils.ts`: a tiny PDF writer emitting the SAP structure (Type1 Courier, one `BT x y Td /F1
  8 Tf <hex> Tj ET` per line, optional FlateDecode via `node:zlib`), plus a synthetic payslip
  text builder.
- `pdf-text.test.ts`, `payslip-parser.test.ts`, `validate.test.ts`, `tax-year.test.ts`,
  `store.test.ts` (sharding, replacement, size under the fake host's cap with years of payslips),
  `salary-match.test.ts` (matched, ambiguous, missing, manual link, tagging on the fake host),
  `payroll.test.ts` (plan sums to 0, import on fake host, refused rows, transfer linking),
  `uss.test.ts`, and the kit's `matchNearest`.
