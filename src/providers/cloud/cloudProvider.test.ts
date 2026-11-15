import { describe, expect, it } from "vitest";
import { CLOUD_API_BASE, cloudAuthHeaders, cloudBaseUrl, createCloudProvider } from "./cloudProvider.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  BITBUCKET_PROVIDER: "cloud",
} as const;

describe("createCloudProvider", () => {
  it("returns an available provider with Cloud pagination style and the public base", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_CLOUD_EMAIL: "dev@example.com", BITBUCKET_CLOUD_API_TOKEN: "t" });
    const provider = createCloudProvider(config);
    expect(provider.id).toBe("cloud");
    expect(provider.available).toBe(true);
    expect(provider.pagination).toEqual({
      limitParam: "pagelen",
      startParam: "page",
      oneBasedPage: true,
      pageMode: "cursor",
    });
    expect(provider.client).toBeDefined();
    expect(cloudBaseUrl(config)).toBe(CLOUD_API_BASE);
  });

  it("honours BITBUCKET_URL as an API-base override", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_URL: "https://bitbucket.example.com", BITBUCKET_TOKEN: "t" });
    expect(cloudBaseUrl(config)).toBe("https://bitbucket.example.com");
  });
});

describe("cloudAuthHeaders", () => {
  it("prefers the email + API token pair (Basic)", () => {
    const { config } = loadConfig({
      ...BASE_CONFIG,
      BITBUCKET_CLOUD_EMAIL: "dev@example.com",
      BITBUCKET_CLOUD_API_TOKEN: "api-tok",
      BITBUCKET_TOKEN: "bearer-tok",
    });
    expect(cloudAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev@example.com:api-tok").toString("base64")}`,
    });
  });

  it("falls back to Bearer for a plain token", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_TOKEN: "oauth-tok" });
    expect(cloudAuthHeaders(config)).toEqual({ Authorization: "Bearer oauth-tok" });
  });

  it("falls back to Basic from username + password (app password)", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_USERNAME: "dev1", BITBUCKET_PASSWORD: "tok2" });
    expect(cloudAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev1:tok2").toString("base64")}`,
    });
  });

  it("returns no auth header without credentials", () => {
    expect(cloudAuthHeaders(loadConfig({}).config)).toEqual({});
  });
});
