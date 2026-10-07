import { appendStep, markLastDone, type SyncStep } from "./sync-steps";

describe("appendStep", () => {
  it("coalesces duplicates and marks earlier steps done", () => {
    let steps: SyncStep<"fetch" | "import">[] = appendStep([], { phase: "fetch", message: "Fetching", current: 1, total: 3 });
    steps = appendStep(steps, { phase: "fetch", message: "Fetching", current: 2, total: 3 });
    expect(steps).toHaveLength(1);
    expect(steps[0].current).toBe(2);
    steps = appendStep(steps, { phase: "import", message: "Importing" });
    expect(steps.map((s) => s.status)).toEqual(["done", "active"]);
    expect(markLastDone(steps).map((s) => s.status)).toEqual(["done", "done"]);
  });
});
