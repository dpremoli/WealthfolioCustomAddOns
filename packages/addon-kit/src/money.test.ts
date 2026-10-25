import { describe, expect, it } from "vitest";
import { majorCurrency, minorUnit } from "./money";

describe("majorCurrency", () => {
  it("gives the major unit of the minor-unit currencies Wealthfolio converts, else the code", () => {
    expect(majorCurrency("GBX")).toBe("GBP");
    expect(majorCurrency("GBp")).toBe("GBP");
    expect(majorCurrency("ZAc")).toBe("ZAR");
    expect(majorCurrency("ILA")).toBe("ILS");
    expect(majorCurrency("KWF")).toBe("KWD");
    expect(majorCurrency("USD")).toBe("USD");
    expect(majorCurrency("GBP")).toBe("GBP");
  });
});

describe("minorUnit", () => {
  it("gives the major code and size of a minor unit, null for a major one", () => {
    expect(minorUnit("GBX")).toEqual({ major: "GBP", factor: 100 });
    expect(minorUnit("GBp")).toEqual({ major: "GBP", factor: 100 });
    expect(minorUnit("KWF")).toEqual({ major: "KWD", factor: 1000 });
    expect(minorUnit("GBP")).toBeNull();
    expect(minorUnit("EUR")).toBeNull();
  });
});
