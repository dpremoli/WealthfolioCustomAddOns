# Payslips & Pension add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `addons/payslips`: in-sandbox SAP payslip PDF parsing, per-tax-year storage, salary-deposit matching, tax and USS dashboards, and an opt-in payroll ledger account.

**Architecture:** Pure `lib/` modules (PDF text → lines → payslip → derived figures) with a storage module sharded per tax year; host-touching modules (matching, payroll) take `ctx` and are tested on the kit's fake host. Pages are thin React views over those modules, registered with the kit's `registerPages`.

**Tech Stack:** TypeScript, React 19, `@wealthfolio/addon-sdk` 3.11, `@wealthfolio/ui` (+ host-provided `recharts`), `@wf-addons/kit`, Vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-10-28-payslips-addon-design.md`

## Global Constraints

- No `network`, no `secrets` permission; manifest `permissions` cover exactly the `ctx.api.*` calls used.
- Never capture name, NI number, employee number, tax reference, tax office.
- Synthetic fixtures only (public repo).
- manifest.json and package.json versions equal; release with `pnpm bump payslips minor` (from 0.0.0 → 0.1.0).
- One storage value < ~244 KB; shards per tax year.
- No dynamic `import(` in the bundle, no class method named `import`.
- `pnpm check` passes.

## Review Focus

1. Payslip with a student-loan or extra payment line (overtime, back pay) — captured generically, sums still validate. → Task 3 test `captures extra payment and student loan lines`.
2. PDF whose content stream is FlateDecode-compressed — same lines as uncompressed. → Task 2 test `inflates FlateDecode streams`.
3. Same pay date imported twice (corrected payslip) — replaced, not duplicated. → Task 5 test `replaces a payslip with the same pay date`.
4. Two payslips with the same net pay in consecutive months — each matches its own month's deposit, not ambiguous. → Task 6 test `same net pay in consecutive months matches each month`.
5. Payroll record run twice — imports nothing new, links nothing twice. → Task 7 test `recording twice adds nothing`.

---

### Task 1: Kit — `matchNearest`, fake-host transfer links

**Files:**
- Modify: `packages/addon-kit/src/move-match.ts`, `packages/addon-kit/src/index.ts`, `packages/addon-kit/src/testing/fake-host.ts`
- Test: `packages/addon-kit/src/move-match.test.ts`

**Interfaces:**
- Produces: `matchNearest<K, C>(keys: K[], candidates: C[], fits: (k: K, c: C) => boolean, distance: (k: K, c: C) => number): { pairs: { key: K; match: C }[]; ambiguous: K[] }` — closest candidate wins; a tie on the closest distance → key ambiguous; a candidate claimed by several keys goes to the nearest, or to none (all ambiguous) on a tie.
- `matchMoves` re-implemented on it, unchanged behaviour.
- Fake host: `activities.getTransferPair(id)` → `{transferOut, transferIn}` or null; `activities.linkTransfer(outId, inId)`; `saveMany` updates also patch `activityType` and `comment`.

- [ ] Tests: `matchNearest` pairs closest; tie → ambiguous; contested candidate → nearest key; existing `matchMoves` tests still pass.
- [ ] Implement, run `pnpm --filter @wf-addons/kit test`, commit.

### Task 2: Scaffold add-on + PDF text extractor

**Files:**
- Create: `addons/payslips/{manifest.json,package.json,tsconfig.json,vite.config.ts,vitest.config.ts}`, `src/addon.tsx` (empty pages for now), `src/constants.ts`, `src/lib/pdf-text.ts`, `src/test-utils.ts`
- Test: `src/lib/pdf-text.test.ts`

**Interfaces:**
- Produces: `extractPdfLines(bytes: Uint8Array): Promise<string[]>` (lines of page 1..n, top to bottom, columns by Courier char width); `class PdfTextError extends Error`.
- `test-utils.ts`: `writePdf(pages: string[][], opts?: { flate?: boolean }): Uint8Array` (one `BT x y Td /F1 8 Tf <hex> Tj ET` per line, leading spaces turned into x offset), `samplePayslipLines(over?)`: synthetic SAP lines (values from the spec example).

- [ ] Tests: round-trips sample lines (trimmed right) uncompressed; `inflates FlateDecode streams`; literal `(…)` strings with escapes; windows-1252 `£` (0xA3); non-PDF throws "not a PDF"; PDF without text throws "no text … scanned".
- [ ] Implement, run tests, commit.

### Task 3: Payslip parser + validation + tax year

**Files:**
- Create: `src/lib/tax-year.ts`, `src/lib/model.ts`, `src/lib/payslip-parser.ts`, `src/lib/validate.ts`
- Test: `tax-year.test.ts`, `payslip-parser.test.ts`, `validate.test.ts`

**Interfaces:**
- `tax-year.ts`: `taxYearOf(isoDate: string): number`, `taxYearLabel(start: number): string` ("2026/27"), `parseTaxPeriod(s: string): { month: number; taxYear: number }`, `periodLabel(month: number): string` ("Oct"), `periodOfDate(isoDate): number`.
- `model.ts`: `Line`, `Ytd`, `Payslip` (spec fields), derived `ussSacrifice`, `grossBeforeSacrifice`, `incomeTax`, `employeeNi`, `studentLoan`, `otherDeductions` (each `(p: Payslip) => number`, round2).
- `payslip-parser.ts`: `parsePayslipLines(lines: string[]): Omit<Payslip, "warnings" | "importedAt">`; `class PayslipFormatError`.
- `validate.ts`: `validatePayslip(p): string[]`.
- `parsePayslipPdf(bytes): Promise<Payslip>` in `payslip-parser.ts` = extract + parse + validate.

- [ ] Tests: sample → payDate `2026-10-31`, taxYear 2026, period 7, taxCode `1257L 0`, payments `[Salary 3000, USS(CRB) 16 SS −183]`, deductions `[Tax paid 380, Employee NIC 150]`, totals, net 2287, YTD; `captures extra payment and student loan lines`; result JSON contains none of the redacted header values (use distinctive fake values `ZZNAME`, `QQ123456C`, `99999999`, `123/AB456`, `Faketown`); missing net pay throws PayslipFormatError; validation warns on each of the four mismatches and is empty on the sample.
- [ ] Implement, run tests, commit.

### Task 4: (folded into 3)

### Task 5: Storage

**Files:** Create `src/lib/store.ts`; Test `store.test.ts`

**Interfaces:**
- `loadPayslips(ctx, taxYear?: number): Promise<Payslip[]>` (all years when omitted, sorted by payDate), `savePayslips(ctx, list: Payslip[]): Promise<{ added: number; replaced: number }>`, `taxYears(ctx): Promise<number[]>`, `deletePayslip(ctx, payDate)`.
- `loadLinks(ctx, taxYear)`/`saveLink(ctx, payDate, link | null)` with `Link = { activityId; accountId; chosen: "auto" | "manual"; tagged?: boolean }`.
- `loadSettings(ctx): Promise<Settings>`, `saveSettings(ctx, s)`, defaults `{ windowDays: 4, payroll: { enabled: false } }`.
- `loadStatements`/`saveStatements` (cap 100, newest kept).
- Keys exactly: `payslips:<year>`, `payslips:index`, `links:<year>`, `uss-statements`, `settings`, `payroll-refused`.

- [ ] Tests: shards by tax year (a 5 April and 6 April payslip land in different keys); `replaces a payslip with the same pay date`; 30 years × 12 payslips stores fine and every value under the fake host's cap (`maxStoredValueBytes < 20_000`); statements capped at 100.
- [ ] Implement, run, commit.

### Task 6: Salary matching

**Files:** Create `src/lib/salary-match.ts`; Test `salary-match.test.ts`

**Interfaces:**
- `type MatchStatus = "matched" | "ambiguous" | "missing"`; `interface SalaryMatch { payDate; status; activity?: MoveRow; candidates: MoveRow[]; chosen?: "auto" | "manual" }`.
- `matchSalaries(payslips: Payslip[], rows: MoveRow[], windowDays: number, links: Record<string, Link>): SalaryMatch[]` (pure; uses kit `matchNearest`).
- `defaultAccountIds(accounts: Account[]): string[]` — active, non-archived, `accountType === "CASH"`, currency GBP.
- `loadCandidateRows(ctx, accountIds): Promise<MoveRow[]>` — `activities.getAll` per account, DEPOSIT/TRANSFER_IN in GBP.
- `tagDeposit(ctx, row: MoveRow, payDate): Promise<void>` — `saveMany({updates:[{…, comment: withSourceRef(comment, \`payslip:${payDate}\`)}]})`, throws on errors.

- [ ] Tests: matched within window ±0.01; outside window → missing; two deposits equally near → ambiguous with both candidates; `same net pay in consecutive months matches each month`; manual link wins; stale manual link (row gone) falls back to auto; on fake host: loadCandidateRows + tagDeposit writes `[ref:payslip:2026-10-31]`.
- [ ] Implement, run, commit.

### Task 7: Payroll ledger

**Files:** Create `src/lib/payroll.ts`; Test `payroll.test.ts`

**Interfaces:**
- `PAYROLL_PROVIDER = "payslips-addon"`.
- `planPayroll(p: Payslip, accountId: string): ActivityImport[]` — ids `payslip:<payDate>:<n>` and comments via `withSourceRef(text, id)`; signed sum (DEPOSIT +, others −) = 0.
- `findPayrollAccount(accounts)`, `ensurePayrollAccount(ctx): Promise<Account>`.
- `recordPayroll(ctx, payslips: Payslip[], matches: SalaryMatch[]): Promise<{ stored: number; unsaved: UnsavedRow[]; linked: number; linkFailed: string[]; skipped: string[] }>` — skips payslips with warnings; refused-rows store `payroll-refused`; links each matched payslip's stored TRANSFER_OUT (found by `sourceRefOf`) with its deposit via `convertAndLinkMoves`.

- [ ] Tests: plan for sample (5 rows, types, amounts, sum 0); student loan → WITHDRAWAL; record on fake host stores rows, converts the deposit to TRANSFER_IN and links it; `recording twice adds nothing`; host validation refusing a row → unsaved + in refused store, retried next run; payslip with warnings skipped.
- [ ] Implement, run, commit.

### Task 8: USS

**Files:** Create `src/lib/uss.ts`; Test `uss.test.ts`

**Interfaces:**
- `UssStatement = { date; dbPension; dbLumpSum; dcPot?; employerContribution? }` (in `model.ts`).
- `ussContributions(payslips): { byYear: { taxYear; amount }[]; total: number }`; `latestStatement(list)`; `dbCapitalEstimate(s): number` (= dbPension × 20 + dbLumpSum).

- [ ] Tests for each; implement; commit.

### Task 9: Pages, manifest, README, bump

**Files:** `src/pages/{payslips-page,tax-page,pension-page,settings-page}.tsx`, `src/components/*.tsx` as needed, `src/addon.tsx`, `manifest.json`, `README.md`, root `README.md` table, `CLAUDE.md` untouched.

- [ ] Pages per spec; a smoke render test (`pages.test.tsx`) for each page on the fake host with a payslip stored.
- [ ] `pnpm bump payslips minor`; `pnpm check`; commit; push; PR.
