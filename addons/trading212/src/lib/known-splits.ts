/**
 * Splits that Trading 212 applies to a position without writing a row to its history export, so
 * the shares the add-on imports are short by the split (0.108245 Amazon shares bought before the
 * 20:1 split show as 0.108245 instead of 2.1649).
 *
 * The add-on finds that a split is missing from the difference between Trading 212's position and
 * the quantity the imported trades add up to; it cannot tell the *date* from anything it has:
 * Wealthfolio's stored prices are split-adjusted, so there is no price jump to find it from. These
 * entries supply the date, keyed by ISIN (the same security on every exchange). A split is added
 * only when applying the entries for a position's ISIN reproduces Trading 212's quantity exactly
 * (see `proposeSplits`), so a missing or wrong entry can leave a position wrong but never invents
 * a split. Add an entry (date = the first day trading at the new price) to cover another security.
 */
export interface KnownSplit {
  isin: string;
  /** First trading day at the new price (YYYY-MM-DD). */
  date: string;
  /** New shares per old share: 20 for a 20:1 split, 0.1 for a 1:10 reverse split. */
  ratio: number;
  name: string;
}

export const KNOWN_SPLITS: KnownSplit[] = [
  { isin: "US0231351067", date: "2022-06-06", ratio: 20, name: "Amazon" },
  { isin: "US02079K3059", date: "2022-07-18", ratio: 20, name: "Alphabet Class A" },
  { isin: "US02079K1079", date: "2022-07-18", ratio: 20, name: "Alphabet Class C" },
  { isin: "US67066G1040", date: "2021-07-20", ratio: 4, name: "NVIDIA" },
  { isin: "US67066G1040", date: "2024-06-10", ratio: 10, name: "NVIDIA" },
  { isin: "US9311421039", date: "2024-02-26", ratio: 3, name: "Walmart" },
  { isin: "US8243481061", date: "2021-04-01", ratio: 3, name: "Sherwin-Williams" },
  { isin: "US0378331005", date: "2020-08-31", ratio: 4, name: "Apple" },
  { isin: "US88160R1014", date: "2020-08-31", ratio: 5, name: "Tesla" },
  { isin: "US88160R1014", date: "2022-08-25", ratio: 3, name: "Tesla" },
  { isin: "US11135F1012", date: "2024-07-15", ratio: 10, name: "Broadcom" },
  { isin: "US1696561059", date: "2024-06-26", ratio: 50, name: "Chipotle" },
];
