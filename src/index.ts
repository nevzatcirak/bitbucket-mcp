#!/usr/bin/env node
/**
 * bitbucket-mcp entry point: stdio MCP server for Bitbucket Server / DC
 * (Cloud adapter slot ready, not yet implemented).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createCloudProvider } from "./providers/cloud/cloudProvider.js";
import { createServerProvider } from "./providers/server/serverProvider.js";
import { registerAllTools } from "./tools/registry.js";
import { log, registerSecrets } from "./util/logger.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — MCP server for Bitbucket Server / Data Center (Cloud adapter coming).

Environment:
  BITBUCKET_URL              Base URL, e.g. https://bitbucket.example.com (required)
  BITBUCKET_PROVIDER         "server" (default) | "cloud"
  BITBUCKET_TOKEN            Token auth (Server/DC PAT -> Bearer)
  BITBUCKET_USERNAME         Credential auth, used with BITBUCKET_PASSWORD (Basic)
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
  registerSecrets(config.token, config.password);
  for (const problem of problems) {
    log(`config: ${problem.field}: ${problem.message}${problem.hint ? ` (hint: ${problem.hint})` : ""}`);
  }

  const provider = config.provider === "cloud" ? createCloudProvider(config) : createServerProvider(config);
  if (!provider.available) {
    log(
      `provider "${provider.id}" is not implemented yet; advertised cloud tools will return ` +
        `PROVIDER_UNAVAILABLE errors until the Cloud adapter ships.`,
    );
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
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
