/**
 * User lookup for both providers: by slug (Cloud: username/uuid/account_id)
 * or by name/email search (Server/DC only — Cloud has no user search, a
 * slug-less call returns the authenticated account).
 */

import { z } from "zod";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import type { ToolManifest } from "../registry.js";
import { RestError } from "../../core/restClient.js";
import { apiPath, listPage, pagedResult } from "./common.js";
import { getUserCloud } from "../cloud/reads.js";

const USER_FIELDS = defineCardFields([
  ["name", "name"],
  ["displayName", "displayName"],
  ["emailAddress", "emailAddress"],
  ["active", "active"],
]);

const getUser: ToolManifest = {
  name: "bb_get_user",
  title: "Get user",
  description:
    "Look up a Bitbucket user. Pass userSlug for a direct lookup, or filter to search by name/email prefix (Server/DC only; on Cloud a call without userSlug returns the authenticated account).",
  inputSchema: {
    userSlug: z.string().min(1).max(128).optional().describe("Direct lookup by user slug (on Cloud: username, uuid or account_id)."),
    filter: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Search users by name or email fragment (Server/DC only)."),
  },
  providers: ["server", "cloud"],
  readOnly: true,
  handler: async (args, ctx) => {
    if (ctx.provider.id === "cloud") return getUserCloud(args, ctx);
    const slug = args["userSlug"] as string | undefined;
    const filter = args["filter"] as string | undefined;
    if (!slug && !filter) {
      throw new RestError(400, "VALIDATION", "Provide either 'userSlug' or 'filter'.");
    }
    if (slug) {
      const payload = await ctx.provider.client.get<unknown>(apiPath(`/users/${slug}`));
      return projectCard(payload, USER_FIELDS);
    }
    const { items, page } = await listPage(ctx, apiPath("/users"), { limit: 25, start: 0 }, { filter });
    return pagedResult(items.map((u) => projectCard(u, USER_FIELDS)), page);
  },
};

export const userToolManifests: ToolManifest[] = [getUser];
