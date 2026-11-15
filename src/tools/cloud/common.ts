/**
 * Shared plumbing for Bitbucket Cloud tool handlers: cursor-pagination
 * normalization and follow-up page extraction.
 *
 * Cloud collections use `pagelen` + one-based `page`; the envelope's `next`
 * URL embeds the follow-up page number, surfaced to MCP clients as
 * PageMeta.nextCursor / nextPageStart (a page number on Cloud, not an offset).
 */

import { asNumber, asRecord, asString } from "../../core/json.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, extractPageItems, pageMeta } from "../../core/pagination.js";
import type { PageMeta } from "../../core/pagination.js";
import type { ToolArgs, ToolCallContext } from "../registry.js";
import { pagedResult } from "../server/common.js";

/** Extract the one-based page number from a Cloud `next` URL. */
export function nextPageFromUrl(value: unknown): number | null {
  const raw = asString(value);
  if (!raw) return null;
  const parsed = (() => {
    try {
      return new URL(raw) as URL;
    } catch {
      return null;
    }
  })();
  const pageRaw = parsed ? parsed.searchParams.get("page") : /[?&]page=(\d+)/.exec(raw)?.[1] ?? null;
  const page = pageRaw === null ? Number.NaN : Number.parseInt(pageRaw, 10);
  return Number.isInteger(page) && page > 0 ? page : null;
}

/**
 * Fetch one page from a Cloud collection endpoint (`pagelen` + `page`).
 * `args.page` (1-based, optional) addresses the follow-up page reported by
 * PageMeta.nextCursor/nextPageStart on the previous call. `args.limit`
 * maps to `pagelen` (clamped to Cloud's 1..MAX_PAGE_LIMIT range).
 */
export async function listPageCloud(
  ctx: ToolCallContext,
  path: string,
  args: ToolArgs,
  extraQuery?: Record<string, string | number | boolean | undefined>,
): Promise<{ items: unknown[]; page: PageMeta }> {
  const requestedLimit = asNumber(args["limit"]);
  const limit = Math.min(Math.max(requestedLimit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const requestedPage = asNumber(args["page"]);
  const page = Math.max(requestedPage ?? 1, 1);
  const query = { pagelen: limit, page, ...extraQuery };
  const payload = await ctx.provider.client.get<unknown>(path, { query });
  const items = extractPageItems(payload);
  const nextPage = nextPageFromUrl(asRecord(payload)?.next);
  const meta = pageMeta(payload, 0, limit, items.length);
  return {
    items,
    page: {
      ...meta,
      // On Cloud the "start" of the next page is the next page NUMBER.
      start: page,
      isLastPage: nextPage === null,
      nextPageStart: nextPage,
      nextCursor: nextPage === null ? null : String(nextPage),
    },
  };
}

/** Repo-scoped Cloud path prefix, e.g. /repositories/WS/slug. */
export function repoBase(ctx: ToolCallContext, projectKey: unknown, repositorySlug: unknown): string {
  void ctx;
  return `/repositories/${String(projectKey)}/${String(repositorySlug)}`;
}

/** Convert a ref name (may contain slashes) to a single URL path segment. */
export function refSegment(ref: string): string {
  return encodeURIComponent(ref);
}

export { pagedResult };
