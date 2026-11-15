#!/usr/bin/env node
/**
 * Live smoke test against a real Bitbucket Server / DC instance.
 * Reads .env (BITBUCKET_URL, BITBUCKET_TOKEN, ...), then exercises:
 *   bb_get_projects → bb_get_repositories → bb_list_pull_requests → bb_get_pull_request_diff
 * Prints compact summaries only — never raw payloads or secrets.
 *
 * Usage: npm run build && node scripts/smoke.mjs
 */

import { readFileSync } from "node:fs";

function loadDotEnv() {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env) || !process.env[key]) process.env[key] = value;
    }
  } catch {
    console.error("note: no .env file found; relying on process env");
  }
}

const { loadConfig } = await import("../dist/core/config.js");
const { createServerProvider } = await import("../dist/providers/server/serverProvider.js");
const { toolManifests } = await import("../dist/tools/registry.js");

loadDotEnv();

const { config } = loadConfig();
if (!config.url || !(config.token || (config.username && config.password))) {
  console.error("smoke: incomplete configuration — set BITBUCKET_URL and BITBUCKET_TOKEN (or credentials).");
  process.exit(1);
}

console.log(`target: <host-redacted> (provider=${config.provider}, readOnly=${config.readOnly})`);

const ctx = { config, provider: createServerProvider(config) };

function manifest(name) {
  const m = toolManifests.find((t) => t.name === name);
  if (!m) throw new Error(`tool not found: ${name}`);
  return m;
}

async function call(name, args) {
  const result = await manifest(name).handler(args ?? {}, ctx);
  if (result && result.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result;
}

const summary = [];
try {
  // 1. Projects
  const projects = await call("bb_get_projects", { limit: 5, start: 0 });
  summary.push(`projects: ${projects.items.length} card(s), isLastPage=${projects.page.isLastPage}`);
  const project = projects.items[0];
  console.log(`  projects: ${projects.items.map((p) => `${p.key} ("${p.name}")`).join(", ")}`);
  if (!project) throw new Error("no projects visible to this token");

  // 2. Repositories
  const repos = await call("bb_get_repositories", { projectKey: project.key, limit: 10, start: 0 });
  summary.push(`repositories[${project.key}]: ${repos.items.length}, isLastPage=${repos.page.isLastPage}`);
  console.log(`  repositories: ${repos.items.map((r) => r.slug).join(", ")}`);
  const repo = repos.items.find((r) => r.slug) ?? repos.items[0];
  if (!repo) throw new Error("no repositories in first project");

  // 3. Pull requests
  const prs = await call("bb_list_pull_requests", {
    projectKey: project.key,
    repositorySlug: repo.slug,
    state: "OPEN",
    direction: "INCOMING",
    limit: 10,
    start: 0,
  });
  summary.push(`pullRequests[${project.key}/${repo.slug}]: ${prs.items.length} OPEN, isLastPage=${prs.page.isLastPage}`);
  console.log(`  pull requests: ${prs.items.map((p) => `#${p.id} "${p.title}"`).join(", ") || "(none)"}`);

  // 4. Diff (falls back to changes when no PR exists)
  if (prs.items.length > 0) {
    const diff = await call("bb_get_pull_request_diff", {
      projectKey: project.key,
      repositorySlug: repo.slug,
      pullRequestId: prs.items[0].id,
      maxCharsPerFile: 800,
    });
    const files = diff.files ?? [];
    summary.push(`diff[PR#${prs.items[0].id}]: ${files.length} file(s), truncated=${diff.truncated}`);
    for (const f of files.slice(0, 5)) {
      console.log(
        `    ${f.destination ?? f.source}: +${f.addedLines}/-${f.removedLines}` +
          `${f.truncated ? ` [truncated, ${f.omittedLines} omitted]` : ""}`,
      );
    }
  } else {
    const changes = await call("bb_get_pull_request_changes", {
      projectKey: project.key,
      repositorySlug: repo.slug,
      pullRequestId: 1,
      limit: 5,
      start: 0,
    }).catch(() => null);
    summary.push("diff: skipped (no open pull requests on first repo)");
    void changes;
  }

  console.log("\n=== SMOKE SUMMARY ===");
  for (const line of summary) console.log(" -", line);
} catch (err) {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  console.log("\n=== SMOKE SUMMARY (partial) ===");
  for (const line of summary) console.log(" -", line);
  process.exitCode = 1;
}
