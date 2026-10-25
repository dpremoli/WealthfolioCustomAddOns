import { describe, expect, it } from "vitest";
import { majorCurrency } from "./money";

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
