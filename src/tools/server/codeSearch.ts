/**
 * Code search for both providers. Server/DC translates modifier inputs into
 * the Lucene query string (project:, repo:, path:, ext:); Cloud uses the
 * workspace-scoped search endpoint with only the repo: modifier.
 */

import { z } from "zod";
import { asRecord, asString } from "../../core/json.js";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import { extractPageItems, pageMeta, pageQuery } from "../../core/pagination.js";
import type { ToolManifest } from "../registry.js";
import { apiPath, pagedResult } from "./common.js";
import { searchCodeCloud } from "../cloud/reads.js";

const SEARCH_FIELDS = defineCardFields([
  ["path", "path"],
  ["project", "project"],
  ["repo", "repo"],
  ["type", "type"],
]);

const searchCode: ToolManifest = {
  name: "bb_search_code",
  title: "Search code",
  description:
    "Full-text code search. On Server/DC supports Lucene modifiers: project:<key>, repo:<projectKey>/<slug>, path:<prefix>, ext:<ext>. On Cloud the search is workspace-scoped: 'project' selects the workspace (required), 'repo' narrows to one repository ('<workspace>/<slug>'), path/ext modifiers are not supported.",
  inputSchema: {
    query: z.string().min(1).max(500).describe("Free-text search expression, e.g. 'OptimisticLock' or 'class RestClient'."),
    project: z.string().min(1).max(128).optional().describe("Modifier: limit search to this project key (on Cloud: the workspace slug — required)."),
    repo: z.string().min(1).max(257).optional().describe("Modifier: limit search to this repository as '<projectKey>/<slug>'."),
    path: z.string().min(1).max(1024).optional().describe("Modifier: limit search to paths starting with this prefix (Server/DC only)."),
    ext: z.string().min(1).max(32).optional().describe("Modifier: limit search to this file extension (Server/DC only), e.g. 'ts'."),
    limit: z.number().int().min(1).max(200).default(25).describe("Page size (max 200 for search)."),
    start: z.number().int().min(0).default(0).describe("Zero-based page offset (Server/DC)."),
    page: z.number().int().min(1).optional().describe("One-based page number (Cloud only)."),
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return searchCodeCloud(args, ctx);
    const modifiers = [
      args["project"] ? `project:${args["project"]}` : null,
      args["repo"] ? `repo:${args["repo"]}` : null,
      args["path"] ? `path:${args["path"]}` : null,
      args["ext"] ? `ext:${args["ext"]}` : null,
    ].filter((m): m is string => m !== null);
    const q = [args["query"] as string, ...modifiers].join(" ");

    // The search envelope nests pagination under `searchResults` — request
    // directly and normalize that inner envelope.
    const style = ctx.provider.pagination;
    const query = { ...pageQuery(args, style), q };
    const payload = await ctx.provider.client.get<unknown>(apiPath("/search"), { query });
    const searchResults = asRecord(payload)?.searchResults ?? payload;
    const items = extractPageItems(searchResults, ["results"]);
    const page = pageMeta(searchResults, args["start"] as number, args["limit"] as number, items.length);

    const cards = items.map((item) => {
      const record = asRecord(item);
      const pathObj = asRecord(record?.path);
      const repository = asRecord(record?.repository);
      const flat = {
        path: asString(pathObj?.toString) ?? "",
        project: asString(asRecord(repository?.project)?.key) ?? "",
        repo: asString(repository?.slug) ?? "",
        type: asString(pathObj?.toString)?.split(".").pop() ?? null,
      };
      return projectCard(flat, SEARCH_FIELDS);
    });
    return pagedResult(cards, page);
  },
};

export const codeSearchToolManifests: ToolManifest[] = [searchCode];
