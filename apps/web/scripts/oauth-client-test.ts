// A real MCP client doing the whole OAuth dance against the hosted endpoint:
// 401 → discovery → dynamic registration → PKCE → consent (in a browser) →
// code on localhost:9999 → token → initialize → tools/list → altorank_whoami.
import http from "node:http";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const SERVER = process.env.MCP_URL ?? "http://localhost:3170/api/mcp";
const OUT = process.env.OUT ?? "/tmp/oauth-client-result.json";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

let info: OAuthClientInformationFull | undefined;
let tokens: OAuthTokens | undefined;
let verifier = "";
let authUrl = "";

const provider: OAuthClientProvider = {
  get redirectUrl() { return "http://localhost:9999/cb"; },
  get clientMetadata() {
    return {
      client_name: "SDK test client",
      redirect_uris: ["http://localhost:9999/cb"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },
  clientInformation: () => info,
  saveClientInformation: (i) => { info = i; log("registered client_id", i.client_id); },
  tokens: () => tokens,
  saveTokens: (t) => { tokens = t; log("tokens saved: scope=", t.scope, "expires_in=", t.expires_in); },
  redirectToAuthorization: (url) => { authUrl = url.toString(); log("AUTHORIZE_URL", authUrl); },
  saveCodeVerifier: (v) => { verifier = v; },
  codeVerifier: () => verifier,
};

async function main() {
  const t1 = new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider });
  const c1 = new Client({ name: "sdk-test", version: "0.0.1" });
  try {
    await c1.connect(t1);
    log("connected without auth?! unexpected");
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    log("got UnauthorizedError as expected; waiting for the browser to approve");
  }
  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost:9999");
      if (u.pathname !== "/cb") { res.statusCode = 404; return res.end(); }
      const c = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.end(c ? "ok, you can close this" : `error: ${err}`);
      srv.close();
      c ? resolve(c) : reject(new Error(`callback error ${err}`));
    });
    srv.listen(9999, () => log("listening on 9999 for the redirect"));
    setTimeout(() => { srv.close(); reject(new Error("timeout waiting for redirect")); }, 1_800_000);
  });
  log("code received");
  await t1.finishAuth(code);
  const t2 = new StreamableHTTPClientTransport(new URL(SERVER), { authProvider: provider });
  const c2 = new Client({ name: "sdk-test", version: "0.0.1" });
  await c2.connect(t2);
  log("connected; server:", JSON.stringify(c2.getServerVersion()));
  const tools = await c2.listTools();
  log("tools:", tools.tools.length);
  const who = await c2.callTool({ name: "altorank_whoami", arguments: {} });
  const env = JSON.parse((who.content as { text: string }[])[0].text);
  log("whoami ok:", env.ok, "account:", env.data?.account?.name, "key:", env.data?.key?.name, "scopes:", JSON.stringify(env.data?.key?.scopes));
  writeFileSync(OUT, JSON.stringify({ tools: tools.tools.map((t) => t.name), whoami: env.data?.key, scope: tokens?.scope }, null, 2));
  await c2.close();
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
