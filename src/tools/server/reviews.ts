/**
 * Server/DC review reading: comments + action items (tasks) for a pull
 * request, including severity (BLOCKER) and thread resolution state.
 * Resolved threads are hidden by default.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, truncateString } from "../../core/json.js";
import type { ToolManifest } from "../registry.js";
import { apiPath, listPage, pagedResult } from "./common.js";

interface ThreadCard {
  [key: string]: unknown;
}

function commentCard(comment: Record<string, unknown> | null, maxTextChars: number): ThreadCard | null {
  if (!comment) return null;
  return {
    id: asNumber(comment.id),
    author: asString(asRecord(comment.author)?.displayName) ?? asString(asRecord(comment.author)?.name),
    severity: asString(comment.severity) ?? "NORMAL",
    state: asString(comment.state) ?? "OPEN",
    text: truncateString(asString(comment.text) ?? "", maxTextChars),
  };
}

function taskCards(comment: Record<string, unknown> | null, maxTextChars: number): Record<string, unknown>[] {
  const tasks = (comment?.tasks as unknown[] | undefined) ?? [];
  return tasks.map((task) => {
    const t = asRecord(task);
    return {
      id: asNumber(t?.id),
      text: truncateString(asString(t?.text) ?? "", maxTextChars),
      state: asString(t?.state) ?? "OPEN",
    };
  });
}

function parentIdOf(comment: Record<string, unknown>): number | null {
  return asNumber(asRecord(comment.parent)?.id);
}

const getPrCommentsAndActions: ToolManifest = {
  name: "bb_get_pr_comments_and_actions",
  title: "Get pull request comments and action items",
  description:
    "Read the review discussion of a pull request as threads: comment severity (NORMAL/BLOCKER), thread state (OPEN/RESOLVED) and action tasks. Resolved threads are hidden unless includeResolved=true.",
  inputSchema: {
    projectKey: z.string().min(1).max(128).describe("Project key."),
    repositorySlug: z.string().min(1).max(128).describe("Repository slug."),
    pullRequestId: z.number().int().min(1).describe("Pull request id."),
    severity: z
      .enum(["ALL", "NORMAL", "BLOCKER"])
      .default("ALL")
      .describe("Only return threads with this severity."),
    includeResolved: z
      .boolean()
      .default(false)
      .describe("Include threads that are resolved (thread itself or any reply). Default: hidden."),
    includeReplies: z.boolean().default(true).describe("Include reply comments inside each thread."),
    maxTextChars: z.number().int().min(50).max(5000).default(400).describe("Maximum characters per comment text."),
    limit: z.number().int().min(1).max(1000).default(100).describe("Comments per page (max 1000)."),
    start: z.number().int().min(0).default(0).describe("Zero-based page offset."),
  },
  providers: ["server"],
  readOnly: true,
  // Note: the comments endpoint rejects avatarSize=0 ("must be positive"), so no avatar params are sent.
  handler: async (args, ctx) => {
    // Use the activities endpoint: it carries the full discussion (comments,
    // severities, tasks, resolutions) without file-anchor requirements that
    // the bare comments endpoint enforces on some Server versions.
    const { items, page } = await listPage(
      ctx,
      apiPath(
        `/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/pull-requests/${args["pullRequestId"] as number}/activities`,
      ),
      args,
    );
    const severityFilter = args["severity"] as string;
    const includeResolved = args["includeResolved"] as boolean;
    const includeReplies = args["includeReplies"] as boolean;
    const maxTextChars = args["maxTextChars"] as number;

    const comments = items
      .map((item) => asRecord(asRecord(item)?.comment))
      .filter((c): c is Record<string, unknown> => c !== null);

    const topLevels = comments.filter((c) => c.parent === undefined || c.parent === null);

    const isThreadResolved = (thread: Record<string, unknown>): boolean => {
      if (asString(thread.state) === "RESOLVED") return true;
      return comments
        .filter((c) => parentIdOf(c) === asNumber(thread.id))
        .some((reply) => asString(reply.state) === "RESOLVED");
    };
    const matchesSeverity = (comment: Record<string, unknown>): boolean =>
      severityFilter === "ALL" || asString(comment.severity) === severityFilter;

    const threads: ThreadCard[] = [];
    let blockers = 0;
    let openTasks = 0;

    for (const topLevel of topLevels) {
      if (!includeResolved && isThreadResolved(topLevel)) continue;
      if (!matchesSeverity(topLevel)) continue;
      const card = commentCard(topLevel, maxTextChars) ?? {};
      card["tasks"] = taskCards(topLevel, maxTextChars);
      if (includeReplies) {
        card["replies"] = comments
          .filter((c) => parentIdOf(c) === asNumber(topLevel.id))
          .map((reply) => commentCard(reply, maxTextChars));
      } else {
        card["replies"] = [];
      }
      if (asString(topLevel.severity) === "BLOCKER") blockers += 1;
      openTasks += (card["tasks"] as Record<string, unknown>[]).filter((t) => t.state === "OPEN").length;
      threads.push(card);
    }

    return {
      summary: { threads: threads.length, blockers, openTasks },
      ...pagedResult(threads, page),
    };
  },
};

export const reviewToolManifests: ToolManifest[] = [getPrCommentsAndActions];
