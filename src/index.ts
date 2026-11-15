#!/usr/bin/env node
/**
 * bitbucket-mcp entry point: stdio MCP server for Bitbucket Server / DC and
 * Bitbucket Cloud (REST 2.0).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createCloudProvider } from "./providers/cloud/cloudProvider.js";
import { createServerProvider } from "./providers/server/serverProvider.js";
import { registerAllTools } from "./tools/registry.js";
import { log, registerSecrets } from "./util/logger.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — MCP server for Bitbucket Server / Data Center and Bitbucket Cloud.

Environment:
  BITBUCKET_PROVIDER         "server" (default) | "cloud"
  BITBUCKET_URL              Server/DC base URL, e.g. https://bitbucket.example.com (required for server;
                             optional for cloud — defaults to https://api.bitbucket.org/2.0)
  BITBUCKET_TOKEN            Server/DC PAT -> Bearer; Cloud OAuth/workspace token -> Bearer
  BITBUCKET_CLOUD_EMAIL      Cloud: Atlassian account email (with BITBUCKET_CLOUD_API_TOKEN, Basic auth)
  BITBUCKET_CLOUD_API_TOKEN  Cloud: API token (https://id.atlassian.com/manage-profile/security/api-tokens)
  BITBUCKET_USERNAME         Credential auth, used with BITBUCKET_PASSWORD (Basic; Cloud: app password)
  BITBUCKET_PASSWORD         See BITBUCKET_USERNAME
  BITBUCKET_READ_ONLY        "true" hides all write tools
  BITBUCKET_CUSTOM_HEADERS   Comma-separated "Name: Value" pairs

Usage:
  bitbucket-mcp [--version] [--help]
`;

function handleCliArgs(argv: readonly string[]): boolean {
  if (argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (handleCliArgs(process.argv.slice(2))) return;

  const { config, problems } = loadConfig();
  registerSecrets(config.token, config.password, config.cloudApiToken);
  for (const problem of problems) {
    log(`config: ${problem.field}: ${problem.message}${problem.hint ? ` (hint: ${problem.hint})` : ""}`);
  }

  const provider = config.provider === "cloud" ? createCloudProvider(config) : createServerProvider(config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // Declare the tools capability up front so tools/list returns { tools: [] }
    // even before the first tool is registered (otherwise the SDK answers
    // "Method not found" for tools/list on an empty registry).
    { capabilities: { tools: {} } },
  );
  const advertised = registerAllTools(server, { config, provider });
  log(
    `${SERVER_NAME} v${SERVER_VERSION} ready (provider=${provider.id}, tools advertised: ${advertised.length}, read-only=${config.readOnly})`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
