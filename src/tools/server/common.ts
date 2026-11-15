/**
 * Shared plumbing for Server/DC tool handlers: REST path prefixing,
 * envelope-to-PageMeta normalization and compact paged results.
 */

import { DEFAULT_PAGE_LIMIT, extractPageItems, pageMeta, pageQuery } from "../../core/pagination.js";
import type { PageMeta, PageRequest } from "../../core/pagination.js";
import { RestError } from "../../core/restClient.js";
import { getPath, asRecord } from "../../core/json.js";
import type { ToolCallContext } from "../registry.js";

/** REST API path prefix for Bitbucket Server / Data Center. */
export const API = "/rest/api/1.0";

export function apiPath(path: string): string {
  return `${API}${path}`;
}

export interface PagedResult {
  items: unknown[];
  page: PageMeta;
}

/**
 * Fetch one page from a Server/DC collection endpoint and normalize the
 * envelope. Cursor-mode providers (Cloud) are rejected until phase 3.
 */
export async function listPage(
  ctx: ToolCallContext,
  path: string,
  request: PageRequest,
  extraQuery?: Record<string, string | number | boolean | undefined>,
): Promise<PagedResult> {
  const style = ctx.provider.pagination;
  if (style.pageMode !== "number") {
    throw new RestError(
      0,
      "NOT_IMPLEMENTED",
      `Pagination mode "${style.pageMode}" is not implemented yet for this provider.`,
    );
  }
  const query = { ...pageQuery(request, style), ...extraQuery };
  const payload = await ctx.provider.client.get<unknown>(path, { query });
  const items = extractPageItems(payload);
  const page = pageMeta(payload, request.start ?? 0, request.limit ?? DEFAULT_PAGE_LIMIT, items.length);
  return { items, page };
}

/** Emit the standard compact paged-result body; `warning` reports page-scope caveats. */
export function pagedResult<T>(
  items: readonly T[],
  page: PageMeta,
  warning?: string,
): Record<string, unknown> {
  return {
    items,
    page: {
      size: page.size,
      limit: page.limit,
      start: page.start,
      isLastPage: page.isLastPage,
      nextPageStart: page.nextPageStart,
      // Cursor-mode providers (Cloud) surface the follow-up page here.
      ...(page.nextCursor != null ? { nextCursor: page.nextCursor } : {}),
      ...(warning ? { warning } : {}),
    },
  };
}

/** Convert Bitbucket epoch-millis timestamps to ISO strings (null-safe). */
export function epochToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

/** Timestamp card fields are epoch millis on the wire; patch them to ISO. */
export function patchEpochFields(card: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    card[field] = epochToIso(card[field]);
  }
}

/** Pull the wrapped payload out of inbox/dashboard items ({ pullRequest: {...} }). */
export function unwrapPullRequestItem(item: unknown): Record<string, unknown> | null {
  return asRecord(getPath(item, "pullRequest"));
}
