#!/usr/bin/env tsx
/**
 * AltoRank MCP server, stdio.
 *
 *   npm run mcp                 # from apps/web
 *
 * Register in Claude Code:
 *   claude mcp add altorank -- npx tsx apps/web/scripts/mcp.ts
 *
 * The tools live in lib/mcp/server.ts; this file is the stdio transport
 * around them. The account tools reach /api/agent/v1 over HTTP with
 * ALTORANK_API_KEY through the same client the CLI uses.
 *
 * The hosted equivalent is app/api/mcp/route.ts: one URL any MCP client adds
 * as a connector, authenticated with OAuth or a bearer API key.
 *
 * stdio discipline: stdout carries JSON-RPC frames and nothing else. Anything
 * written to stdout that is not a frame corrupts the session, so all logging
 * goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAltorankServer } from "../lib/mcp/server";
import { agentRequest } from "./lib/agent-client";

// No top-level await: apps/web is CJS (no "type": "module"), and tsx compiles
// .ts here to the cjs output format, which rejects it.
async function main(): Promise<void> {
  const server = createAltorankServer((path, opts) => agentRequest(path, opts));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `altorank mcp server ready (stdio); account tools ${process.env.ALTORANK_API_KEY ? "armed" : "need ALTORANK_API_KEY"}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
