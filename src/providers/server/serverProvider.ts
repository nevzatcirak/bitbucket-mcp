/**
 * Bitbucket Server / Data Center adapter.
 *
 * Auth: personal access token -> `Authorization: Bearer <token>`,
 *       username + password      -> `Authorization: Basic base64(user:pass)`.
 * REST: `<BITBUCKET_URL>/rest/api/1.0`, zero-based `start`/`limit` pagination.
 */

import type { BitbucketConfig } from "../../core/config.js";
import type { ProviderContext } from "../../core/provider.js";
import { SERVER_PAGINATION } from "../../core/provider.js";
import { RestClient } from "../../core/restClient.js";

/** REST API path prefix for Bitbucket Server / Data Center. */
export const SERVER_API_PREFIX = "/rest/api/1.0";

export function serverAuthHeaders(config: BitbucketConfig): Record<string, string> {
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  if (config.username && config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export function createServerProvider(config: BitbucketConfig): ProviderContext {
  return {
    id: "server",
    available: true,
    client: new RestClient(config.url ?? "", {
      authHeaders: serverAuthHeaders(config),
      defaultHeaders: config.customHeaders,
    }),
    pagination: SERVER_PAGINATION,
  };
}
