import type { AddonContext } from "@wealthfolio/addon-sdk";
import { jsonStore } from "@wf-addons/kit";
import type { Link, Payslip, Settings, UssStatement } from "./model";
import { taxYearOf } from "./tax-year";

/**
 * Add-on storage. One value is capped at ~244 KB, so payslips and links are sharded by
 * tax year (`payslips/2026`, `links/2026`) and the statements list is capped.
 */
const INDEX_KEY = "payslips/index";
const STATEMENTS_KEY = "uss-statements";
const SETTINGS_KEY = "settings";
const MAX_STATEMENTS = 100;

const DEFAULT_SETTINGS: Settings = { windowDays: 4, payroll: { enabled: false } };

const store = (ctx: AddonContext) => jsonStore(ctx.api.storage);
const payslipKey = (taxYear: number) => `payslips/${taxYear}`;
const linkKey = (taxYear: number) => `links/${taxYear}`;
const byPayDate = (a: Payslip, b: Payslip) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : 0);

export async function taxYears(ctx: AddonContext): Promise<number[]> {
  return [...(await store(ctx).get<number[]>(INDEX_KEY, []))].sort((a, b) => a - b);
}

async function writeIndex(ctx: AddonContext, years: number[]): Promise<void> {
  const unique = [...new Set(years)].sort((a, b) => a - b);
  if (unique.length === 0) await store(ctx).delete(INDEX_KEY);
  else await store(ctx).set(INDEX_KEY, unique);
}

export async function loadPayslips(ctx: AddonContext, taxYear?: number): Promise<Payslip[]> {
  const years = taxYear === undefined ? await taxYears(ctx) : [taxYear];
  const lists = await Promise.all(years.map((y) => store(ctx).get<Payslip[]>(payslipKey(y), [])));
  return lists.flat().sort(byPayDate);
}

/** Stores payslips in the shard of their `taxYear`; the same pay date replaces the stored payslip. */
export async function savePayslips(ctx: AddonContext, list: Payslip[]): Promise<{ added: number; replaced: number }> {
  const grouped = new Map<number, Payslip[]>();
  for (const p of list) grouped.set(p.taxYear, [...(grouped.get(p.taxYear) ?? []), p]);

  let added = 0;
  let replaced = 0;
  for (const [year, incoming] of grouped) {
    const byDate = new Map((await loadPayslips(ctx, year)).map((p) => [p.payDate, p]));
    for (const p of incoming) {
      if (byDate.has(p.payDate)) replaced++;
      else added++;
      byDate.set(p.payDate, p);
    }
    await store(ctx).set(payslipKey(year), [...byDate.values()].sort(byPayDate));
  }
  if (grouped.size > 0) await writeIndex(ctx, [...(await taxYears(ctx)), ...grouped.keys()]);
  return { added, replaced };
}

/** Removes a payslip and its link; an emptied year disappears from the index and storage. */
export async function deletePayslip(ctx: AddonContext, payDate: string): Promise<void> {
  const years = await taxYears(ctx);
  for (const y of years) {
    const list = await loadPayslips(ctx, y);
    if (!list.some((p) => p.payDate === payDate)) continue;
    const rest = list.filter((p) => p.payDate !== payDate);
    if (rest.length > 0) await store(ctx).set(payslipKey(y), rest);
    else {
      await store(ctx).delete(payslipKey(y));
      await writeIndex(ctx, years.filter((x) => x !== y));
    }
    break;
  }
  await saveLink(ctx, payDate, null);
}

/** All years merged means the years that have payslips (the index): a link only matters for a stored payslip. */
export async function loadLinks(ctx: AddonContext, taxYear?: number): Promise<Record<string, Link>> {
  if (taxYear !== undefined) return store(ctx).get<Record<string, Link>>(linkKey(taxYear), {});
  const merged: Record<string, Link> = {};
  for (const y of await taxYears(ctx)) Object.assign(merged, await loadLinks(ctx, y));
  return merged;
}

/** Sets (or, with null, removes) the link of a payslip; links live in the tax year of the pay date. */
export async function saveLink(ctx: AddonContext, payDate: string, link: Link | null): Promise<void> {
  const taxYear = taxYearOf(payDate);
  const links = await loadLinks(ctx, taxYear);
  if (link) links[payDate] = link;
  else delete links[payDate];
  if (Object.keys(links).length === 0) await store(ctx).delete(linkKey(taxYear));
  else await store(ctx).set(linkKey(taxYear), links);
}

export async function loadSettings(ctx: AddonContext): Promise<Settings> {
  const saved = await store(ctx).get<Partial<Settings>>(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...saved, payroll: { ...DEFAULT_SETTINGS.payroll, ...saved.payroll } };
}

export function saveSettings(ctx: AddonContext, s: Settings): Promise<void> {
  return store(ctx).set(SETTINGS_KEY, s);
}

export function loadStatements(ctx: AddonContext): Promise<UssStatement[]> {
  return store(ctx).get<UssStatement[]>(STATEMENTS_KEY, []);
}

/** Sorted by date; only the newest 100 are kept. */
export async function saveStatements(ctx: AddonContext, list: UssStatement[]): Promise<void> {
  const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await store(ctx).set(STATEMENTS_KEY, sorted.slice(-MAX_STATEMENTS));
}

export async function addStatement(ctx: AddonContext, s: UssStatement): Promise<void> {
  const rest = (await loadStatements(ctx)).filter((x) => x.date !== s.date);
  await saveStatements(ctx, [...rest, s]);
}

export async function deleteStatement(ctx: AddonContext, date: string): Promise<void> {
  await saveStatements(ctx, (await loadStatements(ctx)).filter((x) => x.date !== date));
}
