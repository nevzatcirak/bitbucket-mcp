import { describe, expect, it } from "vitest";
import { hasAuth, loadConfig, parseCustomHeaders, requireCompleteConfig } from "./config.js";

const FULL_ENV = {
  BITBUCKET_URL: "https://bitbucket.example.com/",
  BITBUCKET_PROVIDER: "server",
  BITBUCKET_TOKEN: "tok-1",
  BITBUCKET_READ_ONLY: "true",
  BITBUCKET_CUSTOM_HEADERS: "X-Trace: abc, X-Tenant : t1",
};

describe("loadConfig", () => {
  it("loads a complete configuration and normalizes the URL", () => {
    const { config, problems } = loadConfig(FULL_ENV);
    expect(problems).toEqual([]);
    expect(config.url).toBe("https://bitbucket.example.com");
    expect(config.provider).toBe("server");
    expect(config.token).toBe("tok-1");
    expect(config.readOnly).toBe(true);
    expect(config.customHeaders).toEqual({ "X-Trace": "abc", "X-Tenant": "t1" });
  });

  it("defaults the provider to server when unset", () => {
    const { config, problems } = loadConfig({ BITBUCKET_URL: "https://bitbucket.example.com", BITBUCKET_TOKEN: "t" });
    expect(config.provider).toBe("server");
    expect(problems).toEqual([]);
  });

  it("reports a problem for an invalid provider but still defaults to server", () => {
    const { config, problems } = loadConfig({
      BITBUCKET_URL: "https://bitbucket.example.com",
      BITBUCKET_TOKEN: "t",
      BITBUCKET_PROVIDER: "gitea",
    });
    expect(config.provider).toBe("server");
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("BITBUCKET_PROVIDER");
    expect(problems[0].message).toContain("gitea");
  });

  it("accepts username+password auth without a token", () => {
    const { config, problems } = loadConfig({
      BITBUCKET_URL: "https://bitbucket.example.com",
      BITBUCKET_USERNAME: "dev1",
      BITBUCKET_PASSWORD: "pass1",
    });
    expect(problems).toEqual([]);
    expect(hasAuth(config)).toBe(true);
    expect(config.token).toBeUndefined();
  });

  it("reports a problem when no credential set is complete", () => {
    const { config, problems } = loadConfig({ BITBUCKET_URL: "https://bitbucket.example.com" });
    expect(hasAuth(config)).toBe(false);
    expect(problems.some((p) => p.field === "BITBUCKET_TOKEN")).toBe(true);
  });

  it("reports problems for a missing or invalid URL", () => {
    const missing = loadConfig({ BITBUCKET_TOKEN: "t" });
    expect(missing.config.url).toBeUndefined();
    expect(missing.problems.some((p) => p.field === "BITBUCKET_URL")).toBe(true);

    const invalid = loadConfig({ BITBUCKET_URL: "ftp://bitbucket.example.com", BITBUCKET_TOKEN: "t" });
    expect(invalid.problems.some((p) => p.message.includes("http:// or https://"))).toBe(true);

    const unparsable = loadConfig({ BITBUCKET_URL: "::not a url::", BITBUCKET_TOKEN: "t" });
    expect(unparsable.problems.some((p) => p.field === "BITBUCKET_URL")).toBe(true);
  });
});

describe("loadConfig (cloud)", () => {
  it("needs no BITBUCKET_URL and accepts the email+api-token credential pair", () => {
    const { config, problems } = loadConfig({
      BITBUCKET_PROVIDER: "cloud",
      BITBUCKET_CLOUD_EMAIL: "dev@example.com",
      BITBUCKET_CLOUD_API_TOKEN: "tok-2",
    });
    expect(problems).toEqual([]);
    expect(config.provider).toBe("cloud");
    expect(config.url).toBeUndefined();
    expect(config.cloudEmail).toBe("dev@example.com");
    expect(config.cloudApiToken).toBe("tok-2");
  });

  it("accepts a bearer token or an app-password pair on cloud", () => {
    const bearer = loadConfig({ BITBUCKET_PROVIDER: "cloud", BITBUCKET_TOKEN: "oauth" });
    expect(bearer.problems).toEqual([]);

    const appPassword = loadConfig({
      BITBUCKET_PROVIDER: "cloud",
      BITBUCKET_USERNAME: "dev@example.com",
      BITBUCKET_PASSWORD: "app-pass",
    });
    expect(appPassword.problems).toEqual([]);
  });

  it("reports a problem when no cloud credential set is complete", () => {
    const { problems } = loadConfig({ BITBUCKET_PROVIDER: "cloud" });
    expect(problems.some((p) => p.field === "BITBUCKET_CLOUD_EMAIL")).toBe(true);
  });

  it("reports a problem when multiple cloud credential sets are mixed", () => {
    const { problems } = loadConfig({
      BITBUCKET_PROVIDER: "cloud",
      BITBUCKET_TOKEN: "oauth",
      BITBUCKET_CLOUD_EMAIL: "dev@example.com",
      BITBUCKET_CLOUD_API_TOKEN: "tok-2",
    });
    expect(problems.some((p) => p.field === "BITBUCKET_TOKEN" && p.message.includes("exactly one"))).toBe(true);
  });

  it("requireCompleteConfig stays empty on cloud without BITBUCKET_URL (public default base)", () => {
    const { config } = loadConfig({
      BITBUCKET_PROVIDER: "cloud",
      BITBUCKET_CLOUD_EMAIL: "dev@example.com",
      BITBUCKET_CLOUD_API_TOKEN: "tok-2",
    });
    expect(requireCompleteConfig(config)).toEqual([]);
  });
});

describe("requireCompleteConfig", () => {
  it("is empty for a complete config", () => {
    const { config } = loadConfig(FULL_ENV);
    expect(requireCompleteConfig(config)).toEqual([]);
  });

  it("flags missing URL and auth on the request path", () => {
    const { config } = loadConfig({});
    const problems = requireCompleteConfig(config);
    expect(problems.map((p) => p.field).sort()).toEqual(["BITBUCKET_TOKEN", "BITBUCKET_URL"]);
  });
});

describe("parseCustomHeaders", () => {
  it("parses comma-separated Name: Value pairs", () => {
    const { headers, problems } = parseCustomHeaders("A: 1, B : 2");
    expect(headers).toEqual({ A: "1", B: "2" });
    expect(problems).toEqual([]);
  });

  it("reports malformed entries", () => {
    const { headers, problems } = parseCustomHeaders("no-colon, A:, : 3, B: ok");
    expect(headers).toEqual({ B: "ok" });
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.field === "BITBUCKET_CUSTOM_HEADERS")).toBe(true);
  });

  it("returns empty for unset values", () => {
    const { headers, problems } = parseCustomHeaders(undefined);
    expect(headers).toEqual({});
    expect(problems).toEqual([]);
  });
});
