#!/usr/bin/env node
// Zips a built add-on into dist/<id>-<version>.zip: manifest.json, dist/addon.js
// (+ any emitted CSS), README.md and packaged assets/ when present. Refuses to
// package when manifest.json and package.json disagree on the version.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(cwd, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));

if (manifest.version !== pkg.version) {
  console.error(
    `Version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`,
  );
  process.exit(1);
}
if (!existsSync(path.join(cwd, "dist", "addon.js"))) {
  console.error("dist/addon.js missing — run the build first");
  process.exit(1);
}

const files = ["manifest.json", "README.md"].filter((f) => existsSync(path.join(cwd, f)));
for (const f of readdirSync(path.join(cwd, "dist"))) {
  if (f === "addon.js" || f.endsWith(".css")) files.push(`dist/${f}`);
}
if (existsSync(path.join(cwd, "assets"))) files.push("assets");

const out = `dist/${manifest.id}-${manifest.version}.zip`;
execFileSync("zip", ["-qr", out, ...files], { cwd, stdio: "inherit" });
console.log(`Packaged ${out}`);
