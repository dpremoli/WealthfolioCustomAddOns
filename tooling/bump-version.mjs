#!/usr/bin/env node
// Bumps an add-on's version in manifest.json and package.json together.
//
//   pnpm bump <addon> <major|minor|patch|x.y.z>
//
// Merging the bump to main is what releases it (see release-plan.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function nextVersion(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) throw new Error(`Cannot bump non-semver version "${current}"`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Bump must be major, minor, patch or x.y.z (got "${how}")`);
}

/** Replaces the first `"version": "…"` (the top-level one in these files). */
export function setVersion(jsonText, version) {
  const out = jsonText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(out).version !== version) throw new Error("Could not update version");
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [addon, how] = process.argv.slice(2);
  if (!addon || !how) {
    console.error("Usage: pnpm bump <addon> <major|minor|patch|x.y.z>");
    process.exit(1);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = ["manifest.json", "package.json"].map((f) => path.join(root, "addons", addon, f));
  const texts = files.map((f) => readFileSync(f, "utf8"));
  const [manifestVersion, packageVersion] = texts.map((t) => JSON.parse(t).version);
  if (manifestVersion !== packageVersion) {
    console.error(`manifest.json ${manifestVersion} and package.json ${packageVersion} disagree; fix first`);
    process.exit(1);
  }
  const version = nextVersion(manifestVersion, how);
  // Rewrite only the top-level version string so the files keep their formatting.
  texts.forEach((text, i) => writeFileSync(files[i], setVersion(text, version)));
  console.log(`${addon} → ${version}. Merge to main to release ${addon}-v${version}.`);
}
