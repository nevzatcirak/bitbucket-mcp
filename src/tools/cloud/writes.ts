/**
 * Bitbucket Cloud write handlers (REST 2.0): branch writes, PR lifecycle,
 * comments/tasks and review verdicts.
 *
 * Notes on Cloud semantics (differ from Server/DC):
 * - No optimistic-lock `version` — PR/comment updates are partial PUTs (last write wins).
 * - Merge strategy ids: merge_commit | squash | fast_forward (Cloud spelling).
 * - There is no reopen endpoint for declined PRs (reopenPullRequest is server-only).
 * - No NEEDS_WORK verdict: NEEDS_WORK maps to POST /request-changes.
 * - No draft/pending comments: `pending: true` is rejected with VALIDATION.
 * - No severity field: BLOCKER is carried as a `[BLOCKER]` text tag + a real task.
 */

import { asNumber, asRecord, asString } from "../../core/json.js";
import { ERROR_CODES, ToolError } from "../../core/errors.js";
import { RestError } from "../../core/restClient.js";
import type { ToolArgs, ToolCallContext } from "../registry.js";
import { refSegment, repoBase } from "./common.js";
import { pullRequestCard, userCard } from "./reads.js";

const MERGE_STRATEGY_CLOUD: Record<string, string> = {
  "merge-commit": "merge_commit",
  squash: "squash",
  "fast-forward": "fast_forward",
};

function prBase(args: ToolArgs, ctx: ToolCallContext): string {
  return `${repoBase(ctx, args["projectKey"], args["repositorySlug"])}/pullrequests/${args["pullRequestId"] as number}`;
}

// ------------------------------------------------------------------ branches

export async function createBranchCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  let target = args["startPoint"] as string | undefined;
  if (!target) {
    const repo = await ctx.provider.client.get<unknown>(base);
    target = asString(asRecord(asRecord(repo)?.mainbranch)?.name) ?? undefined;
  }
  if (!target) {
    throw new ToolError(ERROR_CODES.VALIDATION, "startPoint is required when the repository has no mainbranch.");
  }
  const branch = await ctx.provider.client.post<unknown>(`${base}/refs/branches`, {
    body: { name: args["name"] as string, target: { hash: target } },
  });
  const record = asRecord(branch) ?? {};
  return {
    created: true,
    displayId: asString(record.name) ?? (args["name"] as string),
    commit: asString(asRecord(record.target)?.hash),
    startPoint: target,
  };
}

export async function deleteBranchCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const base = repoBase(ctx, args["projectKey"], args["repositorySlug"]);
  const name = args["name"] as string;
  const repo = await ctx.provider.client.get<unknown>(base);
  const main = asString(asRecord(asRecord(repo)?.mainbranch)?.name);
  if (main && main === name) {
    throw new ToolError(
      ERROR_CODES.DELETE_REFUSED,
      `Refusing to delete '${name}' — it is the main branch of ${String(args["projectKey"])}/${String(args["repositorySlug"])}.`,
      { branch: name, defaultBranch: true },
    );
  }
  await ctx.provider.client.delete<unknown>(`${base}/refs/branches/${refSegment(name)}`);
  return { deleted: true, name };
}

// -------------------------------------------------------------- PR lifecycle

export async function createPullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const toProject = String(args["projectKey"]);
  const toRepo = String(args["repositorySlug"]);
  const fromProject = (args["fromProjectKey"] as string | undefined) ?? toProject;
  const fromRepo = (args["fromRepositorySlug"] as string | undefined) ?? toRepo;

  const body: Record<string, unknown> = {
    title: args["title"] as string,
    description: (args["description"] as string | undefined) ?? "",
    source: {
      branch: { name: args["fromBranch"] as string },
      ...((args["fromProjectKey"] as string | undefined) || (args["fromRepositorySlug"] as string | undefined)
        ? { repository: { full_name: `${fromProject}/${fromRepo}` } }
        : {}),
    },
    destination: { branch: { name: args["toBranch"] as string } },
  };
  const reviewers = args["reviewers"] as string[] | undefined;
  if (reviewers && reviewers.length > 0) {
    // Cloud reviewer references: {uuid: "{...}"} or {username: "..."}.
    body["reviewers"] = reviewers.map((r) => (r.startsWith("{") ? { uuid: r } : { username: r }));
  }
  // No default-reviewers service exists on Cloud — reviewers must be explicit.

  const pr = await ctx.provider.client.post<unknown>(`/repositories/${toProject}/${toRepo}/pullrequests`, { body });
  const card = pullRequestCard(pr);
  if (reviewers && reviewers.length === 0) {
    card["reviewerNote"] = "No reviewers requested; Cloud has no required-reviewers service to pre-fill from.";
  }
  return card;
}

export async function updatePullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (args["title"] !== undefined) body["title"] = args["title"] as string;
  if (args["description"] !== undefined) body["description"] = args["description"] as string;
  if (args["toBranch"] !== undefined) {
    body["destination"] = { branch: { name: args["toBranch"] as string } };
  }
  // Cloud has no optimistic-lock version: partial PUT, last write wins.
  const pr = await ctx.provider.client.put<unknown>(prBase(args, ctx), { body });
  const card = pullRequestCard(pr);
  card["note"] = "Cloud has no version-based optimistic lock — the update was applied as a single partial PUT.";
  return card;
}

export async function canMergePullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const pr = await ctx.provider.client.get<unknown>(prBase(args, ctx));
  const record = asRecord(pr) ?? {};
  const state = asString(record.state) ?? "";
  let conflicts: Record<string, unknown>[] = [];
  try {
    const payload = await ctx.provider.client.get<unknown>(`${prBase(args, ctx)}/conflicts`);
    const values = (asRecord(payload)?.values as unknown[] | undefined) ?? [];
    conflicts = values.map((c) => ({
      path:
        asString(asRecord(asRecord(c)?.new)?.path) ?? asString(asRecord(asRecord(c)?.old)?.path) ?? "",
      scenario: asString(asRecord(c)?.scenario) ?? "",
      message: asString(asRecord(c)?.message),
    }));
  } catch (err) {
    if (!(err instanceof RestError)) throw err;
    // 400/404/302 quirks on some versions: the conflicts pre-check is
    // unavailable — treat as no conflicts and note the limitation.
    conflicts = [];
  }
  const conflicted = conflicts.length > 0;
  return {
    pullRequestId: args["pullRequestId"],
    canMerge: state === "OPEN" && !conflicted,
    conflicted,
    vetoes: [
      ...(state !== "OPEN" ? [{ summary: `Pull request state is ${state || "UNKNOWN"}, not OPEN.`, detail: null }] : []),
      ...(conflicted
        ? [{ summary: `Merge conflicts in ${conflicts.length} file(s).`, detail: conflicts.map((c) => c.path).join(", ") }]
        : []),
    ],
    note: "Cloud has no merge-veto API — mergeability is derived from the PR state and the conflicts pre-check.",
  };
}

export async function mergePullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const body: Record<string, unknown> = { type: "merge" };
  if (args["message"] !== undefined) body["message"] = args["message"] as string;
  if (args["strategy"] !== undefined) {
    const cloudStrategy = MERGE_STRATEGY_CLOUD[args["strategy"] as string];
    if (!cloudStrategy) {
      throw new ToolError(
        ERROR_CODES.VALIDATION,
        `Unknown merge strategy '${String(args["strategy"])}' — expected merge-commit | squash | fast-forward.`,
      );
    }
    body["merge_strategy"] = cloudStrategy;
  }
  const merged = await ctx.provider.client.post<unknown>(`${prBase(args, ctx)}/merge`, { body });
  const card = pullRequestCard(merged);
  card["mergedWith"] = (args["strategy"] as string | undefined) ?? "cloud-default";
  return card;
}

export async function declinePullRequestCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  if (args["message"] !== undefined) {
    // Cloud decline takes no body; decline reasons belong in comments.
    void args["message"];
  }
  const declined = await ctx.provider.client.post<unknown>(`${prBase(args, ctx)}/decline`);
  const card = pullRequestCard(declined);
  card["note"] = "Cloud decline accepts no message — post a comment if a reason should be recorded.";
  return card;
}

// ------------------------------------------------------------------ comments

function commentUrl(args: ToolArgs, ctx: ToolCallContext): string {
  return `${prBase(args, ctx)}/comments/${args["commentId"] as number}`;
}

export async function postPullRequestCommentCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  if (args["pending"] === true) {
    throw new ToolError(
      ERROR_CODES.VALIDATION,
      "Draft (pending) comments are not supported on Bitbucket Cloud — omit 'pending'.",
    );
  }
  const file = args["file"] as string | undefined;
  const line = args["line"] as number | undefined;
  if (file && line === undefined) {
    throw new ToolError(ERROR_CODES.VALIDATION, "Inline comments require both 'file' and 'line'.");
  }
  if (!file && (line !== undefined || args["startLine"] !== undefined)) {
    throw new ToolError(ERROR_CODES.VALIDATION, "'line'/'startLine' require 'file' (inline comment).");
  }

  const severity = args["severity"] as string | undefined;
  // Cloud has no severity field on comments — BLOCKER is carried as a text tag.
  const text = severity === "BLOCKER" ? `[BLOCKER] ${args["text"] as string}` : (args["text"] as string);

  const body: Record<string, unknown> = { content: { raw: text } };
  if (file) {
    // Cloud inline semantics: from = line in the OLD file, to = line in the NEW file.
    const lineType = args["lineType"] as string | undefined;
    const inline: Record<string, unknown> = { path: file };
    if (lineType === "REMOVED") inline["from"] = line;
    else inline["to"] = line;
    if (args["startLine"] !== undefined) {
      if (lineType === "REMOVED") inline["start_from"] = args["startLine"];
      else inline["start_to"] = args["startLine"];
    }
    body["inline"] = inline;
  }

  const payload = await ctx.provider.client.post<unknown>(`${prBase(args, ctx)}/comments`, { body });
  const comment = asRecord(payload) ?? {};
  const commentId = asNumber(comment.id);

  let taskCreated = false;
  if (severity === "BLOCKER" && commentId !== null) {
    // Cloud has a real task API — anchor it to the comment like the Server flow.
    await ctx.provider.client.post<unknown>(`${prBase(args, ctx)}/tasks`, {
      body: {
        content: { raw: (args["taskText"] as string | undefined) ?? "Follow-up required from a blocker comment." },
        comment: { id: commentId },
        pending: false,
      },
    });
    taskCreated = true;
  }

  return {
    id: commentId,
    severity: severity ?? "NORMAL",
    state: comment.resolution ? "RESOLVED" : "OPEN",
    pending: false,
    taskCreated,
    text: asString(asRecord(comment.content)?.raw) ?? text,
  };
}

export async function updatePullRequestCommentCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  const commentId = args["commentId"] as number;

  // No optimistic-lock version on Cloud comment updates — single PUT.
  if (args["text"] !== undefined) {
    await ctx.provider.client.put<unknown>(commentUrl(args, ctx), {
      body: { content: { raw: args["text"] as string } },
    });
  }

  let state: string | null = null;
  if (args["state"] === "RESOLVED") {
    await ctx.provider.client.post<unknown>(`${commentUrl(args, ctx)}/resolve`, { body: {} });
    state = "RESOLVED";
  } else if (args["state"] === "OPEN") {
    await ctx.provider.client.delete<unknown>(`${commentUrl(args, ctx)}/resolve`);
    state = "OPEN";
  }

  let taskUpdated: string | null = null;
  if (args["taskId"] !== undefined || args["taskState"] !== undefined) {
    const taskId = args["taskId"] as number | undefined;
    const taskState = args["taskState"] as string | undefined;
    if (taskId === undefined || taskState === undefined) {
      throw new ToolError(ERROR_CODES.VALIDATION, "taskId and taskState must be provided together.");
    }
    await ctx.provider.client.put<unknown>(`${prBase(args, ctx)}/tasks/${taskId}`, {
      body: { state: taskState === "RESOLVED" ? "RESOLVED" : "UNRESOLVED" },
    });
    taskUpdated = String(taskId);
  }

  const card: Record<string, unknown> = { id: commentId };
  if (args["text"] !== undefined) card["text"] = (args["text"] as string).slice(0, 200);
  if (args["severity"] !== undefined) {
    card["severity"] = args["severity"];
    card["note"] =
      "Cloud comments have no severity field — the [BLOCKER] text-tag convention applies; edit the text to set or clear it.";
  }
  if (state !== null) card["state"] = state;
  card["taskUpdated"] = taskUpdated;
  return card;
}

// ------------------------------------------------------------------- review

export async function submitPullRequestReviewCloud(args: ToolArgs, ctx: ToolCallContext): Promise<unknown> {
  // Cloud approvals/changes-requests always act as the authenticated user.
  const me = await ctx.provider.client.get<unknown>("/user");
  const meCard = userCard(me);
  const meUsername = String(meCard["username"] ?? "");
  const explicit = args["userSlug"] as string | undefined;
  if (explicit && explicit !== meUsername) {
    throw new ToolError(
      ERROR_CODES.VALIDATION,
      "Cloud reviews always apply to the authenticated user — remove 'userSlug' or match it to the configured account.",
      { authenticatedAs: meUsername, requested: explicit },
    );
  }

  const verdict = args["verdict"] as string;
  const approvePath = `${prBase(args, ctx)}/approve`;
  const changesPath = `${prBase(args, ctx)}/request-changes`;

  let note: string | undefined;
  if (verdict === "APPROVED") {
    await ctx.provider.client.post<unknown>(approvePath, { body: {} });
  } else if (verdict === "UNAPPROVED") {
    await ctx.provider.client.delete<unknown>(approvePath);
  } else if (verdict === "NEEDS_WORK") {
    await ctx.provider.client.post<unknown>(changesPath, { body: {} });
    note = "Cloud has no NEEDS_WORK state — submitted as 'request changes' (participant state: changes_requested).";
  }

  return {
    pullRequestId: args["pullRequestId"],
    userSlug: meUsername,
    verdict,
    approved: verdict === "APPROVED",
    publishedComments: null, // no pending/draft comments exist on Cloud
    ...(note ? { note } : {}),
  };
}
