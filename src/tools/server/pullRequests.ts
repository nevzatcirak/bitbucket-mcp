/**
 * Server/DC pull-request read tools: listing, detail, changes, diffs and
 * build statuses. Author filtering on listPullRequests and listCommits is
 * applied client-side (the Server/DC REST API has no server-side author
 * parameter on these endpoints) — paging metadata reflects unfiltered pages.
 */

import { z } from "zod";
import { asRecord, asString, getPath, truncateString } from "../../core/json.js";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import type { ToolManifest } from "../registry.js";
import { RestError } from "../../core/restClient.js";
import { apiPath, epochToIso, listPage, pagedResult } from "./common.js";
import { projectDiffFile } from "./diffTruncate.js";

const LIMIT_FIELD = z.number().int().min(1).max(1000).default(25).describe("Page size (1-1000).");
const START_FIELD = z.number().int().min(0).default(0).describe("Zero-based page offset.");
const PROJECT_FIELD = z.string().min(1).max(128).describe("Project key, e.g. 'API'.");
const REPO_FIELD = z.string().min(1).max(128).describe("Repository slug, e.g. 'service-api'.");
const PR_ID_FIELD = z.number().int().min(1).describe("Pull request id, e.g. 101.");

const PR_FIELDS = defineCardFields([
  ["id", "id"],
  ["title", "title", 120],
  ["state", "state"],
  ["author", "author.user.displayName"],
  ["fromBranch", "fromRef.displayId"],
  ["toBranch", "toRef.displayId"],
  ["project", "fromRef.repository.project.key"],
  ["repo", "fromRef.repository.slug"],
  ["created", "createdDate"],
  ["updated", "updatedDate"],
]);

const prListFields = defineCardFields([
  ["id", "id"],
  ["title", "title", 120],
  ["state", "state"],
  ["author", "author.user.displayName"],
  ["fromBranch", "fromRef.displayId"],
  ["toBranch", "toRef.displayId"],
  ["project", "fromRef.repository.project.key"],
  ["repo", "fromRef.repository.slug"],
  ["updated", "updatedDate"],
]);

function prCard(pr: unknown, fields = prListFields): Record<string, unknown> {
  const card = projectCard(pr, fields);
  card["created"] = epochToIso(card["created"]);
  card["updated"] = epochToIso(card["updated"]);
  return card;
}

function prPath(args: Record<string, unknown>): string {
  return apiPath(
    `/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/pull-requests/${args["pullRequestId"] as number}`,
  );
}

function requireId(args: Record<string, unknown>): number {
  const id = args["pullRequestId"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new RestError(400, "VALIDATION", "pullRequestId must be a positive integer.");
  }
  return id;
}

const STATE_FIELD = z
  .enum(["OPEN", "MERGED", "DECLINED", "ALL"])
  .default("OPEN")
  .describe("Pull request state filter.");

const listPullRequests: ToolManifest = {
  name: "bb_list_pull_requests",
  title: "List pull requests",
  description:
    "List pull requests of a repository. Filter by state (OPEN|MERGED|DECLINED|ALL), direction (INCOMING|OUTGOING) and optionally by author (client-side match on username or display name — paging metadata reflects unfiltered pages).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    state: STATE_FIELD,
    direction: z
      .enum(["INCOMING", "OUTGOING"])
      .default("INCOMING")
      .describe("INCOMING: into this repository's branches; OUTGOING: from this repository's branches."),
    author: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Filter by author username or display name (case-insensitive, client-side)."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    const path = apiPath(
      `/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/pull-requests`,
    );
    const { items, page } = await listPage(ctx, path, args, {
      state: args["state"] as string,
      direction: args["direction"] as string,
    });
    const filtered = filterByAuthor(items, args["author"] as string | undefined);
    return pagedResult(filtered.map((pr) => prCard(pr)), page);
  },
};

function filterByAuthor(items: readonly unknown[], author: string | undefined): unknown[] {
  if (!author) return [...items];
  const needle = author.toLowerCase();
  return items.filter((pr) => {
    const name = asString(getPath(pr, "author.user.name"))?.toLowerCase();
    const displayName = asString(getPath(pr, "author.user.displayName"))?.toLowerCase();
    return name === needle || name?.includes(needle) === true || displayName?.includes(needle) === true;
  });
}

const getPullRequest: ToolManifest = {
  name: "bb_get_pull_request",
  title: "Get pull request",
  description:
    "Fetch one pull request with description (truncated), branch pair, reviewers and their decisions as a compact card.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    maxDescriptionChars: z.number().int().min(0).max(10_000).default(600).describe("Maximum description characters."),
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    requireId(args);
    const pr = await ctx.provider.client.get<unknown>(prPath(args));
    const card = prCard(pr, PR_FIELDS);
    card["description"] = truncateString(asString(asRecord(pr)?.description) ?? "", args["maxDescriptionChars"] as number);
    const reviewers = (asRecord(pr)?.reviewers as unknown[] | undefined) ?? [];
    card["reviewers"] = reviewers.map((r) => {
      const record = asRecord(r);
      return {
        name: asString(asRecord(record?.user)?.displayName),
        username: asString(asRecord(record?.user)?.name),
        status: asString(record?.status),
        approved: record?.approved === true,
      };
    });
    return card;
  },
};

const getPullRequestChanges: ToolManifest = {
  name: "bb_get_pull_request_changes",
  title: "List pull request changes",
  description: "List the file-level changes of a pull request (added/modified/deleted paths).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    limit: LIMIT_FIELD,
    start: START_FIELD,
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    requireId(args);
    const { items, page } = await listPage(ctx, `${prPath(args)}/changes`, args);
    const cards = items.map((item) => {
      const record = asRecord(item);
      return {
        path: asString(asRecord(record?.path)?.toString) ?? "",
        changeType: asString(record?.type) ?? "MODIFY",
      };
    });
    return pagedResult(cards, page);
  },
};

const getPullRequestDiff: ToolManifest = {
  name: "bb_get_pull_request_diff",
  title: "Get pull request diff",
  description:
    "Fetch the diff of a pull request (optionally for one file). Each file is compacted with smart truncation: head 60% + tail 40% of the preview budget, plus added/removed line counts and omission statistics.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    path: z.string().min(1).max(1024).optional().describe("Limit the diff to this file path."),
    maxCharsPerFile: z
      .number()
      .int()
      .min(200)
      .max(20_000)
      .default(1200)
      .describe("Preview budget per file (head 60% / tail 40% on truncation)."),
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    requireId(args);
    const filePath = args["path"] as string | undefined;
    const suffix = filePath ? `/${filePath.replace(/^\/+/, "")}` : "";
    const payload = await ctx.provider.client.get<unknown>(`${prPath(args)}/diff${suffix}`, {
      query: { withComments: false },
    });
    const diffs = (asRecord(payload)?.diffs as unknown[] | undefined) ?? [];
    const maxChars = args["maxCharsPerFile"] as number;
    const files = diffs.map((diff) => projectDiffFile(diff, maxChars));
    return { pullRequestId: args["pullRequestId"], files, truncated: asRecord(payload)?.truncated === true };
  },
};

const getPullRequestBuilds: ToolManifest = {
  name: "bb_get_pull_request_builds",
  title: "Get pull request build statuses",
  description:
    "Fetch the CI build statuses attached to the pull request's source-branch head commit (build-state integration).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    limit: LIMIT_FIELD,
    start: START_FIELD,
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    requireId(args);
    const pr = await ctx.provider.client.get<unknown>(prPath(args));
    const commitId = asString(asRecord(asRecord(pr)?.fromRef)?.latestCommit);
    if (!commitId) {
      return { pullRequestId: args["pullRequestId"], commitId: null, items: [], note: "No source head commit found on the pull request." };
    }
    const { items, page } = await listPage(ctx, `/rest/build-status/1.0/commits/${commitId}`, args);
    const cards = items.map((build) => {
      const card = projectCard(build, BUILD_FIELDS);
      card["dateAdded"] = epochToIso(card["dateAdded"]);
      return card;
    });
    return { pullRequestId: args["pullRequestId"], commitId, ...pagedResult(cards, page) };
  },
};

const BUILD_FIELDS = defineCardFields([
  ["state", "state"],
  ["key", "key"],
  ["name", "name"],
  ["url", "url"],
  ["description", "description", 200],
  ["dateAdded", "dateAdded"],
]);

export const pullRequestToolManifests: ToolManifest[] = [
  listPullRequests,
  getPullRequest,
  getPullRequestChanges,
  getPullRequestDiff,
  getPullRequestBuilds,
];
