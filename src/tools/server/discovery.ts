/**
 * Discovery tools (projects, repositories, repository browsing, file content)
 * for both providers: Server/DC REST 1.0 and Bitbucket Cloud REST 2.0
 * (project keys translate to Cloud workspaces).
 */

import { z } from "zod";
import { asRecord, asString, truncateString } from "../../core/json.js";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import { extractPageItems, pageMeta, pageQuery } from "../../core/pagination.js";
import type { ToolManifest } from "../registry.js";
import { apiPath, listPage, pagedResult } from "./common.js";
import {
  browseRepositoryCloud,
  getFileContentCloud,
  getProjectCloud,
  getProjectsCloud,
  getRepositoriesCloud,
  getRepositoryCloud,
} from "../cloud/reads.js";

const LIMIT_FIELD = z.number().int().min(1).max(1000).default(25).describe("Page size (1-1000).");
const START_FIELD = z.number().int().min(0).default(0).describe("Zero-based page offset (Server/DC).");
const PAGE_FIELD = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe("One-based page number (Cloud only; from nextPageStart of the previous call). Ignored on Server/DC.");

const PROJECT_FIELDS = defineCardFields([
  ["key", "key"],
  ["id", "id"],
  ["name", "name"],
  ["description", "description", 200],
  ["public", "public"],
]);

const REPO_FIELDS = defineCardFields([
  ["slug", "slug"],
  ["id", "id"],
  ["name", "name"],
  ["description", "description", 200],
  ["project", "project.key"],
  ["public", "public"],
]);

function repoCard(repo: unknown): Record<string, unknown> {
  const card = projectCard(repo, REPO_FIELDS);
  const clone = asRecord(getCloneLinks(repo));
  card["httpCloneUrl"] = asString(clone?.href) ?? null;
  return card;
}

function getCloneLinks(repo: unknown): unknown {
  const links = asRecord(asRecord(repo)?.links)?.clone;
  if (!Array.isArray(links)) return null;
  return links.find((l) => asString(asRecord(l)?.name) === "http") ?? null;
}

const getProjects: ToolManifest = {
  name: "bb_get_projects",
  title: "List Bitbucket projects",
  description:
    "List projects on the Bitbucket Server / Data Center instance. Supports an optional server-side name filter. Returns compact project cards with paging metadata (isLastPage / nextPageStart).",
  inputSchema: {
    name: z.string().min(1).max(200).optional().describe("Filter projects by name (server-side filter on Server/DC, client-side on Cloud)."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
    page: PAGE_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getProjectsCloud(args, ctx);
    const { items, page } = await listPage(ctx, apiPath("/projects"), args, {
      name: args["name"] as string | undefined,
    });
    return pagedResult(items.map((p) => projectCard(p, PROJECT_FIELDS)), page);
  },
};

const getProject: ToolManifest = {
  name: "bb_get_project",
  title: "Get a Bitbucket project",
  description:
    "Fetch a single project by key and return it as a compact card (key, name, description, visibility).",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key (on Cloud: workspace slug)."),
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getProjectCloud(args, ctx);
    const payload = await ctx.provider.client.get<unknown>(apiPath(`/projects/${args["projectKey"] as string}`));
    return projectCard(payload, PROJECT_FIELDS);
  },
};

const getRepositories: ToolManifest = {
  name: "bb_get_repositories",
  title: "List repositories in a project",
  description:
    "List repositories of a project as compact cards (slug, name, description, visibility). Optional server-side name filter. Returns paging metadata.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key (on Cloud: workspace slug)."),
    name: z.string().min(1).max(200).optional().describe("Filter repositories by name (server-side on Server/DC, client-side on Cloud)."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
    page: PAGE_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getRepositoriesCloud(args, ctx);
    const projectKey = args["projectKey"] as string;
    const { items, page } = await listPage(ctx, apiPath(`/projects/${projectKey}/repos`), args, {
      name: args["name"] as string | undefined,
    });
    return pagedResult(items.map(repoCard), page);
  },
};

const getRepository: ToolManifest = {
  name: "bb_get_repository",
  title: "Get a Bitbucket repository",
  description:
    "Fetch a single repository by project key and slug. Returns a compact card including the HTTP clone URL.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key (on Cloud: workspace slug)."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug, e.g. 'service-api'."),
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getRepositoryCloud(args, ctx);
    const path = apiPath(`/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}`);
    const payload = await ctx.provider.client.get<unknown>(path);
    return repoCard(payload);
  },
};

const browseRepository: ToolManifest = {
  name: "bb_browse_repository",
  title: "Browse repository contents",
  description:
    "Browse the default (or given) branch of a repository. Without 'path' lists the root directory; with a directory path lists entries; with a file path returns truncated content. Use this to explore the tree before fetching files.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug."),
    path: z
      .string()
      .max(1024)
      .optional()
      .describe("Path inside the repository. Empty/omitted = root directory. Trailing slash selects a directory."),
    at: z.string().min(1).max(256).optional().describe("Branch, tag or commit to browse (default: default branch)."),
    limit: LIMIT_FIELD,
    start: START_FIELD,
    page: PAGE_FIELD,
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return browseRepositoryCloud(args, ctx);
    const projectKey = args["projectKey"] as string;
    const repositorySlug = args["repositorySlug"] as string;
    const rawPath = (args["path"] as string | undefined)?.replace(/^\/+|\/+$/g, "") ?? "";
    const suffix = rawPath ? `/${rawPath}` : "";
    // The browse endpoint wraps the page envelope in `children`.
    const payload = await ctx.provider.client.get<unknown>(
      apiPath(`/projects/${projectKey}/repos/${repositorySlug}/browse${suffix}`),
      { query: { ...pageQuery(args, ctx.provider.pagination), at: args["at"] as string | undefined, type: false } },
    );
    const children = asRecord(payload)?.children ?? payload;
    const items = extractPageItems(children);
    const page = pageMeta(children, args["start"] as number, args["limit"] as number, items.length);
    const entries = items.map((item) => {
      const record = asRecord(item);
      const fullPath = asString(asRecord(record?.path)?.toString) ?? "";
      const name = fullPath.split("/").pop() ?? fullPath;
      return { name, path: fullPath, type: asString(record?.type) ?? "FILE" };
    });
    return { type: "directory", path: rawPath || "/", ...pagedResult(entries, page) };
  },
};

const getFileContent: ToolManifest = {
  name: "bb_get_file_content",
  title: "Get file content",
  description:
    "Fetch the raw content of a file from a repository (optionally at a specific branch/tag/commit). Long files are truncated with statistics.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug."),
    path: z.string().min(1).max(1024).describe("File path, e.g. 'src/index.ts'."),
    at: z.string().min(1).max(256).optional().describe("Branch, tag or commit to read from."),
    maxChars: z
      .number()
      .int()
      .min(200)
      .max(60_000)
      .default(20_000)
      .describe("Maximum returned characters; the rest is truncated."),
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getFileContentCloud(args, ctx);
    const path = args["path"] as string;
    const raw = await ctx.provider.client.get<unknown>(
      apiPath(`/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/raw/${path}`),
      { query: { at: args["at"] as string | undefined } },
    );
    const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
    const maxChars = args["maxChars"] as number;
    const truncated = content.length > maxChars;
    return {
      path,
      at: args["at"] ?? null,
      content: truncated ? truncateString(content, maxChars) : content,
      truncated,
      totalChars: content.length,
    };
  },
};

export const discoveryToolManifests: ToolManifest[] = [
  getProjects,
  getProject,
  getRepositories,
  getRepository,
  browseRepository,
  getFileContent,
];
