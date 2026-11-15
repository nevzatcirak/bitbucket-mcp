/**
 * Bitbucket Cloud adapter — SEAM ONLY, not implemented yet.
 *
 * Phase 0 keeps the interface in place so that phase 1 can fill it in
 * without touching the core: the provider is returned as `available: false`
 * and any tool call against it resolves to a structured PROVIDER_UNAVAILABLE
 * error instead of crashing the server.
 *
 * Planned wire details (documented, not wired):
 * - REST base: the Cloud 2.0 API root behind BITBUCKET_URL.
 * - Auth:      API token + username -> `Authorization: Basic base64(user:token)`.
 * - Pagination: `pagelen` + one-based `page` (see CLOUD_PAGINATION).
 */

import type { BitbucketConfig } from "../../core/config.js";
import type { ProviderContext } from "../../core/provider.js";
import { CLOUD_PAGINATION } from "../../core/provider.js";
import { RestClient } from "../../core/restClient.js";

export function cloudAuthHeaders(config: BitbucketConfig): Record<string, string> {
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  if (config.username && config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export function createCloudProvider(config: BitbucketConfig): ProviderContext {
  return {
    id: "cloud",
    available: false,
    client: new RestClient(config.url ?? "", {
      authHeaders: cloudAuthHeaders(config),
      defaultHeaders: config.customHeaders,
    }),
    pagination: CLOUD_PAGINATION,
  };
}
