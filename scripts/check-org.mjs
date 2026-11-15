#!/usr/bin/env node
/**
 * Guard used by CI: fails when forbidden organization references appear in
 * sources, docs, tests or workflows. Real organization names must never
 * appear in this repository.
 *
 * Note: this script never spells the forbidden terms out in the repo — the
 * pattern is assembled from fragments so the guard does not match itself.
 *
 * Usage: node scripts/check-org.mjs [paths...]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const F1 = "comp";
const F2 = "any";
const F3 = "corpor";
const F4 = "ate";
const F5 = "\u015firk";
const F6 = "et";
const F7 = "kur";
const F8 = "um";

const FORBIDDEN = [F1 + F2, F3 + F4, F5 + F6, F7 + F8];

const DEFAULT_TARGETS = [
  "src",
  "scripts",
  "test",
  "README.md",
  "LICENSE",
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "eslint.config.js",
  ".env.example",
  ".github/workflows",
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".idea"]);
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
  ".example", "", ".html", ".css", ".sh", ".txt", // "" covers extensionless files like LICENSE
]);

const args = process.argv.slice(2);
const targets = args.length > 0 ? args : DEFAULT_TARGETS;

const findings = [];

function collectFiles(target) {
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const entry of readdirSync(target)) {
      if (SKIP_DIRS.has(entry)) continue;
      collectFiles(join(target, entry));
    }
  } else {
    scanFile(target);
  }
}

function scanFile(file) {
  if (selfPathMatches(file)) return;
  if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) return;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return; // unreadable (binary or permission) — skip
  }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const term of FORBIDDEN) {
      if (line.toLowerCase().includes(term)) {
        findings.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
        break;
      }
    }
  });
}

function selfPathMatches(file) {
  const norm = file.split(sep).join("/");
  return norm.endsWith("scripts/check-org.mjs");
}

let missing = 0;
for (const target of targets) {
  try {
    collectFiles(target);
  } catch {
    missing += 1; // optional target that does not exist yet
  }
}

if (findings.length > 0) {
  console.error("Forbidden references found:\n" + findings.join("\n"));
  console.error("Remove these references — they must never appear in this repository.");
  process.exit(1);
}

if (missing > 0) {
  console.log(`OK: no forbidden references found (${missing} optional target(s) not present yet).`);
} else {
  console.log("OK: no forbidden references found.");
}
