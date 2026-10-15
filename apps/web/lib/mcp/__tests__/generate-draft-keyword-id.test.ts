// altorank_generate_draft passes keyword_id through to POST /articles/generate.
//
// The route briefs a draft from the keyword row when it gets an id, and by an
// ilike term match when it does not. The tool's schema had no keyword_id, so
// the SDK stripped it and every agent draft took the term-match path and was
// saved unlinked from its keyword.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { ok } from "@/lib/agent/envelope";
import { createAltorankServer, type AgentCall } from "../server";

async function connect(call: AgentCall) {
  const server = createAltorankServer(call);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const KEYWORD = "22222222-2222-4222-8222-222222222222";

describe("altorank_generate_draft", () => {
  it("declares keyword_id in its input schema", async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "altorank_generate_draft");
    expect(tool?.inputSchema.properties).toHaveProperty("keyword_id");
  });

  it("sends keyword_id to the generate route", async () => {
    const call = vi.fn(async () => ok({ article_id: "a" }, "poll"));
    const client = await connect(call as unknown as AgentCall);
    await client.callTool({
      name: "altorank_generate_draft",
      arguments: { workspace_id: WORKSPACE, keyword: "crm for agencies", keyword_id: KEYWORD, idempotency_key: "k1" },
    });
    expect(call).toHaveBeenCalledWith(
      "/articles/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ workspace_id: WORKSPACE, keyword: "crm for agencies", keyword_id: KEYWORD }),
      }),
    );
  });
});
