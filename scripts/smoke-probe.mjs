#!/usr/bin/env node
/** Ad-hoc live probe: scan projects for an OPEN pull request, then read it. */
import { readFileSync } from "node:fs";

function loadDotEnv() {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotEnv();

const { loadConfig } = await import("../dist/core/config.js");
const { createServerProvider } = await import("../dist/providers/server/serverProvider.js");
const { toolManifests } = await import("../dist/tools/registry.js");

const { config } = loadConfig();
const ctx = { config, provider: createServerProvider(config) };
const m = (name) => toolManifests.find((t) => t.name === name);
const call = async (name, args) => m(name).handler(args ?? {}, ctx);

const projects = await call("bb_get_projects", { limit: 25, start: 0 });
let found = null;
outer: for (const project of projects.items) {
  const repos = await call("bb_get_repositories", { projectKey: project.key, limit: 100, start: 0 });
  for (const repo of repos.items) {
    const prs = await call("bb_list_pull_requests", {
      projectKey: project.key, repositorySlug: repo.slug, state: "ALL", direction: "INCOMING", limit: 5, start: 0,
    });
    if (prs.items.length > 0) {
      found = { project: project.key, repo: repo.slug, prs: prs.items };
      break outer;
    }
  }
}
if (!found) { console.log("no pull requests found in scanned projects"); process.exit(0); }

console.log(`repo: ${found.project}/${found.repo}`);
for (const pr of found.prs) console.log(`  PR #${pr.id} [${pr.state}] "${pr.title}" by ${pr.author}`);

const pr = found.prs.find((p) => p.state === "OPEN") ?? found.prs[0];
const detail = await call("bb_get_pull_request", { projectKey: found.project, repositorySlug: found.repo, pullRequestId: pr.id });
console.log(`detail: #${detail.id} ${detail.fromBranch} -> ${detail.toBranch}, reviewers=${(detail.reviewers ?? []).length}, descChars=${String(detail.description ?? "").length}`);

const changes = await call("bb_get_pull_request_changes", { projectKey: found.project, repositorySlug: found.repo, pullRequestId: pr.id, limit: 10, start: 0 });
console.log(`changes: ${changes.items.length} file(s), isLastPage=${changes.page.isLastPage}`);
for (const c of changes.items.slice(0, 5)) console.log(`   ${c.changeType} ${c.path}`);

const diff = await call("bb_get_pull_request_diff", { projectKey: found.project, repositorySlug: found.repo, pullRequestId: pr.id, maxCharsPerFile: 600 });
console.log(`diff: ${diff.files.length} file(s), envelopeTruncated=${diff.truncated}`);
for (const f of diff.files.slice(0, 5)) {
  console.log(`   ${f.destination ?? f.source}: +${f.addedLines}/-${f.removedLines}${f.truncated ? ` [truncated, ${f.omittedLines} omitted, previewChars=${f.preview.length}]` : ` [previewChars=${f.preview.length}]`}`);
}

const comments = await call("bb_get_pr_comments_and_actions", { projectKey: found.project, repositorySlug: found.repo, pullRequestId: pr.id, limit: 100, start: 0 });
console.log(`comments: threads=${comments.summary.threads}, blockers=${comments.summary.blockers}, openTasks=${comments.summary.openTasks}, isLastPage=${comments.page.isLastPage}`);

const branches = await call("bb_list_branches", { projectKey: found.project, repositorySlug: found.repo, limit: 10, start: 0 });
const def = branches.items.find((b) => b.isDefault);
console.log(`branches: ${branches.items.length}, default=${def ? def.displayId : "(not in page)"}`);

const dash = await call("bb_get_dashboard_pull_requests", { role: "PARTICIPANT", state: "OPEN", limit: 5, start: 0 }).catch((e) => ({ error: e.message }));
console.log(`dashboard: ${dash.items ? `${dash.items.length} item(s), isLastPage=${dash.page.isLastPage}` : `ERROR: ${dash.error}`}`);
const inbox = await call("bb_get_inbox_pull_requests", { limit: 5, start: 0 }).catch((e) => ({ error: e.message }));
console.log(`inbox: ${inbox.items ? `${inbox.items.length} item(s), isLastPage=${inbox.page.isLastPage}` : `ERROR: ${inbox.error}`}`);
