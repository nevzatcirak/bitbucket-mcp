/**
 * Pagination helpers shared by all providers.
 *
 * The wire envelope is provider-specific but normalized here:
 * - Server/DC: { size, limit, start, isLastPage, nextPageStart?, values: [...] }
 * - Cloud 2.0: { size, page, pagelen, next?, values: [...] }
 *
 * Tools always receive a normalized PageMeta with `isLastPage` and
 * `nextPageStart` so MCP clients can page with a single convention.
 */

import { asNumber, asRecord } from "./json.js";
import type { PaginationStyle } from "./provider.js";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 1000;

export interface PageRequest {
  start?: number;
  limit?: number;
}

/** Normalized page descriptor returned alongside every list tool result. */
export interface PageMeta {
  readonly size: number;
  readonly limit: number;
  readonly start: number;
  readonly isLastPage: boolean;
  readonly nextPageStart: number | null;
}

/** Clamp + translate a PageRequest into the provider's query parameter names. */
export function pageQuery(request: PageRequest, style: PaginationStyle): Record<string, number> {
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const start = Math.max(0, request.start ?? 0);
  if (style.oneBasedPage) {
    return { [style.limitParam]: limit, [style.startParam]: Math.floor(start / limit) + 1 };
  }
  return { [style.limitParam]: limit, [style.startParam]: start };
}

/**
 * Normalize a raw provider page envelope into PageMeta. Missing fields fall
 * back to the request defaults and the number of items actually returned.
 */
export function pageMeta(
  payload: unknown,
  fallbackStart: number,
  fallbackLimit: number,
  returnedCount: number,
): PageMeta {
  const record = asRecord(payload);
  const size = asNumber(record?.size) ?? returnedCount;
  const limit = asNumber(record?.limit) ?? fallbackLimit;
  const start = asNumber(record?.start) ?? fallbackStart;

  const explicitIsLast = typeof record?.isLastPage === "boolean" ? record.isLastPage : null;
  const total = asNumber(record?.total);
  const isLastPage = explicitIsLast ?? (total !== null ? start + size >= total : true);

  const explicitNext = asNumber(record?.nextPageStart);
  const nextPageStart = explicitNext ?? (isLastPage ? null : start + size);

  return { size, limit, start, isLastPage, nextPageStart };
}

/** Pull the item array out of a page envelope across known key names. */
export function extractPageItems(payload: unknown, keys: readonly string[] = ["values"]): unknown[] {
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
