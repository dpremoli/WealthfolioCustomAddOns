import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

describe("copyText", () => {
  it("uses the async clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(await copyText("hello")).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("selects the field when the clipboard is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const input = document.createElement("input");
    input.value = "https://auth.monzo.com/?x=1";
    document.body.appendChild(input);
    const select = vi.spyOn(input, "select");
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyText(input.value, input)).toBe("selected");
    expect(select).toHaveBeenCalled();
  });
});
