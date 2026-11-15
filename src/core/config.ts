import type { ProviderId } from "./provider.js";

/**
 * Environment-driven configuration. `loadConfig` never throws: anything wrong
 * is reported as a ConfigProblem so the server can still start (and tools can
 * return structured CONFIG_MISSING errors) instead of crashing.
 */

export interface BitbucketConfig {
  /** Base URL, trailing slash stripped. Undefined when missing/invalid. */
  url?: string;
  provider: ProviderId;
  token?: string;
  username?: string;
  password?: string;
  /** Cloud: Atlassian account email for `Basic base64(email:api-token)` auth. */
  cloudEmail?: string;
  /** Cloud: API token (paired with cloudEmail) or workspace access token. */
  cloudApiToken?: string;
  readOnly: boolean;
  customHeaders: Record<string, string>;
}

export interface ConfigProblem {
  field: string;
  message: string;
  hint?: string;
}

export interface LoadedConfig {
  config: BitbucketConfig;
  problems: ConfigProblem[];
}

const PROVIDERS: readonly string[] = ["server", "cloud"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const problems: ConfigProblem[] = [];

  const provider = parseProvider(env.BITBUCKET_PROVIDER, problems);
  const url = normalizeUrl(env.BITBUCKET_URL, problems, provider === "server");
  const token = optional(env.BITBUCKET_TOKEN);
  const username = optional(env.BITBUCKET_USERNAME);
  const password = optional(env.BITBUCKET_PASSWORD);
  const cloudEmail = optional(env.BITBUCKET_CLOUD_EMAIL);
  const cloudApiToken = optional(env.BITBUCKET_CLOUD_API_TOKEN);

  if (provider === "cloud") {
    // Cloud auth: (cloudEmail + cloudApiToken) Basic, or token Bearer, or
    // username + password (app password) Basic.
    const hasCloudTokenPair = Boolean(cloudEmail && cloudApiToken);
    if (!token && !hasCloudTokenPair && !(username && password)) {
      problems.push({
        field: "BITBUCKET_CLOUD_EMAIL",
        message:
          "Cloud auth requires either BITBUCKET_CLOUD_EMAIL + BITBUCKET_CLOUD_API_TOKEN (Basic) or BITBUCKET_TOKEN (OAuth bearer).",
        hint: "API tokens are created at the Atlassian account level; the email is the account email.",
      });
    }
    if (token && (hasCloudTokenPair || (username && password))) {
      problems.push({
        field: "BITBUCKET_TOKEN",
        message: "Multiple credential sets are set for the cloud provider — set exactly one (token, or email+api token, or username+password).",
      });
    }
  } else if (!token && !(username && password)) {
    problems.push({
      field: "BITBUCKET_TOKEN",
      message: "Either BITBUCKET_TOKEN or both BITBUCKET_USERNAME and BITBUCKET_PASSWORD must be set.",
      hint: "Server/DC: personal access token (Bearer) or credentials (Basic). Cloud: API token + username.",
    });
  }

  const { headers, problems: headerProblems } = parseCustomHeaders(env.BITBUCKET_CUSTOM_HEADERS);
  problems.push(...headerProblems);

  return {
    config: {
      url: url ?? undefined,
      provider,
      token: token ?? undefined,
      username: username ?? undefined,
      password: password ?? undefined,
      cloudEmail: cloudEmail ?? undefined,
      cloudApiToken: cloudApiToken ?? undefined,
      readOnly: isTruthy(env.BITBUCKET_READ_ONLY),
      customHeaders: headers,
    },
    problems,
  };
}

/**
 * Request-path validation. Tools call this before doing work so a misconfigured
 * server answers with a structured error rather than a fetch failure.
 */
export function requireCompleteConfig(config: BitbucketConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (config.provider === "server") {
    if (!config.url) {
      problems.push({
        field: "BITBUCKET_URL",
        message: "BITBUCKET_URL is required.",
        hint: "e.g. https://bitbucket.example.com",
      });
    }
    if (!config.token && !(config.username && config.password)) {
      problems.push({
        field: "BITBUCKET_TOKEN",
        message: "Either BITBUCKET_TOKEN or both BITBUCKET_USERNAME and BITBUCKET_PASSWORD must be set.",
      });
    }
  }
  // Cloud: BITBUCKET_URL is optional (defaults to the public 2.0 API base).
  // Auth completeness is validated in loadConfig via ConfigProblem.
  return problems;
}

/** True when the config carries at least one complete credential set. */
export function hasAuth(config: BitbucketConfig): boolean {
  return Boolean(config.token || (config.username && config.password));
}

export function isTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function parseCustomHeaders(raw: string | undefined): {
  headers: Record<string, string>;
  problems: ConfigProblem[];
} {
  const headers: Record<string, string> = {};
  const problems: ConfigProblem[] = [];
  const value = raw?.trim();
  if (!value) return { headers, problems };

  for (const part of value.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) {
      problems.push({
        field: "BITBUCKET_CUSTOM_HEADERS",
        message: `Invalid header entry '${entry}' — expected "Name: Value" pairs separated by commas.`,
      });
      continue;
    }
    const name = entry.slice(0, sep).trim();
    const headerValue = entry.slice(sep + 1).trim();
    if (!name || !headerValue) {
      problems.push({
        field: "BITBUCKET_CUSTOM_HEADERS",
        message: `Invalid header entry '${entry}' — header name and value must both be non-empty.`,
      });
      continue;
    }
    headers[name] = headerValue;
  }
  return { headers, problems };
}

function optional(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

function normalizeUrl(raw: string | undefined, problems: ConfigProblem[], required: boolean): string | null {
  const v = optional(raw);
  if (!v) {
    if (required) {
      problems.push({
        field: "BITBUCKET_URL",
        message: "BITBUCKET_URL is required.",
        hint: "e.g. https://bitbucket.example.com",
      });
    }
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    problems.push({ field: "BITBUCKET_URL", message: `'${v}' is not a valid URL.` });
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push({ field: "BITBUCKET_URL", message: "URL must start with http:// or https://." });
    return null;
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseProvider(raw: string | undefined, problems: ConfigProblem[]): ProviderId {
  const v = raw?.trim().toLowerCase();
  if (!v) return "server";
  if (PROVIDERS.includes(v)) return v as ProviderId;
  problems.push({
    field: "BITBUCKET_PROVIDER",
    message: `Invalid provider '${raw}' — expected one of: ${PROVIDERS.join(", ")}.`,
  });
  return "server";
}
