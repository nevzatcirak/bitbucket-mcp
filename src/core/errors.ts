/**
 * Structured MCP tool results. Every tool returns plain JSON via `mcpText`
 * or a structured error via `mcpError` — a tool handler never throws past
 * the registry, so the server process never crashes on a tool failure.
 */

import { RestError } from "./restClient.js";

export interface TextContent {
  type: "text";
  text: string;
}

/** Index signature keeps this structurally assignable to the SDK's CallToolResult. */
export interface McpToolResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
}

export const ERROR_CODES = {
  CONFIG_MISSING: "CONFIG_MISSING",
  READ_ONLY: "READ_ONLY",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  AUTH_FAILED: "AUTH_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION: "VALIDATION",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export function mcpText(result: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function mcpError(code: string, message: string, details?: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
    isError: true,
  };
}

export function toMcpError(err: unknown): McpToolResult {
  if (err instanceof RestError) {
    return mcpError(err.code, err.message, err.details);
  }
  if (err instanceof Error) {
    return mcpError(ERROR_CODES.INTERNAL_ERROR, err.message);
  }
  return mcpError(ERROR_CODES.INTERNAL_ERROR, String(err));
}
