import { describe, expect, it } from "vitest";
import { serverAuthHeaders, createServerProvider, SERVER_API_PREFIX } from "./serverProvider.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  BITBUCKET_URL: "https://bitbucket.example.com",
  BITBUCKET_PROVIDER: "server",
} as const;

describe("serverAuthHeaders", () => {
  it("prefers token auth as Bearer", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_TOKEN: "pat-1" });
    expect(serverAuthHeaders(config)).toEqual({ Authorization: "Bearer pat-1" });
  });

  it("falls back to Basic auth from credentials", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_USERNAME: "dev1", BITBUCKET_PASSWORD: "pw1" });
    expect(serverAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev1:pw1").toString("base64")}`,
    });
  });

  it("returns no headers when unauthenticated", () => {
    const { config } = loadConfig(BASE_CONFIG);
    expect(serverAuthHeaders(config)).toEqual({});
  });
});

describe("createServerProvider", () => {
  it("exposes an available server provider with Server pagination style", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_TOKEN: "t" });
    const provider = createServerProvider(config);
    expect(provider.id).toBe("server");
    expect(provider.available).toBe(true);
    expect(provider.pagination).toEqual({ limitParam: "limit", startParam: "start", oneBasedPage: false });
    expect(provider.client).toBeDefined();
  });

  it("documents the Server/DC REST prefix", () => {
    expect(SERVER_API_PREFIX).toBe("/rest/api/1.0");
  });
});
