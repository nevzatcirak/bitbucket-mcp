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

function cloudCtx(): ToolCallContext {
  const { config } = loadConfig({
    BITBUCKET_URL: "https://bitbucket.example.com",
    BITBUCKET_TOKEN: "t",
    BITBUCKET_PROVIDER: "cloud",
  });
  return { config, provider: createCloudProvider(config) };
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
    const cloudOnly: ToolManifest = {
      name: "bb_cloud_only",
      title: "Cloud-only",
      description: "Cloud",
      inputSchema: {},
      providers: ["cloud"],
      readOnly: true,
      handler: async () => ({ ok: true }),
    };
    registerAllTools(fake as unknown as McpServer, cloudCtx(), [cloudOnly]);

    const result = await fake.tools.get("bb_cloud_only")!.handler({});
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

describe("toolManifests", () => {
  it("is empty in phase 0", () => {
    expect(toolManifests).toEqual([]);
  });
});
