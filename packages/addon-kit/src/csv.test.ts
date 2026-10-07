import { headerIndex, parseCsv, parseCsvRecords } from "./csv";

describe("parseCsv", () => {
  it("parses simple rows and trims nothing inside fields", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted commas, escaped quotes and embedded newlines", () => {
    const text = 'name,note\n"Tesco, Leeds","He said ""hi""\nthen left"\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Tesco, Leeds", 'He said "hi"\nthen left'],
    ]);
  });

  it("handles CRLF, a BOM, a missing trailing newline and blank lines", () => {
    expect(parseCsv("﻿a,b\r\n\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv("a,,c\n,,x")).toEqual([
      ["a", "", "c"],
      ["", "", "x"],
    ]);
  });
});

describe("headerIndex", () => {
  it("matches case- and whitespace-insensitively with aliases and fallback", () => {
    const at = headerIndex(["Completed  Date", "AMOUNT"]);
    expect(at("completed date", 9)).toBe(0);
    expect(at(["Value", "Amount"], 9)).toBe(1);
    expect(at("Missing", 7)).toBe(7);
  });
});

describe("parseCsvRecords", () => {
  it("keys rows by header", () => {
    expect(parseCsvRecords("A, B\n1, 2")).toEqual([{ A: "1", B: "2" }]);
  });
});
