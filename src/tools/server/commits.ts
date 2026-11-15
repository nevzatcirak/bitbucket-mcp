/**
 * Branch and commit reading for both providers. listCommits author filtering
 * is client-side on both (no server-side author parameter) — paging metadata
 * reflects unfiltered pages.
 */

import { z } from "zod";
import { asRecord, asString } from "../../core/json.js";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import type { ToolManifest } from "../registry.js";
import { apiPath, epochToIso, listPage, pagedResult } from "./common.js";
import { listBranchesCloud, listCommitsCloud } from "../cloud/reads.js";

const LIMIT_FIELD = z.number().int().min(1).max(1000).default(25).describe("Page size (1-1000).");
const START_FIELD = z.number().int().min(0).default(0).describe("Zero-based page offset (Server/DC).");
const PAGE_FIELD = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("One-based page number (Cloud only; from nextPageStart of the previous call). Ignored on Server/DC.");

const listBranches: ToolManifest = {
  name: "bb_list_branches",
  title: "List branches",
  description:
    "List branches of a repository with default-branch detection (isDefault flag). Optional branch name filter (server-side on Server/DC, client-side on Cloud).",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key (on Cloud: workspace slug)."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug."),
    filter: z.string().min(1).max(200).optional().describe("Branch name filter, e.g. 'feature/'."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
    page: PAGE_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return listBranchesCloud(args, ctx);
    const { items, page } = await listPage(
      ctx,
      apiPath(`/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/branches`),
      args,
      { details: true, filter: args["filter"] as string | undefined },
    );
    const fields = defineCardFields([
      ["displayId", "displayId"],
      ["isDefault", "isDefault"],
      ["type", "type"],
      ["latestCommit", "metadata.commitId"],
    ]);
    const cards = items.map((b) => {
      const card = projectCard(b, fields);
      if (card["isDefault"] !== true) card["isDefault"] = false;
      return card;
    });
    return pagedResult(cards, page);
  },
};

const listCommits: ToolManifest = {
  name: "bb_list_commits",
  title: "List commits",
  description:
    "List commits of a repository (or a range with since/until). Optional client-side author filter on username or email — paging metadata reflects unfiltered pages.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug."),
    since: z.string().min(1).max(64).optional().describe("Exclude commits reachable from this branch/tag/commit (Server/DC only)."),
    until: z.string().min(1).max(64).optional().describe("End of the commit range (default: default branch head)."),
    author: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Filter by author username or email (client-side, case-insensitive contains)."),
    includeMerges: z.boolean().default(true).describe("Include merge commits (Cloud: filtered client-side)."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
    page: PAGE_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return listCommitsCloud(args, ctx);
    const { items, page } = await listPage(
      ctx,
      apiPath(`/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/commits`),
      args,
      {
        since: args["since"] as string | undefined,
        until: args["until"] as string | undefined,
        // Valid merge filters: exclude|include|only. Server default (include) is
        // used unless the caller explicitly excludes merge commits.
        merges: args["includeMerges"] === false ? "exclude" : undefined,
        withMessages: true,
      },
    );
    const author = args["author"] as string | undefined;
    const needle = author?.toLowerCase();
    const filtered = needle
      ? items.filter((commit) => {
          const authorRecord = asRecord(asRecord(commit)?.author);
          const name = asString(authorRecord?.name)?.toLowerCase();
          const email = asString(authorRecord?.emailAddress)?.toLowerCase();
          return name?.includes(needle) === true || email?.includes(needle) === true;
        })
      : items;

    const fields = defineCardFields([
      ["displayId", "displayId"],
      ["author", "author.name"],
      ["email", "author.emailAddress"],
      ["date", "authorTimestamp"],
      ["message", "message", 200],
    ]);
    const cards = filtered.map((commit) => {
      const card = projectCard(commit, fields);
      card["date"] = epochToIso(card["date"]);
      return card;
    });
    const warning = author
      ? "Author filter is applied client-side on this page only; matching commits may exist on other pages."
      : undefined;
    return pagedResult(cards, page, warning);
  },
};

export const commitToolManifests: ToolManifest[] = [listBranches, listCommits];
