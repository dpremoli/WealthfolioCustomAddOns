import { describe, expect, it } from "vitest";
import { parseMonzoCsv } from "./csv-parser";

const HEADER =
  "Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In";

describe("parseMonzoCsv", () => {
  it("parses a debit with a foreign-currency amount", () => {
    const [t] = parseMonzoCsv(
      [
        HEADER,
        'tx_1,05/03/2026,14:30:00,Card payment,Cafe,,Eating out,-12.50,GBP,-14.60,EUR,"lunch, with #tag",1 Rue X,,CAFE PARIS,,-12.50,',
      ].join("\n"),
    );
    expect(t).toMatchObject({
      id: "tx_1",
      created: "2026-03-05T14:30:00.000Z",
      amount: -1250,
      currency: "GBP",
      local_amount: -1460,
      local_currency: "EUR",
      notes: "lunch, with #tag",
      category: "eating_out",
      description: "CAFE PARIS",
      merchant: { name: "Cafe" },
    });
  });

  it("matches columns by header name, so a reordered export still parses", () => {
    const header = "Amount,Currency,Date,Time,Transaction ID,Category,Name,Description,Notes and #tags";
    const [t] = parseMonzoCsv([header, "100.00,GBP,01/02/2026,09:00:00,tx_9,Income,Employer,Salary,Feb pay"].join("\n"));
    expect(t).toMatchObject({
      id: "tx_9",
      amount: 10000,
      created: "2026-02-01T09:00:00.000Z",
      category: "income",
      description: "Salary",
      notes: "Feb pay",
    });
  });

  it("falls back to the historical column positions when headers are unrecognised", () => {
    const header = "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o";
    const row = "tx_2,10/01/2026,08:00:00,Card,Shop,,Shopping,-3.00,GBP,,,,,,Shop desc";
    const [t] = parseMonzoCsv([header, row].join("\n"));
    expect(t).toMatchObject({ id: "tx_2", amount: -300, category: "shopping", description: "Shop desc" });
  });

  it("drops rows without an id/date, with a zero amount or with an unparseable date", () => {
    const rows = [
      HEADER,
      ",05/03/2026,14:30:00,Card,X,,General,-1.00,GBP",
      "tx_a,05/03/2026,14:30:00,Card,X,,General,0.00,GBP",
      "tx_b,garbage,14:30:00,Card,X,,General,-1.00,GBP",
      "tx_c,05/03/2026,14:30:00,Card,X,,General,-1.00,GBP",
    ];
    expect(parseMonzoCsv(rows.join("\r\n")).map((t) => t.id)).toEqual(["tx_c"]);
  });

  it("returns [] for an empty file or header-only file", () => {
    expect(parseMonzoCsv("")).toEqual([]);
    expect(parseMonzoCsv(HEADER)).toEqual([]);
  });
});
