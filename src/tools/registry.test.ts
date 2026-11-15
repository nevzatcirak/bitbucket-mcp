import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../core/config.js";
import { createServerProvider } from "../providers/server/serverProvider.js";
import { createCloudProvider } from "../providers/cloud/cloudProvider.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";
import { registerAllTools, selectManifests, toolManifests } from "./registry.js";

interface RegisteredTool {
  name: string;
  config: { title: string; description: string; inputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: unknown },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, { name, config, handler });
  }
}

function serverCtx(): ToolCallContext {
  const { config } = loadConfig({ BITBUCKET_URL: "https://bitbucket.example.com", BITBUCKET_TOKEN: "t" });
  return { config, provider: createServerProvider(config) };
}

const READ_ONLY_ENV = { BITBUCKET_URL: "https://bitbucket.example.com", BITBUCKET_TOKEN: "t", BITBUCKET_READ_ONLY: "true" };

const MANIFESTS: ToolManifest[] = [
  {
    name: "bb_get_repo",
    title: "Get repository",
    description: "Reads one repository",
    inputSchema: {},
    providers: ["server", "cloud"],
    readOnly: true,
    handler: async () => ({ ok: true }),
  },
  {
    name: "bb_server_only",
    title: "Server-only",
    description: "Only on Server/DC",
    inputSchema: {},
    providers: ["server"],
    readOnly: true,
    handler: async () => ({ ok: true }),
  },
  {
    name: "bb_write_thing",
    title: "Write something",
    description: "A write tool",
    inputSchema: {},
    providers: ["server", "cloud"],
    readOnly: false,
    handler: async () => ({ ok: true }),
  },
];

describe("selectManifests", () => {
  it("omits tools whose manifest does not list the active provider", () => {
    const names = selectManifests(MANIFESTS, "cloud", false).map((m) => m.name);
    expect(names).toEqual(["bb_get_repo", "bb_write_thing"]);
  });

  it("omits write tools in read-only mode", () => {
    const names = selectManifests(MANIFESTS, "server", true).map((m) => m.name);
    expect(names).toEqual(["bb_get_repo", "bb_server_only"]);
  });
});

describe("registerAllTools", () => {
  it("registers only the advertised set and wires handlers", async () => {
    const fake = new FakeServer();
    const advertised = registerAllTools(fake as unknown as McpServer, serverCtx(), MANIFESTS);

    expect(advertised).toEqual(["bb_get_repo", "bb_server_only", "bb_write_thing"]);
    expect(fake.tools.size).toBe(3);

    const handler = fake.tools.get("bb_get_repo")!.handler;
    await expect(handler({})).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("hides provider-unsupported and write tools under read-only cloud", () => {
    const fake = new FakeServer();
    const { config } = loadConfig(READ_ONLY_ENV);
    const advertised = registerAllTools(
      fake as unknown as McpServer,
      { config, provider: createCloudProvider(config) },
      MANIFESTS,
    );
    expect(advertised).toEqual(["bb_get_repo"]);
  });

  it("returns structured PROVIDER_UNAVAILABLE for tools on an unimplemented provider", async () => {
    const fake = new FakeServer();
    const unavailableCtx: ToolCallContext = {
      config: loadConfig({ BITBUCKET_URL: "https://bitbucket.example.com", BITBUCKET_TOKEN: "t" }).config,
      provider: { id: "server", available: false, client: {} as never, pagination: {} as never },
    };
    const serverOnly: ToolManifest = {
      name: "bb_server_only",
      title: "Server-only",
      description: "Server",
      inputSchema: {},
      providers: ["server"],
      readOnly: true,
      handler: async () => ({ ok: true }),
    };
    registerAllTools(fake as unknown as McpServer, unavailableCtx, [serverOnly]);

    const result = await fake.tools.get("bb_server_only")!.handler({});
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify((result as { content: [{ text: string }] }).content[0].text)).toContain("PROVIDER_UNAVAILABLE");
  });

  it("converts handler throws into structured errors", async () => {
    const fake = new FakeServer();
    const failing: ToolManifest = {
      name: "bb_failing",
      title: "Failing",
      description: "Throws",
      inputSchema: {},
      providers: ["server"],
      readOnly: true,
      handler: async () => {
        throw new Error("boom");
      },
    };
    registerAllTools(fake as unknown as McpServer, serverCtx(), [failing]);

    const result = (await fake.tools.get("bb_failing")!.handler({})) as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "boom" } });
  });
});

const WRITE_TOOL_NAMES = new Set([
  "bb_create_branch",
  "bb_delete_branch",
  "bb_create_pull_request",
  "bb_update_pull_request",
  "bb_can_merge_pull_request",
  "bb_merge_pull_request",
  "bb_decline_pull_request",
  "bb_reopen_pull_request",
  "bb_post_pull_request_comment",
  "bb_update_pull_request_comment",
  "bb_submit_pull_request_review",
]);

describe("toolManifests", () => {
  it("ships 29 manifests (18 read + 11 write) with valid provider flags", () => {
    expect(toolManifests).toHaveLength(29);
    for (const manifest of toolManifests) {
      expect(manifest.providers).toContain("server");
      expect(manifest.providers.every((p) => p === "server" || p === "cloud")).toBe(true);
    }
    expect(toolManifests.filter((m) => m.readOnly)).toHaveLength(18);
    expect(toolManifests.filter((m) => !m.readOnly).map((m) => m.name).sort()).toEqual(
      [...WRITE_TOOL_NAMES].sort(),
    );
  });

  it("advertises 27 tools on cloud (17 read + 10 write); inbox and reopen stay server-only", () => {
    const cloudTools = selectManifests(toolManifests, "cloud", false).map((m) => m.name);
    expect(cloudTools).toHaveLength(27);
    expect(cloudTools).not.toContain("bb_get_inbox_pull_requests");
    expect(cloudTools).not.toContain("bb_reopen_pull_request");
    const cloudReadOnly = selectManifests(toolManifests, "cloud", true).map((m) => m.name);
    expect(cloudReadOnly).toHaveLength(17);
  });

  it("keeps expected tool names", () => {
    const names = toolManifests.map((m) => m.name).sort();
    expect(names).toEqual(
      [
        "bb_browse_repository",
        "bb_create_branch",
        "bb_create_pull_request",
        "bb_can_merge_pull_request",
        "bb_decline_pull_request",
        "bb_delete_branch",
        "bb_get_dashboard_pull_requests",
        "bb_get_file_content",
        "bb_get_inbox_pull_requests",
        "bb_get_pr_comments_and_actions",
        "bb_get_project",
        "bb_get_pull_request",
        "bb_get_pull_request_builds",
        "bb_get_pull_request_changes",
        "bb_get_pull_request_diff",
        "bb_get_projects",
        "bb_get_repositories",
        "bb_get_repository",
        "bb_get_user",
        "bb_list_branches",
        "bb_list_commits",
        "bb_list_pull_requests",
        "bb_merge_pull_request",
        "bb_post_pull_request_comment",
        "bb_reopen_pull_request",
        "bb_search_code",
        "bb_submit_pull_request_review",
        "bb_update_pull_request",
        "bb_update_pull_request_comment",
      ].sort(),
    );
  });
});
