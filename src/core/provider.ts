/**
 * Provider seam: the server supports Bitbucket Server / Data Center today and
 * keeps a ready (unimplemented) adapter slot for Bitbucket Cloud.
 *
 * Every tool manifest declares which providers it supports; tools whose
 * manifest does not list the active provider are never advertised to the
 * MCP client.
 */

import type { RestClient } from "./restClient.js";

export type ProviderId = "server" | "cloud";

/** How a provider paginates responses. */
export type PageMode = "number" | "cursor";

/**
 * How a provider expresses pagination as query parameters.
 * - Server/DC: `?limit=25&start=0` (zero-based offset, pageMode "number").
 * - Cloud 2.0: `?pagelen=25&page=1` (one-based page number, pageMode "number")
 *              with cursor-style follow-up via the `next` URL in the response
 *              (pageMode "cursor" — seam ready, implementation in phase 3).
 */
export interface PaginationStyle {
  readonly limitParam: string;
  readonly startParam: string;
  /** True when the start parameter is a one-based page number instead of an offset. */
  readonly oneBasedPage: boolean;
  /**
   * "number": follow-up pages are addressed by numeric offset/page params.
   * "cursor": follow-up pages come from an opaque cursor (e.g. the Cloud
   * `next` URL). Consumers must not assume nextPageStart is meaningful when
   * pageMode is "cursor" — use nextCursor instead.
   */
  readonly pageMode: PageMode;
}

export const SERVER_PAGINATION: PaginationStyle = {
  limitParam: "limit",
  startParam: "start",
  oneBasedPage: false,
  pageMode: "number",
};

export const CLOUD_PAGINATION: PaginationStyle = {
  limitParam: "pagelen",
  startParam: "page",
  oneBasedPage: true,
  pageMode: "cursor",
};

/** Runtime handle a tool uses to talk to the active deployment. */
export interface ProviderContext {
  readonly id: ProviderId;
  /**
   * False when the adapter exists as a seam but is not implemented yet
   * (Cloud, as of phase 0). Calls against an unavailable provider return a
   * structured PROVIDER_UNAVAILABLE error instead of crashing.
   */
  readonly available: boolean;
  readonly client: RestClient;
  readonly pagination: PaginationStyle;
}
