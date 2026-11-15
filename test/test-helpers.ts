/**
 * Shared test helpers: a ToolCallContext backed by a stubbed global fetch
 * that captures every outgoing request. Used by Server/DC tool tests.
 */

import { vi } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { createServerProvider } from "../src/providers/server/serverProvider.js";
import type { ToolCallContext } from "../src/tools/registry.js";

export interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

export type Responder = (
  url: URL,
  init: RequestInit,
) => { status?: number; body: unknown };

export interface ServerCtxHandle {
  ctx: ToolCallContext;
  captured: CapturedRequest[];
  restore: () => void;
}

export function makeServerCtx(responder: Responder): ServerCtxHandle {
  const captured: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    captured.push({ url, init: init ?? {} });
    const result = responder(url, init ?? {});
    return new Response(typeof result.body === "string" ? result.body : JSON.stringify(result.body), {
      status: result.status ?? 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { config } = loadConfig({
    BITBUCKET_URL: "https://bitbucket.example.com",
    BITBUCKET_TOKEN: "test-token",
    BITBUCKET_PROVIDER: "server",
  });
  const ctx: ToolCallContext = { config, provider: createServerProvider(config) };

  return {
    ctx,
    captured,
    restore: () => vi.unstubAllGlobals(),
  };
}

/** Build a Server/DC collection envelope. */
export function envelope(values: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    size: values.length,
    limit: 25,
    start: 0,
    isLastPage: true,
    nextPageStart: null,
    values,
    ...extra,
  };
}
