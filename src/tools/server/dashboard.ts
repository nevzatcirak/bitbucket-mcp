/**
 * Server/DC dashboard tools: pull requests the authenticated user is
 * involved in (dashboard, role+state filters) and the raw inbox.
 */

import { z } from "zod";
import type { ToolManifest } from "../registry.js";
import { apiPath, listPage, pagedResult, unwrapPullRequestItem } from "./common.js";
import { projectCard, defineCardFields } from "../../core/compactCard.js";
import { epochToIso } from "./common.js";

const PR_FIELDS = [
  ["id", "id"],
  ["title", "title", 120],
  ["state", "state"],
  ["author", "author.user.displayName"],
  ["fromBranch", "fromRef.displayId"],
  ["toBranch", "toRef.displayId"],
  ["project", "fromRef.repository.project.key"],
  ["repo", "fromRef.repository.slug"],
  ["updated", "updatedDate"],
] as const;

const DASHBOARD_FIELDS = defineCardFields(PR_FIELDS);
const INBOX_FIELDS = defineCardFields([
  ["id", "id"],
  ["title", "title", 120],
  ["state", "state"],
  ["author", "author.user.displayName"],
  ["project", "fromRef.repository.project.key"],
  ["repo", "fromRef.repository.slug"],
  ["updated", "updatedDate"],
]);

function cardFor(pr: unknown, fields: ReturnType<typeof defineCardFields>): Record<string, unknown> {
  const card = projectCard(pr, fields);
  card["updated"] = epochToIso(card["updated"]);
  return card;
}

const STATE_FIELD = z
  .enum(["OPEN", "MERGED", "DECLINED", "ALL"])
  .default("OPEN")
  .describe("Pull request state filter.");

const getDashboardPullRequests: ToolManifest = {
  name: "bb_get_dashboard_pull_requests",
  title: "Get dashboard pull requests",
  description:
    "List the pull requests of the authenticated user from the dashboard, filterable by role (AUTHOR|REVIEWER|PARTICIPANT) and state.",
  inputSchema: {
    role: z
      .enum(["AUTHOR", "REVIEWER", "PARTICIPANT"])
      .default("REVIEWER")
      .describe("Your role in the pull requests."),
    state: STATE_FIELD,
    limit: z.number().int().min(1).max(1000).default(25).describe("Page size (1-1000)."),
    start: z.number().int().min(0).default(0).describe("Zero-based page offset."),
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    const { items, page } = await listPage(ctx, apiPath("/dashboard/pull-requests"), args, {
      role: args["role"] as string,
      state: args["state"] as string,
      withAttributes: false,
      withProperties: false,
    });
    return pagedResult(items.map((item) => cardFor(unwrapPullRequestItem(item), DASHBOARD_FIELDS)), page);
  },
};

const getInboxPullRequests: ToolManifest = {
  name: "bb_get_inbox_pull_requests",
  title: "Get inbox pull requests",
  description:
    "List the pull requests in the authenticated user's inbox (things that need attention), newest activity first.",
  inputSchema: {
    limit: z.number().int().min(1).max(1000).default(25).describe("Page size (1-1000)."),
    start: z.number().int().min(0).default(0).describe("Zero-based page offset."),
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
    const { items, page } = await listPage(ctx, apiPath("/inbox/pull-requests"), args, {
      withAttributes: false,
      withProperties: false,
    });
    return pagedResult(items.map((item) => cardFor(unwrapPullRequestItem(item), INBOX_FIELDS)), page);
  },
};

export const dashboardToolManifests: ToolManifest[] = [getDashboardPullRequests, getInboxPullRequests];
