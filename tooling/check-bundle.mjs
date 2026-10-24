#!/usr/bin/env node
// Checks a built add-on bundle the way Wealthfolio's loader will treat it.
//
// The host (apps/frontend/src/addons/iframe/addon-module-rewriter.ts) runs es-module-lexer over
// every add-on module and rewrites each *dynamic* `import(` it reports to
// `globalThis.__wealthfolioImport(<path>, `. The lexer also reports a class method named `import`
// (`async import(t, n) { … }`) as one, so the rewrite turns the method definition into
// `async globalThis.__wealthfolioImport("…", t, n) { … }` — a syntax error: the add-on fails to
// load with "Unexpected token '.'" although the bundle itself is valid. Trading 212 2.6.0 shipped
// like that.
//
// This fails on any dynamic import the lexer reports (an add-on has no use for one: host-provided
// packages are static imports) and shows what the host's rewrite would produce. The lexer version
// is pinned in pnpm-workspace.yaml to the host's (apps/frontend/package.json); update them together.
//
//   node tooling/check-bundle.mjs [bundle.js …]   (default: ./dist/addon.js)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "es-module-lexer/js";

// The import types of es-module-lexer (its /js build does not export the enum).
const DYNAMIC = 2;
const DYNAMIC_SOURCE_PHASE = 5;
const DYNAMIC_DEFER_PHASE = 7;

/** The syntax error `node --check` finds in ES module `code`, or null when it parses. */
export function syntaxError(code) {
  const dir = mkdtempSync(path.join(tmpdir(), "check-bundle-"));
  const file = path.join(dir, "bundle.mjs");
  try {
    writeFileSync(file, code);
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return null;
  } catch (e) {
    const text = String(e.stderr ?? e.message);
    return (text.split("\n").find((l) => /Error/.test(l)) ?? text).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the host's rewriter does to the dynamic imports it finds (its edit for them, nothing else). */
export function hostRewrite(code, imports, importerPath = "addon.js") {
  return imports
    .filter((i) => i.t === DYNAMIC)
    .sort((a, b) => b.ss - a.ss)
    .reduce(
      (out, i) =>
        `${out.slice(0, i.ss)}globalThis.__wealthfolioImport(${JSON.stringify(importerPath)}, ${out.slice(i.d + 1)}`,
      code,
    );
}

const lineOf = (code, offset) => code.slice(0, offset).split("\n").length;
const snippet = (code, offset) => code.slice(code.lastIndexOf("\n", offset - 1) + 1, code.indexOf("\n", offset)).trim().slice(0, 100);

/** The problems the host's loader would have with `code` (an empty list when it is fine). */
export async function checkBundle(code, name = "addon.js") {
  const problems = [];
  let imports;
  try {
    [imports] = parse(code, name);
  } catch (e) {
    return [`${name}: es-module-lexer cannot parse it (${e.message}), so the host cannot load it`];
  }
  const original = syntaxError(code);
  if (original) problems.push(`${name}: not valid JavaScript (${original})`);
  const dynamic = imports.filter((i) => i.t === DYNAMIC);
  if (dynamic.length > 0) {
    const rewritten = syntaxError(hostRewrite(code, imports, name));
    for (const i of dynamic) {
      problems.push(
        `${name}:${lineOf(code, i.ss)}: es-module-lexer reports a dynamic import(): \`${snippet(code, i.ss)}\`. ` +
          `The host rewrites it to globalThis.__wealthfolioImport(…, — never name a class method \`import\` (use importRows, …)`,
      );
    }
    if (rewritten && !original) problems.push(`${name}: after the host's rewrite it is not valid JavaScript (${rewritten})`);
  }
  for (const i of imports.filter((x) => x.t === DYNAMIC_SOURCE_PHASE || x.t === DYNAMIC_DEFER_PHASE)) {
    problems.push(`${name}:${lineOf(code, i.ss)}: import.source()/import.defer() is unsupported by the host loader`);
  }
  return problems;
}

/** Reads and checks a bundle file. */
export async function checkBundleFile(file) {
  return checkBundle(readFileSync(file, "utf8"), path.basename(file));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : [path.join(process.cwd(), "dist", "addon.js")];
  let failed = false;
  for (const file of files) {
    const problems = await checkBundleFile(file);
    for (const p of problems) console.error(`${file}: ${p}`);
    if (problems.length > 0) failed = true;
    else console.log(`${file}: loads under the host's module rewriter`);
  }
  process.exit(failed ? 1 : 0);
}
