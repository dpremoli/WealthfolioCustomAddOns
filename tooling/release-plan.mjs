#!/usr/bin/env node
// Decides which add-ons need a GitHub release.
//
// Every add-on is released under the tag `<dir>-v<manifest version>`. On a push to
// main, any add-on whose current tag doesn't exist yet is due — so bumping a version
// (see bump-version.mjs) and merging is all a release takes. On a tag push or a manual
// run naming a tag, only that add-on is released, after checking the tag matches its
// manifest.
//
// CLI: node tooling/release-plan.mjs [tag]  → prints a JSON array of
//      { addon, version, tag } and, under GitHub Actions, writes `matrix`/`count`
//      to $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_RE = /^(?<addon>[a-z0-9][a-z0-9-]*)-v(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

export function tagFor(addon, version) {
  return `${addon}-v${version}`;
}

/**
 * @param {{ addon: string, version: string, packageVersion?: string }[]} addons
 * @param {Set<string>} existingTags
 * @param {string} [requestedTag] a tag from a tag push or manual run; empty = all pending
 */
export function planReleases(addons, existingTags, requestedTag) {
  for (const a of addons) {
    if (a.packageVersion !== undefined && a.packageVersion !== a.version) {
      throw new Error(
        `${a.addon}: manifest.json ${a.version} and package.json ${a.packageVersion} disagree`,
      );
    }
  }
  if (requestedTag) {
    const m = TAG_RE.exec(requestedTag);
    if (!m) throw new Error(`Tag "${requestedTag}" is not <addon>-v<semver>`);
    const addon = addons.find((a) => a.addon === m.groups.addon);
    if (!addon) throw new Error(`No add-on at addons/${m.groups.addon}`);
    if (addon.version !== m.groups.version) {
      throw new Error(`Tag ${requestedTag} does not match manifest version ${addon.version}`);
    }
    return [{ addon: addon.addon, version: addon.version, tag: requestedTag }];
  }
  return addons
    .map((a) => ({ addon: a.addon, version: a.version, tag: tagFor(a.addon, a.version) }))
    .filter((r) => !existingTags.has(r.tag));
}

export function readAddons(root) {
  const dir = path.join(root, "addons");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "manifest.json")))
    .map((d) => {
      const read = (f) => JSON.parse(readFileSync(path.join(dir, d.name, f), "utf8"));
      return { addon: d.name, version: read("manifest.json").version, packageVersion: read("package.json").version };
    })
    .sort((a, b) => a.addon.localeCompare(b.addon));
}

function existingTags(root) {
  const out = execFileSync("git", ["tag", "--list"], { cwd: root, encoding: "utf8" });
  return new Set(out.split("\n").map((t) => t.trim()).filter(Boolean));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = planReleases(readAddons(root), existingTags(root), process.argv[2] || "");
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: plan })}\ncount=${plan.length}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = plan.length
      ? plan.map((r) => `- \`${r.tag}\``).join("\n")
      : "_Nothing — no add-on version was bumped._";
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Releases on merge to main\n\n${lines}\n`);
  }
}
