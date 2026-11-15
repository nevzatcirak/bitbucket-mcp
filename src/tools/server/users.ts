/**
 * Server/DC user lookup: by slug or by name/email search.
 */

import { z } from "zod";
import { defineCardFields, projectCard } from "../../core/compactCard.js";
import type { ToolManifest } from "../registry.js";
import { RestError } from "../../core/restClient.js";
import { apiPath, listPage, pagedResult } from "./common.js";

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
    "Look up a Bitbucket user. Pass userSlug for a direct lookup, or filter to search by name/email prefix (returns up to 25 matches).",
  inputSchema: {
    userSlug: z.string().min(1).max(128).optional().describe("Direct lookup by user slug, e.g. 'jdoe'."),
    filter: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Search users by name or email fragment (server-side filter, returns matches)."),
  },
  providers: ["server"],
  readOnly: true,
  handler: async (args, ctx) => {
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
