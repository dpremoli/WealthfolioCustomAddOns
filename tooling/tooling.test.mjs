import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nextVersion, setVersion } from "./bump-version.mjs";
import { checkBundle, hostRewrite, syntaxError } from "./check-bundle.mjs";
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

// --- the host's loader: es-module-lexer reports some syntax as a dynamic import() ------------

const METHOD = "export class ActivityImporter {\n  async import(t, n) {\n    return t;\n  }\n}\n";

test("a class method named import is flagged: the host's rewrite makes it a syntax error", async () => {
  assert.equal(syntaxError(METHOD), null, "the bundle itself is valid JavaScript");
  const problems = await checkBundle(METHOD, "addon.js");
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems[0], /addon\.js:2: es-module-lexer reports a dynamic import\(\): `async import\(t, n\) \{`/);
  assert.match(problems[1], /after the host's rewrite it is not valid JavaScript \(SyntaxError: Unexpected token '\.'\)/);
});

test("the host's rewrite of that method is exactly the broken code from the bug report", async () => {
  const { parse } = await import("es-module-lexer/js");
  const [imports] = parse(METHOD);
  assert.equal(imports.filter((i) => i.t === 2).length, 1);
  assert.match(hostRewrite(METHOD, imports, "addon.js"), /async globalThis\.__wealthfolioImport\("addon\.js", t, n\) \{/);
});

test("a real dynamic import is flagged too", async () => {
  const problems = await checkBundle('export const load = () => import("./chunk.js");\n');
  assert.match(problems[0], /addon\.js:1: es-module-lexer reports a dynamic import\(\)/);
});

test("renamed methods, member calls and the like are fine", async () => {
  const fine = [
    "class A { async importRows(t) { return t; } }",
    "const r = await ctx.api.activities.import(rows);",
    "const o = { import(x) { return x; }, async import2(x) { return x; } };",
    "class B { static import(t) { return t; } }",
    'const s = "import(x)"; // import(y)',
    'import { useState } from "react";\nexport { useState };',
  ].join("\n");
  assert.deepEqual(await checkBundle(fine), []);
});

test("a bundle that is not valid JavaScript is reported", async () => {
  const problems = await checkBundle("export const = ;");
  assert.ok(problems.length > 0);
});

test("every built add-on bundle loads under the host's rewriter (when built)", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const addon of readAddons(root)) {
    const file = path.join(root, "addons", addon.addon, "dist", "addon.js");
    if (!existsSync(file)) continue; // `pnpm bundle` checks each one as it packages it
    const { checkBundleFile } = await import("./check-bundle.mjs");
    assert.deepEqual(await checkBundleFile(file), [], file);
  }
});
