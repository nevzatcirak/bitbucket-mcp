/**
 * Bitbucket Cloud adapter (REST 2.0).
 *
 * Wire details:
 * - REST base: BITBUCKET_URL or the public default https://api.bitbucket.org/2.0.
 * - Auth (exactly one):
 *     1. BITBUCKET_CLOUD_EMAIL + BITBUCKET_CLOUD_API_TOKEN -> Basic base64(email:token)
 *     2. BITBUCKET_TOKEN                                   -> Bearer (OAuth / workspace token)
 *     3. BITBUCKET_USERNAME + BITBUCKET_PASSWORD           -> Basic (app password)
 * - Pagination: `pagelen` + one-based `page`; collections return a `next` URL
 *   that maps to PageMeta.nextCursor (see CLOUD_PAGINATION).
 */

import { asRecord } from "../../core/json.js";
import type { BitbucketConfig } from "../../core/config.js";
import type { ProviderContext } from "../../core/provider.js";
import { CLOUD_PAGINATION } from "../../core/provider.js";
import { RestClient } from "../../core/restClient.js";

/** Public REST 2.0 base used when BITBUCKET_URL is not set for the cloud provider. */
export const CLOUD_API_BASE = "https://api.bitbucket.org/2.0";

export function cloudBaseUrl(config: BitbucketConfig): string {
  return config.url ?? CLOUD_API_BASE;
}

export function cloudAuthHeaders(config: BitbucketConfig): Record<string, string> {
  if (config.cloudEmail && config.cloudApiToken) {
    const basic = Buffer.from(`${config.cloudEmail}:${config.cloudApiToken}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
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
    available: true,
    client: new RestClient(cloudBaseUrl(config), {
      authHeaders: cloudAuthHeaders(config),
      defaultHeaders: { ...config.customHeaders, Accept: "application/json" },
    }),
    pagination: CLOUD_PAGINATION,
  };
}

/** Extract the workspace slug from a Cloud repository object ("ws/slug" full_name). */
export function workspaceOf(repo: unknown): string | null {
  const fullName = asStringOf(repo, "full_name");
  if (!fullName) return null;
  return fullName.split("/")[0] ?? null;
}

function asStringOf(record: unknown, field: string): string | null {
  const value = asRecord(record)?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}
