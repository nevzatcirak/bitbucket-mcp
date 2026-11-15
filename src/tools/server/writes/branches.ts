/**
 * Server/DC branch write tools: create + delete (with default-branch
 * protection). Uses the bundled branch-admin REST service.
 */

import { z } from "zod";
import { asRecord, asString } from "../../../core/json.js";
import { ERROR_CODES, ToolError } from "../../../core/errors.js";
import type { ToolCallContext, ToolManifest } from "../../registry.js";
import { apiPath, listPage } from "../common.js";

const BRANCH_ADMIN = "/rest/branch-admin/1.0";

const PROJECT_FIELD = z.string().min(1).max(128).describe("Project key.");
const REPO_FIELD = z.string().min(1).max(128).describe("Repository slug.");

async function isDefaultBranch(ctx: ToolCallContext, projectKey: string, repositorySlug: string, branch: string): Promise<boolean> {
  const { items } = await listPage(ctx, apiPath(`/projects/${projectKey}/repos/${repositorySlug}/branches`), { limit: 25, start: 0 }, {
    details: true,
    filter: branch,
  });
  return items.some((b) => {
    const displayId = asString(asRecord(b)?.displayId);
    return displayId === branch && asRecord(b)?.isDefault === true;
  });
}

const createBranch: ToolManifest = {
  name: "bb_create_branch",
  title: "Create branch",
  description:
    "Create a branch in a repository, optionally from a specific start point (branch name, tag or commit). Refuses nothing server-side; default-branch protection applies only to deletion.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    name: z.string().min(1).max(256).describe("New branch name, e.g. 'feature/mcp-test'."),
    startPoint: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Branch/tag/commit to start from (default: the repository's default branch)."),
  },
  providers: ["server"],
  readOnly: false,
  handler: async (args, ctx) => {
    const body: Record<string, unknown> = { name: args["name"] as string };
    if (args["startPoint"]) body["startPoint"] = args["startPoint"] as string;
    const payload = await ctx.provider.client.post<unknown>(
      `${BRANCH_ADMIN}/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/branches`,
      { body },
    );
    const record = asRecord(payload);
    return {
      created: true,
      displayId: asString(record?.displayId) ?? (args["name"] as string),
      startPoint: args["startPoint"] ?? null,
    };
  },
};

const deleteBranch: ToolManifest = {
  name: "bb_delete_branch",
  title: "Delete branch",
  description:
    "Delete a branch. Refuses with a structured DELETE_REFUSED error when the target is the repository's default branch.",
  inputSchema: {
    projectKey: PROJECT_FIELD,
    repositorySlug: REPO_FIELD,
    name: z.string().min(1).max(256).describe("Branch to delete."),
  },
  providers: ["server"],
  readOnly: false,
  handler: async (args, ctx) => {
    const name = args["name"] as string;
    if (await isDefaultBranch(ctx, args["projectKey"] as string, args["repositorySlug"] as string, name)) {
      throw new ToolError(
        ERROR_CODES.DELETE_REFUSED,
        `Refusing to delete '${name}' — it is the default branch of ${args["projectKey"] as string}/${args["repositorySlug"] as string}.`,
        { branch: name, defaultBranch: true },
      );
    }
    await ctx.provider.client.delete<unknown>(
      `${BRANCH_ADMIN}/projects/${args["projectKey"] as string}/repos/${args["repositorySlug"] as string}/branches`,
      { query: { name } },
    );
    return { deleted: true, name };
  },
};

export const branchWriteToolManifests: ToolManifest[] = [createBranch, deleteBranch];
