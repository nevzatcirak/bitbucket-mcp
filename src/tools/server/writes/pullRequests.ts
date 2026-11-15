/**
 * Pull-request lifecycle write tools (create, update, merge-ability, merge,
 * decline, reopen) for both providers.
 *
 * Server/DC: optimistic-lock `version` on every mutation (one retry on 409).
 * Cloud: no version — partial PUTs (last write wins); reopen has no Cloud
 * equivalent (reopenPullRequest stays Server/DC-only); merge strategy ids are
 * translated (merge-commit→merge_commit, fast-forward→fast_forward); merge
 * veto analysis derives from PR state + the conflicts pre-check.
 *
 * Structured error mapping: 409 → CONFLICT, 403 → AUTH_FAILED (permission),
 * 404 → NOT_FOUND — handled centrally by RestClient.errorCodeForStatus.
 */

import { z } from "zod";
import { asRecord, asString } from "../../../core/json.js";
import { defineCardFields, projectCard } from "../../../core/compactCard.js";
import type { ToolCallContext, ToolManifest } from "../../registry.js";
import { RestError } from "../../../core/restClient.js";
import { withOptimisticLock } from "../../../core/optimisticLock.js";
import { epochToIso } from "../common.js";
import { prCard as buildPrCard } from "../pullRequests.js";
import {
  canMergePullRequestCloud,
  createPullRequestCloud,
  declinePullRequestCloud,
  mergePullRequestCloud,
  updatePullRequestCloud,
} from "../../cloud/writes.js";

const PROJECT_FIELD = z.string().min(1).max(128).describe("Project key (target repository; on Cloud: workspace slug).");
const REPO_FIELD = z.string().min(1).max(128).describe("Target repository slug.");
const PR_ID_FIELD = z.number().int().min(1).describe("Pull request id.");

function prBase(args: Record<string, unknown>): string {
  return `/rest/api/1.0/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/pull-requests`;
}

function prPath(args: Record<string, unknown>): string {
  return `${prBase(args)}/${args["pullRequestId"] as number}`;
}

async function fetchPr(ctx: ToolCallContext, args: Record<string, unknown>): Promise<Record<string, unknown> & { version: number }> {
  const pr = await ctx.provider.client.get<unknown>(prPath(args));
  const record = asRecord(pr);
  if (!record || typeof record.version !== "number") {
    throw new RestError(500, "UPSTREAM_ERROR", "Pull request payload is missing a version field; refusing a blind write.");
  }
  return record as Record<string, unknown> & { version: number };
}

const createPullRequest: ToolManifest = {
  name: "bb_create_pull_request",
  title: "Create pull request",
  description:
    "Open a pull request. Supports forks via fromProjectKey/fromRepositorySlug. Tries the required-reviewers service first to pre-fill reviewers; if it is unavailable (400/404) the tool proceeds and notes that reviewers must be added manually.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    title: z.string().min(1).max(255).describe("Pull request title."),
    description: z.string().max(32_000).optional().describe("Pull request description (markdown)."),
    fromBranch: z.string().min(1).max(256).describe("Source branch name (without refs/heads/)."),
    toBranch: z.string().min(1).max(256).describe("Target branch name (without refs/heads/)."),
    fromProjectKey: z.string().min(1).max(128).optional().describe("Source project key for fork PRs (default: projectKey)."),
    fromRepositorySlug: z.string().min(1).max(128).optional().describe("Source repository slug for fork PRs (default: repositorySlug)."),
    reviewers: z.array(z.string().min(1).max(128)).max(50).optional().describe("Explicit reviewer usernames (on Cloud: usernames or '{uuid}' strings); overrides the required-reviewers service (Server/DC)."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return createPullRequestCloud(args, ctx);
    const toProject = args["projectKey"] as string;
    const toRepo = args["repositorySlug"] as string;
    const fromProject = (args["fromProjectKey"] as string | undefined) ?? toProject;
    const fromRepo = (args["fromRepositorySlug"] as string | undefined) ?? toRepo;

    let reviewers: Record<string, unknown>[] = [];
    let reviewerNote: string | undefined;
    const explicit = args["reviewers"] as string[] | undefined;
    if (explicit && explicit.length > 0) {
      reviewers = explicit.map((name) => ({ user: { name } }));
    } else {
      try {
        const payload = await ctx.provider.client.post<unknown>(
          `/rest/default-reviewers/1.0/projects/${toProject}/repos/${toRepo}/reviewers`,
          {
            body: {
              sourceRefId: `refs/heads/${args["fromBranch"] as string}`,
              targetRefId: `refs/heads/${args["toBranch"] as string}`,
            },
          },
        );
        const users = Array.isArray(payload) ? payload : [];
        reviewers = users.map((entry) => {
          const name = asString(asRecord(entry)?.name) ?? asString(asRecord(asRecord(entry)?.user)?.name);
          return { user: { name } };
        }).filter((r) => {
          const user = asRecord(r["user"]);
          return typeof user?.name === "string" && user.name.length > 0;
        });
      } catch (err) {
        if (err instanceof RestError && (err.status === 400 || err.status === 404)) {
          reviewerNote = "Required-reviewers service is not available on this instance — add reviewers manually after creation.";
        }
        // Any other failure: skip silently and continue without reviewers.
      }
    }

    const body: Record<string, unknown> = {
      title: args["title"] as string,
      description: (args["description"] as string | undefined) ?? "",
      state: "OPEN",
      open: true,
      closed: false,
      fromRef: { id: `refs/heads/${args["fromBranch"] as string}`, repository: { slug: fromRepo, project: { key: fromProject } } },
      toRef: { id: `refs/heads/${args["toBranch"] as string}`, repository: { slug: toRepo, project: { key: toProject } } },
      ...(reviewers && reviewers.length > 0 ? { reviewers } : {}),
    };
    const pr = await ctx.provider.client.post<unknown>(`${prBase(args)}`, { body });
    const card = buildPrCard(pr);
    if (reviewerNote) card["reviewerNote"] = reviewerNote;
    return card;
  },
};

const updatePullRequest: ToolManifest = {
  name: "bb_update_pull_request",
  title: "Update pull request",
  description:
    "Update title, description or target branch of a pull request. Server/DC uses optimistic locking (re-fetch + one retry on 409); Cloud has no version field and applies a single partial PUT.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    title: z.string().min(1).max(255).optional().describe("New title (omit to keep current)."),
    description: z.string().max(32_000).optional().describe("New description (omit to keep current)."),
    toBranch: z.string().min(1).max(256).optional().describe("Retarget to this branch (omit to keep current)."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return updatePullRequestCloud(args, ctx);
    const updated = await withOptimisticLock({
      fetchCurrent: () => fetchPr(ctx, args),
      apply: (current) => {
        const toRef = args["toBranch"]
          ? { id: `refs/heads/${args["toBranch"] as string}`, repository: current.toRef }
          : current.toRef;
        const body = {
          version: current.version,
          title: (args["title"] as string | undefined) ?? current.title,
          description: (args["description"] as string | undefined) ?? current.description ?? "",
          toRef,
        };
        return ctx.provider.client.put<unknown>(prPath(args), { body });
      },
    });
    return buildPrCard(updated, defineCardFields([
      ["id", "id"],
      ["title", "title", 120],
      ["state", "state"],
      ["version", "version"],
      ["author", "author.user.displayName"],
      ["fromBranch", "fromRef.displayId"],
      ["toBranch", "toRef.displayId"],
      ["project", "fromRef.repository.project.key"],
      ["repo", "fromRef.repository.slug"],
      ["updated", "updatedDate"],
    ]));
  },
};

const canMergePullRequest: ToolManifest = {
  name: "bb_can_merge_pull_request",
  title: "Check pull request mergeability",
  description:
    "Read-only merge veto analysis for a pull request: canMerge, conflicted flag and the list of vetoes with summary/detail messages. On Cloud the analysis derives from the PR state and the conflicts pre-check (no server-side veto API).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return canMergePullRequestCloud(args, ctx);
    const payload = await ctx.provider.client.get<unknown>(`${prPath(args)}/merge`);
    const record = asRecord(payload);
    const vetoes = (record?.vetoes as unknown[] | undefined)?.map((v) => {
      const veto = asRecord(v);
      return {
        summary: asString(veto?.summaryMessage) ?? "",
        detail: asString(veto?.detailedMessage) ?? null,
      };
    });
    return {
      pullRequestId: args["pullRequestId"],
      canMerge: record?.canMerge === true,
      conflicted: record?.conflicted === true,
      vetoes: vetoes ?? [],
    };
  },
};

const MERGE_STRATEGY = z
  .enum(["merge-commit", "squash", "fast-forward"])
  .optional()
  .describe("Merge strategy id (server default applies when omitted).");

const mergePullRequest: ToolManifest = {
  name: "bb_merge_pull_request",
  title: "Merge pull request",
  description:
    "Merge a pull request with optional message and strategy (merge-commit | squash | fast-forward; translated to Cloud ids merge_commit | squash | fast_forward). On 409 (Server/DC) the merge is NOT retried automatically — a new commit likely landed; re-run canMerge then merge again.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    message: z.string().max(32_000).optional().describe("Merge commit message."),
    strategy: MERGE_STRATEGY,
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return mergePullRequestCloud(args, ctx);
    const current = await fetchPr(ctx, args);
    const body: Record<string, unknown> = { version: current.version };
    if (args["message"]) body["message"] = args["message"] as string;
    if (args["strategy"]) body["strategy"] = { id: args["strategy"] as string };
    const merged = await ctx.provider.client.post<unknown>(`${prPath(args)}/merge`, { body });
    const card = projectCard(merged, defineCardFields([
      ["id", "id"],
      ["title", "title", 120],
      ["state", "state"],
      ["version", "version"],
      ["project", "fromRef.repository.project.key"],
      ["repo", "fromRef.repository.slug"],
    ]));
    card["mergedWith"] = args["strategy"] ?? "server-default";
    return card;
  },
};

const declinePullRequest: ToolManifest = {
  name: "bb_decline_pull_request",
  title: "Decline pull request",
  description:
    "Decline (reject) a pull request. Server/DC: optional message, version taken from the current payload. Cloud: decline accepts no message — post a comment if a reason should be recorded.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    message: z.string().max(32_000).optional().describe("Reason for declining (Server/DC only)."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return declinePullRequestCloud(args, ctx);
    const current = await fetchPr(ctx, args);
    const body: Record<string, unknown> = { version: current.version };
    if (args["message"]) body["message"] = args["message"] as string;
    const declined = await ctx.provider.client.post<unknown>(`${prPath(args)}/decline`, { body });
    const card = projectCard(declined, defineCardFields([
      ["id", "id"],
      ["state", "state"],
      ["version", "version"],
    ]));
    card["updated"] = epochToIso(card["updated"]);
    return card;
  },
};

const reopenPullRequest: ToolManifest = {
  name: "bb_reopen_pull_request",
  title: "Reopen pull request",
  description:
    "Reopen a declined pull request. Uses optimistic locking: re-fetches the current version and retries once on a 409 conflict.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
  },
  providers: ["server"],
  readOnly: false,
  handler: async (args, ctx) => {
    const reopened = await withOptimisticLock({
      fetchCurrent: () => fetchPr(ctx, args),
      apply: (current) =>
        ctx.provider.client.post<unknown>(`${prPath(args)}/reopen`, { body: { version: current.version } }),
    });
    return projectCard(reopened, defineCardFields([
      ["id", "id"],
      ["state", "state"],
      ["version", "version"],
    ]));
  },
};

export const pullRequestWriteToolManifests: ToolManifest[] = [
  createPullRequest,
  updatePullRequest,
  canMergePullRequest,
  mergePullRequest,
  declinePullRequest,
  reopenPullRequest,
];
