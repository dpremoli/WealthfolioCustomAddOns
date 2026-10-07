import { describe, expect, it } from "vitest";
import { relativeTime } from "./format";

describe("relativeTime", () => {
  const now = new Date("2026-06-09T12:00:00.000Z");

  it("returns 'Never' for null/undefined/invalid", () => {
    expect(relativeTime(null, now)).toBe("Never");
    expect(relativeTime(undefined, now)).toBe("Never");
    expect(relativeTime("not-a-date", now)).toBe("Never");
  });

  it("formats recent, minutes, hours, days", () => {
    expect(relativeTime("2026-06-09T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-06-09T11:30:00.000Z", now)).toBe("30 mins ago");
    expect(relativeTime("2026-06-09T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(relativeTime("2026-06-07T12:00:00.000Z", now)).toBe("2 days ago");
  });
});
