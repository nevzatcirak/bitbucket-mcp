#!/usr/bin/env node
/**
 * Live write-tool probe for Phase 2 — runs the full write chain against the
 * user-designated scratch repository KAPI/kapi-authn ONLY (never merges,
 * never touches any other project or repository):
 *
 *   createBranch (fallback: existing non-default branch when branch-admin is
 *   unavailable) → createPullRequest → postPullRequestComment (normal +
 *   BLOCKER → task, pending draft) → updatePullRequestComment (edit + resolve)
 *   → submitPullRequestReview → canMergePullRequest (read-only) →
 *   updatePullRequest → decline → reopen → decline → deleteBranch (cleanup)
 *
 * Reads ../.env itself; never prints secrets or the host name.
 */
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
if (!m("bb_create_branch")) {
  console.error("write tools not found in the built registry — run: npm run build");
  process.exit(1);
}

const step = async (label, fn) => {
  try {
    const result = await fn();
    console.log(`OK  ${label}: ${JSON.stringify(result).slice(0, 300)}`);
    return result;
  } catch (err) {
    const code = err?.code ?? "?";
    console.log(`ERR ${label}: [${code}] ${String(err?.message ?? err).slice(0, 240)}`);
    return null;
  }
};

// 1. Fixed user-designated test repository.
const base = { projectKey: "KAPI", repositorySlug: "kapi-authn" };
console.log(`target: ${base.projectKey}/${base.repositorySlug} (host redacted)`);

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const branchName = `mcp-live-test-${stamp}`;

// 2. Branches: default + fallback source branch.
const branches = await m("bb_list_branches").handler({ ...base, limit: 50, start: 0 }, ctx);
if (!branches?.items?.length) { console.log("no branches visible — aborting"); process.exit(0); }
const defaultBranch = (branches.items.find((b) => b.isDefault) ?? branches.items[0]).displayId;
const otherBranch = branches.items.find((b) => !b.isDefault)?.displayId;
console.log(`default branch: ${defaultBranch}, other branch: ${otherBranch ?? "(none)"}`);

// 3. Branch creation (falls back to an existing non-default branch).
const created = await step(`createBranch ${branchName}`, () =>
  m("bb_create_branch").handler({ ...base, name: branchName, startPoint: defaultBranch }, ctx));
const fromBranch = created ? branchName : otherBranch;
if (!fromBranch) {
  console.log("branch creation failed and no existing non-default branch — cannot open a test PR, aborting chain");
  process.exit(0);
}
if (!created) console.log(`branch-admin unavailable on this instance — using existing branch '${fromBranch}' as PR source`);

// 4. PR + review chain.
const pr = await step("createPullRequest", () =>
  m("bb_create_pull_request").handler({
    ...base,
    title: `MCP live write verification ${stamp}`,
    description: "Automated probe of the bitbucket-mcp write tools. Safe to decline and delete.",
    fromBranch,
    toBranch: defaultBranch,
  }, ctx));

if (pr && pr.id) {
  const prId = pr.id;

  const normal = await step("postPullRequestComment (PR-level)", () =>
    m("bb_post_pull_request_comment").handler({ ...base, pullRequestId: prId, text: "Live probe comment — please ignore." }, ctx));

  if (normal?.id) {
    await step("updatePullRequestComment (edit)", () =>
      m("bb_update_pull_request_comment").handler({ ...base, pullRequestId: prId, commentId: normal.id, text: "Live probe comment — edited." }, ctx));
    await step("updatePullRequestComment (resolve thread)", () =>
      m("bb_update_pull_request_comment").handler({ ...base, pullRequestId: prId, commentId: normal.id, state: "RESOLVED" }, ctx));
  }

  await step("postPullRequestComment (BLOCKER -> task)", () =>
    m("bb_post_pull_request_comment").handler({
      ...base, pullRequestId: prId, text: "Live probe blocker.", severity: "BLOCKER",
      taskText: "Live probe follow-up task.", pending: false,
    }, ctx));

  await step("postPullRequestComment (pending draft)", () =>
    m("bb_post_pull_request_comment").handler({
      ...base, pullRequestId: prId, text: "Live probe draft.", pending: true,
    }, ctx));

  await step("submitPullRequestReview (NEEDS_WORK)", () =>
    m("bb_submit_pull_request_review").handler({ ...base, pullRequestId: prId, verdict: "NEEDS_WORK" }, ctx));

  await step("canMergePullRequest (read-only check)", () =>
    m("bb_can_merge_pull_request").handler({ ...base, pullRequestId: prId }, ctx));

  await step("updatePullRequest (retitle)", () =>
    m("bb_update_pull_request").handler({ ...base, pullRequestId: prId, title: `MCP live write verification ${stamp} (edited)` }, ctx));

  await step("declinePullRequest", () =>
    m("bb_decline_pull_request").handler({ ...base, pullRequestId: prId, message: "Live probe done - declining." }, ctx));

  await step("reopenPullRequest", () =>
    m("bb_reopen_pull_request").handler({ ...base, pullRequestId: prId }, ctx));

  await step("declinePullRequest (final)", () =>
    m("bb_decline_pull_request").handler({ ...base, pullRequestId: prId, message: "Live probe finished." }, ctx));
} else {
  console.log("PR creation failed (empty diff or permission) — comment/review chain skipped.");
}

// 5. Branch cleanup (only the branch this probe created).
if (created) {
  await step(`deleteBranch ${branchName} (cleanup)`, () =>
    m("bb_delete_branch").handler({ ...base, name: branchName }, ctx));
}

console.log("done.");
