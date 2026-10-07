import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nextVersion, setVersion } from "./bump-version.mjs";
import { planReleases, readAddons } from "./release-plan.mjs";

const addons = [
  { addon: "monzo", version: "2.0.0", packageVersion: "2.0.0" },
  { addon: "revolut", version: "2.1.0", packageVersion: "2.1.0" },
];

test("push to main releases only add-ons whose tag is missing", () => {
  const plan = planReleases(addons, new Set(["monzo-v2.0.0", "revolut-v2.0.0"]));
  assert.deepEqual(plan, [{ addon: "revolut", version: "2.1.0", tag: "revolut-v2.1.0" }]);
  assert.deepEqual(planReleases(addons, new Set(["monzo-v2.0.0", "revolut-v2.1.0"])), []);
});

test("a requested tag must match its manifest", () => {
  assert.equal(planReleases(addons, new Set(), "monzo-v2.0.0").length, 1);
  assert.throws(() => planReleases(addons, new Set(), "monzo-v2.0.1"), /does not match/);
  assert.throws(() => planReleases(addons, new Set(), "nope-v1.0.0"), /No add-on/);
  assert.throws(() => planReleases(addons, new Set(), "monzo-2.0.0"), /not <addon>-v<semver>/);
});

test("refuses when manifest and package versions disagree", () => {
  const bad = [{ addon: "x", version: "1.0.0", packageVersion: "0.9.0" }];
  assert.throws(() => planReleases(bad, new Set()), /disagree/);
});

test("bump computes semver steps", () => {
  assert.equal(nextVersion("2.3.4", "patch"), "2.3.5");
  assert.equal(nextVersion("2.3.4", "minor"), "2.4.0");
  assert.equal(nextVersion("2.3.4", "major"), "3.0.0");
  assert.equal(nextVersion("2.3.4", "5.0.0"), "5.0.0");
  assert.throws(() => nextVersion("2.3.4", "huge"));
});

test("every add-on in the repo has matching versions", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const found = readAddons(root);
  assert.ok(found.length >= 3);
  assert.doesNotThrow(() => planReleases(found, new Set()));
});

test("setVersion keeps formatting", () => {
  const text = '{\n  "id": "x",\n  "version": "1.0.0",\n  "keywords": ["a", "b"]\n}\n';
  assert.equal(setVersion(text, "1.0.1"), text.replace("1.0.0", "1.0.1"));
});
