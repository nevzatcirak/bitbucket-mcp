/**
 * Bitbucket Cloud read handlers (REST 2.0), branched to from the shared tool
 * manifests when the active provider is "cloud". Cards mirror the Server/DC
 * shapes so MCP clients see one convention.
 */

import { asNumber, asRecord, asString, truncateString } from "../../core/json.js";
import { ERROR_CODES, ToolError } from "../../core/errors.js";
import { RestError } from "../../core/restClient.js";
import type { ToolArgs, ToolCallContext } from "../registry.js";
import { listPageCloud, pagedResult, refSegment, repoBase } from "./common.js";

/** Resolve the default branch of a repository (mainbranch.name). */
async function mainBranchOf(ctx: ToolCallContext, base: string): Promise<string | null> {
  const repo = await ctx.provider.client.get<unknown>(base);
  return asString(asRecord(asRecord(repo)?.mainbranch)?.name);
}

async function resolveRevision(ctx: ToolCallContext, base: string, at: string | undefined): Promise<string> {
  if (at) return at;
  const main = await mainBranchOf(ctx, base);
  if (!main) throw new RestError(500, "UPSTREAM_ERROR", "Repository payload has no mainbranch to browse.");
  return main;
}

// ---------------------------------------------------------------- discovery

export async function getProjectsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const { items, page } = await listPageCloud(ctx, "/user/workspaces", args);
  const cards = items.map((ws) => {
    const workspace = asRecord(asRecord(ws)?.workspace) ?? {};
    return {
      key: asString(workspace.slug) ?? "",
      name: asString(workspace.name) ?? asString(workspace.slug) ?? "",
    };
  });
  return pagedResult(cards, page);
}

export async function getProjectCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const ws = await ctx.provider.client.get<unknown>(`/workspaces/${String(args["projectKey"])}`);
  const record = asRecord(ws) ?? {};
  return {
    key: asString(record.slug) ?? String(args["projectKey"]),
    name: asString(record.name) ?? null,
    isPrivate: record.is_private === true,
    created: asString(record.created_on),
    updated: asString(record.updated_on),
  };
}

export function repositoryCard(repo: unknown): Record<string, unknown> {
  const record = asRecord(repo) ?? {};
  const fullName = asString(record.full_name) ?? "";
  const clones = (asRecord(record.links)?.clone as unknown[] | undefined) ?? [];
  const https = clones.find((c) => asRecord(c)?.name === "https");
  return {
    slug: asString(record.slug) ?? fullName.split("/")[1] ?? "",
    name: asString(record.name) ?? null,
    project: fullName.split("/")[0] || null,
    cloneUrl: asString(asRecord(https)?.href),
    isPrivate: record.is_private === true,
    mainBranch: asString(asRecord(record.mainbranch)?.name),
    language: asString(record.language),
    updated: asString(record.updated_on),
  };
}

export async function getRepositoriesCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = `/repositories/${String(args["projectKey"])}`;
  const { items, page } = await listPageCloud(ctx, base, args);
  const nameFilter = asString(args["name"])?.toLowerCase();
  const filtered = nameFilter
    ? items.filter((r) => asString(asRecord(r)?.name)?.toLowerCase().includes(nameFilter))
    : items;
  const warning = nameFilter
    ? "Name filter is applied client-side on this page only; matching repositories may exist on other pages."
    : undefined;
  return pagedResult(filtered.map((r) => repositoryCard(r)), page, warning);
}

export async function getRepositoryCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const repo = await ctx.provider.client.get<unknown>(
    repoBase(ctx, args["projectKey"], args["repositorySlug"]),
  );
  return repositoryCard(repo);
}

// ------------------------------------------------------------- source & code

export async function browseRepositoryCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const revision = await resolveRevision(ctx, base, args["at"] as string | undefined);
  const rawPath = ((args["path"] as string | undefined) ?? "").replace(/^\/+|\/+$/g, "");
  // A trailing slash is required to list the root directory.
  const srcPath = rawPath ? `/${rawPath}` : "/";
  const { items, page } = await listPageCloud(ctx, `${base}/src/${refSegment(revision)}${srcPath}`, args);
  const cards = items.map((entry) => {
    const record = asRecord(entry) ?? {};
    const p = asString(record.path) ?? "";
    return {
      name: p.split("/").pop() ?? p,
      path: p,
      type: asString(record.type) === "commit_directory" ? "dir" : "file",
      size: asNumber(record.size),
    };
  });
  return { type: "directory", path: rawPath || "/", ...pagedResult(cards, page) };
}

export async function getFileContentCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const revision = await resolveRevision(ctx, base, args["at"] as string | undefined);
  const path = String(args["path"]);
  const fileUrl = `${base}/src/${refSegment(revision)}/${path}`;
  const meta = await ctx.provider.client.get<unknown>(fileUrl, { query: { format: "meta" } });
  const maxChars = Math.min(Math.max(asNumber(args["maxChars"]) ?? 20_000, 200), 60_000);
  const raw = await ctx.provider.client.get<unknown>(fileUrl, { headers: { Accept: "text/plain" } });
  // Raw endpoints stream the file body; safeJson may still parse JSON files.
  const content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const totalChars = content.length;
  const truncated = totalChars > maxChars;
  return {
    path,
    at: revision,
    size: asNumber(asRecord(meta)?.size) ?? totalChars,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    totalChars,
  };
}

export async function searchCodeCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  // Cloud code search is workspace-scoped; the shared schema's 'project'
  // modifier selects the workspace and 'repo' narrows via the repo: modifier.
  const workspace = asString(args["project"]);
  if (!workspace) {
    throw new ToolError(
      ERROR_CODES.VALIDATION,
      "Cloud code search is workspace-scoped — pass 'project' (the workspace slug).",
      { provider: "cloud" },
    );
  }
  let searchQuery = String(args["query"] ?? "");
  const repo = asString(args["repo"]);
  if (repo) searchQuery += ` repo:"${repo}"`;

  const ignoredModifiers = [
    args["path"] !== undefined ? "path" : null,
    args["ext"] !== undefined ? "ext" : null,
  ].filter((m): m is string => m !== null);
  const warning =
    ignoredModifiers.length > 0
      ? `${ignoredModifiers.join(" and ")} modifier(s) are not supported by Cloud code search and were ignored.`
      : undefined;

  const { items, page } = await listPageCloud(
    ctx,
    `/workspaces/${workspace}/search/code`,
    args,
    { search_query: searchQuery },
  );
  const cards = items.map((hit) => {
    const record = asRecord(hit) ?? {};
    const file = asRecord(record.file) ?? {};
    return {
      path: asString(file.path) ?? "",
      matchCount: asNumber(record.content_match_count) ?? 0,
      preview: firstMatchPreview(record.content_matches),
    };
  });
  return pagedResult(cards, page, warning);
}

function firstMatchPreview(matches: unknown): string | null {
  const list = Array.isArray(matches) ? matches : [];
  const lines = (asRecord(list[0])?.lines as unknown[] | undefined) ?? [];
  const segments = (asRecord(lines[0])?.segments as unknown[] | undefined) ?? [];
  const text = segments.map((s) => asString(asRecord(s)?.text) ?? "").join("");
  return text ? truncateString(text, 200) : null;
}

// ----------------------------------------------------------------- git data

export async function listBranchesCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const [branches, defaultBranch] = await Promise.all([
    listPageCloud(ctx, `${base}/refs/branches`, args),
    mainBranchOf(ctx, base),
  ]);
  const filter = asString(args["filter"])?.toLowerCase();
  const filtered = filter
    ? branches.items.filter((b) => asString(asRecord(b)?.name)?.toLowerCase().includes(filter))
    : branches.items;
  const cards = filtered.map((b) => {
    const record = asRecord(b) ?? {};
    return {
      displayId: asString(record.name) ?? "",
      commit: asString(asRecord(record.target)?.hash),
      isDefault: asString(record.name) === defaultBranch,
    };
  });
  const warning = filter
    ? "Branch filter is applied client-side on this page only; matching branches may exist on other pages."
    : undefined;
  return pagedResult(cards, branches.page, warning);
}

export async function listCommitsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const revision = await resolveRevision(ctx, base, args["until"] as string | undefined);
  const { items, page } = await listPageCloud(ctx, `${base}/commits/${refSegment(revision)}`, args, {
    path: asString(args["path"]) ?? undefined,
  });
  let filtered = items;
  if (args["includeMerges"] === false) {
    // Cloud has no merge filter — filter client-side by parent count.
    filtered = filtered.filter((c) => ((asRecord(c)?.parents as unknown[] | undefined) ?? []).length <= 1);
  }
  const author = asString(args["author"]);
  const needle = author?.toLowerCase();
  if (needle) {
    filtered = filtered.filter((c) => commitAuthorName(c).toLowerCase().includes(needle));
  }
  const cards = filtered.map((c) => {
    const record = asRecord(c) ?? {};
    return {
      displayId: asString(record.hash) ?? "",
      author: commitAuthorName(c),
      date: asString(record.date),
      message: truncateString(asString(record.message) ?? "", 200),
    };
  });
  const warning = author
    ? "Author filter is applied client-side on this page only; matching commits may exist on other pages. since/until ranges are not supported on Cloud."
    : undefined;
  return pagedResult(cards, page, warning);
}

function commitAuthorName(commit: unknown): string {
  const author = asRecord(asRecord(commit)?.author);
  return asString(asRecord(author?.user)?.display_name) ?? asString(author?.raw) ?? "";
}

// ------------------------------------------------------------ pull requests

export function pullRequestCard(pr: unknown, maxDescriptionChars?: number): Record<string, unknown> {
  const record = asRecord(pr) ?? {};
  const description = asString(record.description) ?? asString(asRecord(record.summary)?.raw) ?? "";
  const source = asRecord(record.source);
  const destination = asRecord(record.destination);
  const sourceRepo = asString(asRecord(source?.repository)?.full_name) ?? "";
  return {
    id: asNumber(record.id),
    title: truncateString(asString(record.title) ?? "", 120),
    state: asString(record.state) ?? "",
    author: asString(asRecord(record.author)?.display_name) ?? "",
    fromBranch: asString(asRecord(source?.branch)?.name) ?? "",
    toBranch: asString(asRecord(destination?.branch)?.name) ?? "",
    project: sourceRepo.split("/")[0] || null,
    repo: sourceRepo.split("/")[1] || null,
    updated: asString(record.updated_on),
    ...(maxDescriptionChars !== undefined ? { description: truncateString(description, maxDescriptionChars) } : {}),
  };
}

export async function listPullRequestsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const state = asString(args["state"]) ?? "OPEN";
  const { items, page } = await listPageCloud(ctx, `${base}/pullrequests`, args, {
    state: state === "ALL" ? undefined : state,
  });
  const author = asString(args["author"]);
  const needle = author?.toLowerCase();
  const filtered = needle
    ? items.filter((pr) => prAuthorName(pr).toLowerCase().includes(needle))
    : items;
  const cards = filtered.map((pr) => pullRequestCard(pr));
  const warning = author
    ? "Author filter is applied client-side on this page only; matching pull requests may exist on other pages. direction is not supported on Cloud."
    : undefined;
  return pagedResult(cards, page, warning);
}

function prAuthorName(pr: unknown): string {
  const author = asRecord(asRecord(pr)?.author);
  return (
    asString(author?.display_name) ??
    asString(author?.nickname) ??
    asString(author?.username) ??
    asString(author?.uuid) ??
    ""
  );
}

export async function getPullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const pr = await ctx.provider.client.get<unknown>(
    `${repoBase(ctx, args["projectKey"], args["repositorySlug"])}/pullrequests/${String(args["pullRequestId"])}`,
  );
  const record = asRecord(pr) ?? {};
  const card = pullRequestCard(pr, Math.min(Math.max(asNumber(args["maxDescriptionChars"]) ?? 600, 0), 10_000));
  card["reviewers"] = ((record.reviewers as unknown[] | undefined) ?? []).map((r) => {
    const user = asRecord(r) ?? {};
    return {
      username: asString(user.username) ?? asString(user.uuid) ?? "",
      displayName: asString(user.display_name) ?? null,
      approved: user.role === "REVIEWER" && asString(user.state) === "approved",
    };
  });
  card["commentCount"] = asNumber(record.comment_count);
  return card;
}

export async function getPullRequestChangesCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const { items, page } = await listPageCloud(
    ctx,
    `${base}/pullrequests/${args["pullRequestId"] as number}/diffstat`,
    args,
  );
  const cards = items.map((entry) => {
    const record = asRecord(entry) ?? {};
    return {
      path: asString(asRecord(record.new)?.path) ?? asString(asRecord(record.old)?.path) ?? "",
      changeType: asString(record.status) ?? "",
      addedLines: asNumber(record.lines_added) ?? 0,
      removedLines: asNumber(record.lines_removed) ?? 0,
    };
  });
  return pagedResult(cards, page);
}

export async function getPullRequestDiffCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const diff = await ctx.provider.client.get<unknown>(
    `${base}/pullrequests/${args["pullRequestId"] as number}/diff`,
    { headers: { Accept: "text/plain" } },
  );
  const text = typeof diff === "string" ? diff : "";
  // The shared schema's per-file budget is reused as a global budget on Cloud
  // (the raw diff endpoint returns one plain-text document, not file records).
  const maxChars = Math.min(Math.max((asNumber(args["maxCharsPerFile"]) ?? 1200) * 10, 1_000), 200_000);
  const truncated = text.length > maxChars;
  return {
    pullRequestId: args["pullRequestId"],
    diff: truncated ? `${text.slice(0, maxChars)}\n… [truncated]` : text,
    totalChars: text.length,
    truncated,
    note: "Cloud returns the whole diff as plain text; per-file compaction is not applied.",
  };
}

export async function getPullRequestBuildsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const pr = await ctx.provider.client.get<unknown>(`${base}/pullrequests/${args["pullRequestId"] as number}`);
  const sha = asString(asRecord(asRecord(asRecord(pr)?.source)?.commit)?.hash);
  if (!sha) {
    return {
      pullRequestId: args["pullRequestId"],
      headCommit: null,
      items: [],
      note: "No source head commit found on the pull request.",
    };
  }
  const { items, page } = await listPageCloud(ctx, `${base}/commit/${refSegment(sha)}/statuses`, args);
  const cards = items.map((s) => {
    const record = asRecord(s) ?? {};
    return {
      state: asString(record.state) ?? "",
      name: asString(record.name) ?? asString(record.key) ?? "",
      key: asString(record.key),
      url: asString(record.url),
      dateAdded: asString(record.created_on),
    };
  });
  return { pullRequestId: args["pullRequestId"], headCommit: sha, ...pagedResult(cards, page) };
}

export async function getPullRequestCommentsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const prId = args["pullRequestId"] as number;
  const [comments, tasks] = await Promise.all([
    listPageCloud(ctx, `${base}/pullrequests/${prId}/comments`, args),
    ctx.provider.client.get<unknown>(`${base}/pullrequests/${prId}/tasks`).catch(() => null),
  ]);
  const taskCountByComment = new Map<number, number>();
  let openTasks = 0;
  for (const t of (asRecord(tasks)?.values as unknown[] | undefined) ?? []) {
    const record = asRecord(t) ?? {};
    const commentId = asNumber(asRecord(record.comment)?.id);
    if (commentId !== null) {
      taskCountByComment.set(commentId, (taskCountByComment.get(commentId) ?? 0) + 1);
    }
    if (asString(record.state) === "RESOLVED") continue;
    openTasks += 1;
  }

  const severityFilter = asString(args["severity"]) ?? "ALL";
  const includeReplies = args["includeReplies"] !== false;
  const maxTextChars = Math.min(Math.max(asNumber(args["maxTextChars"]) ?? 400, 50), 5_000);

  const roots = (comments.items as unknown[]).filter((c) => includeReplies || asRecord(c)?.parent === undefined);
  const cards = roots.map((c) => {
    const record = asRecord(c) ?? {};
    const text = asString(asRecord(record.content)?.raw) ?? "";
    const id = asNumber(record.id) ?? -1;
    return {
      id,
      author: asString(asRecord(record.user)?.display_name) ?? "",
      severity: text.startsWith("[BLOCKER]") ? "BLOCKER" : "NORMAL",
      state: record.resolution ? "RESOLVED" : "OPEN",
      text: truncateString(text, maxTextChars),
      inlinePath: asString(asRecord(record.inline)?.path),
      taskCount: taskCountByComment.get(id) ?? 0,
      created: asString(record.created_on),
    };
  });

  const includeResolved = args["includeResolved"] === true;
  const visible = cards.filter((c) => {
    if (!includeResolved && c.state === "RESOLVED") return false;
    if (severityFilter !== "ALL" && c.severity !== severityFilter) return false;
    return true;
  });
  return {
    summary: {
      threads: visible.length,
      blockers: visible.filter((c) => c.severity === "BLOCKER").length,
      openTasks,
    },
    ...pagedResult(visible, comments.page),
  };
}

// -------------------------------------------------------------- dashboard

export async function getDashboardPullRequestsCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const role = (asString(args["role"]) ?? "REVIEWER").toLowerCase();
  const state = asString(args["state"]) ?? "OPEN";
  const { items, page } = await listPageCloud(ctx, "/pullrequests", args, {
    role,
    state: state === "ALL" ? undefined : state,
  });
  return pagedResult(items.map((pr) => pullRequestCard(pr)), page);
}

// ------------------------------------------------------------------- users

export async function getUserCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const userSlug = asString(args["userSlug"]);
  if (userSlug) {
    const user = await ctx.provider.client.get<unknown>(`/users/${refSegment(userSlug)}`);
    return userCard(user);
  }
  // No global user search on Cloud — without a slug, answer with the caller.
  const me = await ctx.provider.client.get<unknown>("/user");
  const card = userCard(me);
  card["note"] =
    "Filter search is not supported on Cloud — pass userSlug (username, uuid or account_id), or this is your own account.";
  return card;
}

export function userCard(user: unknown): Record<string, unknown> {
  const record = asRecord(user) ?? {};
  return {
    username: asString(record.username) ?? asString(record.nickname) ?? asString(record.uuid) ?? "",
    displayName: asString(record.display_name) ?? "",
    uuid: asString(record.uuid),
    accountId: asString(record.account_id),
  };
}
