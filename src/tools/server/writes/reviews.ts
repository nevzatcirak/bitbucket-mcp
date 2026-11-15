/**
 * Review write tools: post/update comments (inline anchors, severity, pending
 * drafts, tasks) and submit a review verdict. Server/DC uses severity fields,
 * pending drafts and optimistic locks; Cloud has none of those — BLOCKER is a
 * `[BLOCKER]` text tag + a real task, pending drafts are rejected, NEEDS_WORK
 * maps to the request-changes endpoint and reviews are self-only.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, truncateString } from "../../../core/json.js";
import { ERROR_CODES, ToolError } from "../../../core/errors.js";
import type { ToolCallContext, ToolManifest } from "../../registry.js";
import { RestError } from "../../../core/restClient.js";
import { withOptimisticLock } from "../../../core/optimisticLock.js";
import { extractPageItems } from "../../../core/pagination.js";
import {
  postPullRequestCommentCloud,
  submitPullRequestReviewCloud,
  updatePullRequestCommentCloud,
} from "../../cloud/writes.js";

const PROJECT_FIELD = z.string().min(1).max(128).describe("Project key (on Cloud: workspace slug).");
const REPO_FIELD = z.string().min(1).max(128).describe("Repository slug.");
const PR_ID_FIELD = z.number().int().min(1).describe("Pull request id.");

function prPath(args: Record<string, unknown>): string {
  return `/rest/api/1.0/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/pull-requests/${args["pullRequestId"] as number}`;
}

function commentPath(args: Record<string, unknown>): string {
  return `${prPath(args)}/comments/${args["commentId"] as number}`;
}

const postPullRequestComment: ToolManifest = {
  name: "bb_post_pull_request_comment",
  title: "Post pull request comment",
  description:
    "Post a comment on a pull request: PR-level, or inline with file+line (and startLine for multiline suggestion blocks). severity=BLOCKER additionally creates a follow-up task (on Cloud it also prefixes the text with '[BLOCKER]'). pending=true drafts the comment on Server/DC (rejected on Cloud — no draft support).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    text: z.string().min(1).max(32_000).describe("Comment text (markdown); wrap lines in a ```suggestion block for suggestions."),
    file: z.string().min(1).max(1024).optional().describe("File path for an inline comment (omit for PR-level)."),
    line: z.number().int().min(1).optional().describe("Line number for an inline comment (required with file)."),
    lineType: z
      .enum(["CONTEXT", "ADDED", "REMOVED"])
      .default("ADDED")
      .describe("Which side of the diff the anchored line belongs to."),
    startLine: z.number().int().min(1).optional().describe("First line of a multi-line comment/suggestion block."),
    severity: z.enum(["NORMAL", "BLOCKER"]).default("NORMAL").describe("BLOCKER additionally creates a follow-up task."),
    taskText: z.string().min(1).max(2000).optional().describe("Custom task text when severity=BLOCKER."),
    pending: z.boolean().default(false).describe("true = draft the comment (Server/DC only); publish it via bb_submit_pull_request_review."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return postPullRequestCommentCloud(args, ctx);
    const file = args["file"] as string | undefined;
    const line = args["line"] as number | undefined;
    if (file && line === undefined) {
      throw new ToolError(ERROR_CODES.VALIDATION, "Inline comments require both 'file' and 'line'.");
    }
    if (!file && (line !== undefined || args["startLine"] !== undefined)) {
      throw new ToolError(ERROR_CODES.VALIDATION, "'line'/'startLine' require 'file' (inline comment).");
    }

    const body: Record<string, unknown> = {
      text: args["text"] as string,
      severity: args["severity"] as string,
      pending: args["pending"] === true,
    };
    if (file) {
      const anchor: Record<string, unknown> = {
        path: file,
        line: line as number,
        lineType: args["lineType"] as string,
        fileType: "TO",
      };
      if (args["startLine"] !== undefined) anchor["startLine"] = args["startLine"] as number;
      body["anchor"] = anchor;
    }

    const payload = await ctx.provider.client.post<unknown>(`${prPath(args)}/comments`, { body });
    // POST /comments returns the comment object itself (GET wraps it in { comment }).
    const comment = asRecord(asRecord(payload)?.comment) ?? asRecord(payload) ?? {};
    const commentId = asNumber(comment.id);

    let taskCreated = false;
    if (args["severity"] === "BLOCKER" && commentId !== null) {
      await ctx.provider.client.post<unknown>("/rest/api/1.0/tasks", {
        body: {
          anchor: { id: commentId, type: "COMMENT" },
          text: (args["taskText"] as string | undefined) ?? "Follow-up required from a blocker comment.",
          state: "OPEN",
        },
      });
      taskCreated = true;
    }

    return {
      id: commentId,
      severity: asString(comment.severity) ?? (args["severity"] as string),
      state: asString(comment.state) ?? "OPEN",
      pending: comment.pending === true,
      taskCreated,
      text: truncateString(asString(comment.text) ?? (args["text"] as string), 200),
    };
  },
};

const updatePullRequestComment: ToolManifest = {
  name: "bb_update_pull_request_comment",
  title: "Update pull request comment",
  description:
    "Update a comment's text or severity, resolve/unresolve its thread (state=RESOLVED|OPEN), or reopen/close one of its tasks (taskId+taskState). Server/DC uses optimistic locking (re-fetch + one retry on 409); Cloud applies single PUTs and has no severity field (the '[BLOCKER]' text tag is the convention).",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    commentId: z.number().int().min(1).describe("Comment id to update."),
    text: z.string().min(1).max(32_000).optional().describe("New comment text."),
    severity: z.enum(["NORMAL", "BLOCKER"]).optional().describe("New severity (Server/DC only; echoed with a note on Cloud)."),
    state: z.enum(["OPEN", "RESOLVED"]).optional().describe("Thread state (RESOLVED resolves the thread)."),
    taskId: z.number().int().min(1).optional().describe("Task id to update (requires taskState)."),
    taskState: z.enum(["OPEN", "RESOLVED"]).optional().describe("New task state (requires taskId)."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return updatePullRequestCommentCloud(args, ctx);
    const commentId = args["commentId"] as number;

    const updated = await withOptimisticLock({
      fetchCurrent: async () => {
        const payload = await ctx.provider.client.get<unknown>(commentPath(args));
        // GET returns { comment } on most versions; tolerate an unwrapped body too.
        const comment = asRecord(asRecord(payload)?.comment) ?? asRecord(payload) ?? {};
        if (typeof comment.version !== "number") {
          throw new RestError(500, "UPSTREAM_ERROR", "Comment payload is missing a version field.");
        }
        return comment as Record<string, unknown> & { version: number };
      },
      apply: (current) => {
        const body: Record<string, unknown> = { version: current.version };
        if (args["text"] !== undefined) body["text"] = args["text"] as string;
        if (args["severity"] !== undefined) body["severity"] = args["severity"] as string;
        if (args["state"] !== undefined) body["state"] = args["state"] as string;
        return ctx.provider.client.put<unknown>(commentPath(args), { body });
      },
    });

    let taskUpdated: string | null = null;
    if (args["taskId"] !== undefined || args["taskState"] !== undefined) {
      const taskId = args["taskId"] as number | undefined;
      const taskState = args["taskState"] as string | undefined;
      if (taskId === undefined || taskState === undefined) {
        throw new ToolError(ERROR_CODES.VALIDATION, "taskId and taskState must be provided together.");
      }
      await ctx.provider.client.put<unknown>(`/rest/api/1.0/tasks/${taskId}`, { body: { state: taskState } });
      taskUpdated = String(taskId);
    }

    const raw = asRecord(updated);
    const record = asRecord(raw?.comment) ?? raw ?? {};
    return {
      id: asNumber(record.id) ?? commentId,
      state: asString(record.state) ?? "OPEN",
      severity: asString(record.severity) ?? "NORMAL",
      taskUpdated,
      text: truncateString(asString(record.text) ?? "", 200),
    };
  },
};

const submitPullRequestReview: ToolManifest = {
  name: "bb_submit_pull_request_review",
  title: "Submit pull request review",
  description:
    "Submit a review verdict (APPROVED | NEEDS_WORK | UNAPPROVED). Server/DC: best-effort publishing of pending drafts first, reviewer identity resolved automatically (userSlug → session user → activity consensus → single participant → userFilter). Cloud: reviews always act as the authenticated user (a mismatching userSlug is rejected), NEEDS_WORK maps to 'request changes', no pending drafts exist.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    pullRequestId: PR_ID_FIELD,
    verdict: z.enum(["APPROVED", "NEEDS_WORK", "UNAPPROVED"]).describe("Review verdict to submit."),
    userSlug: z.string().min(1).max(128).optional().describe("Reviewer slug; resolved automatically when omitted (must match the configured account on Cloud)."),
    userFilter: z.string().min(1).max(200).optional().describe("Fallback: disambiguate your user by name/email filter (Server/DC only)."),
  },
  providers: ["server", "cloud"],
  readOnly: false,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return submitPullRequestReviewCloud(args, ctx);
    const userSlug = await resolveReviewer(ctx, args);

    let publishedComments: number | null = null;
    let note: string | undefined;
    try {
      const publishResult = await ctx.provider.client.post<unknown>(`${prPath(args)}/comments/publish`, { body: {} });
      publishedComments = Array.isArray(publishResult) ? publishResult.length : null;
    } catch (err) {
      if (err instanceof RestError && (err.status === 400 || err.status === 404)) {
        note = "This instance has no publish endpoint for pending comments — publish drafts manually if needed.";
      }
    }

    const verdict = args["verdict"] as string;
    await ctx.provider.client.put<unknown>(`${prPath(args)}/participants/${userSlug}`, {
      body: { approved: verdict === "APPROVED", status: verdict },
    });

    return {
      pullRequestId: args["pullRequestId"],
      userSlug,
      verdict,
      approved: verdict === "APPROVED",
      publishedComments,
      ...(note ? { note } : {}),
    };
  },
};

async function resolveReviewer(ctx: ToolCallContext, args: Record<string, unknown>): Promise<string> {
  const explicit = args["userSlug"] as string | undefined;
  if (explicit) return explicit;

  // 1. Session user (available on some instance versions / SSO setups).
  try {
    const me = await ctx.provider.client.get<unknown>("/rest/api/1.0/users/current");
    const name = asString(asRecord(me)?.name);
    if (name) return name;
  } catch (err) {
    if (!(err instanceof RestError)) throw err;
    // 400/401/403/404 → fall through to the next strategy.
  }

  // 2. Exactly one PR participant.
  const pr = await ctx.provider.client.get<unknown>(prPath(args));
  const participants = (asRecord(pr)?.participants as unknown[] | undefined) ?? [];
  if (participants.length === 1) {
    const name = asString(asRecord(asRecord(participants[0])?.user)?.name);
    if (name) return name;
  }

  // 3. Authors of the PR's recent activities (the session's own actions leave
  //    the freshest entries; only when every recent author agrees).
  try {
    const activities = await ctx.provider.client.get<unknown>(`${prPath(args)}/activities`, {
      query: { limit: 10 },
    });
    const values = (asRecord(activities)?.values as unknown[] | undefined) ?? [];
    const names = new Set<string>();
    for (const entry of values) {
      const name = asString(asRecord(asRecord(entry)?.user)?.name);
      if (name) names.add(name);
    }
    if (names.size === 1) return names.values().next().value as string;
  } catch (err) {
    if (!(err instanceof RestError)) throw err;
    // Activities unavailable → fall through.
  }

  // 4. Explicit filter via the user search.
  const userFilter = args["userFilter"] as string | undefined;
  if (userFilter) {
    const payload = await ctx.provider.client.get<unknown>("/rest/api/1.0/users", {
      query: { filter: userFilter, limit: 25 },
    });
    const users = extractPageItems(payload);
    if (users.length === 1) {
      const name = asString(asRecord(users[0])?.name);
      if (name) return name;
    }
  }

  throw new ToolError(
    ERROR_CODES.VALIDATION,
    "Could not resolve the reviewer identity automatically — pass 'userSlug' explicitly.",
    { strategies: ["userSlug", "session user", "activity authors", "single PR participant", "userFilter"] },
  );
}

export const reviewWriteToolManifests: ToolManifest[] = [
  postPullRequestComment,
  updatePullRequestComment,
  submitPullRequestReview,
];
