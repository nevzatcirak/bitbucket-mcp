import { describe, expect, it } from "vitest";
import { cloudAuthHeaders, createCloudProvider } from "./cloudProvider.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  BITBUCKET_URL: "https://bitbucket.example.com",
  BITBUCKET_PROVIDER: "cloud",
} as const;

describe("createCloudProvider", () => {
  it("returns an unavailable seam provider with Cloud pagination style", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_TOKEN: "t" });
    const provider = createCloudProvider(config);
    expect(provider.id).toBe("cloud");
    expect(provider.available).toBe(false);
    expect(provider.pagination).toEqual({ limitParam: "pagelen", startParam: "page", oneBasedPage: true });
    expect(provider.client).toBeDefined();
  });
});

describe("cloudAuthHeaders", () => {
  it("prefers token auth", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_TOKEN: "api-tok" });
    expect(cloudAuthHeaders(config)).toEqual({ Authorization: "Bearer api-tok" });
  });

  it("falls back to Basic auth from credentials", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, BITBUCKET_USERNAME: "dev1", BITBUCKET_PASSWORD: "tok2" });
    expect(cloudAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev1:tok2").toString("base64")}`,
    });
  });
});
