#!/usr/bin/env tsx
/**
 * altorank - a thin CLI over /api/agent/v1.
 *
 *   npm run cli -- auth whoami
 *   npm run cli -- workspaces list
 *   npm run cli -- keywords list --workspace <id> [--status new] [--limit 50]
 *   npm run cli -- keywords suggest --workspace <id> [--seeds "a,b"] [--limit 50]
 *   npm run cli -- articles list --workspace <id> [--status review]
 *   npm run cli -- articles get <id>
 *   npm run cli -- articles content <id> [--format markdown|html|tiptap]
 *   npm run cli -- articles generate --workspace <id> --keyword "…" [--title "…"] [--article <id>] [--allow-overage]
 *   npm run cli -- readiness check --workspace <id> | --domain example.com
 *   npm run cli -- usage
 *
 * Auth: --api-key > ALTORANK_API_KEY > ~/.altorank/config.json. Base URL from
 * ALTORANK_BASE_URL (default https://app.altorank.co).
 *
 * Every command prints one JSON envelope, errors included, and exits 1 when
 * ok is false. Nothing here publishes, approves or deletes: the API has no
 * such calls, so neither does this.
 */

import { agentRequest, resolveApiKey, resolveBaseUrl, CONFIG_PATH } from "./lib/agent-client";
import { fail, ok, type Envelope } from "../lib/agent/envelope";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: string | boolean | undefined): number | undefined => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const USAGE =
  "Usage: altorank <auth whoami|status> | <workspaces list|get ID> | <keywords list|suggest> | " +
  "<articles list|get ID|content ID|generate> | <readiness check> | <usage>. See scripts/cli.ts for flags.";

async function run(argv: string[]): Promise<Envelope> {
  const { positional, flags } = parseArgs(argv);
  const [group, command, id] = positional;
  const apiKey = str(flags["api-key"]);
  const workspace = str(flags.workspace) ?? str(flags["workspace-id"]);

  const needWorkspace = (): Envelope | null =>
    workspace ? null : fail("invalid_request", "--workspace is required.", "Run `altorank workspaces list` and pass one of the ids as --workspace.");

  switch (`${group} ${command ?? ""}`.trim()) {
    case "auth whoami":
      return agentRequest("/auth/whoami", { apiKey });

    case "auth status": {
      const { key, source } = resolveApiKey(apiKey);
      const base = resolveBaseUrl();
      if (!key) {
        return fail(
          "unauthorized",
          "No API key found.",
          `Set ALTORANK_API_KEY, pass --api-key, or write {"api_key": "…"} to ${CONFIG_PATH}. Create a key at ${base}/settings/api-keys.`,
        );
      }
      const who = await agentRequest<{ account?: { name?: string } | null }>("/auth/whoami", { apiKey });
      return who.ok
        ? ok(
            { source, base_url: base, key_prefix: key.slice(0, 20), account: who.data.account ?? null },
            `Authenticated via ${source}. Proceed with workspaces list.`,
          )
        : who;
    }

    case "workspaces list":
      return agentRequest("/workspaces", { apiKey });
    case "workspaces get":
      if (!id) return fail("invalid_request", "Workspace id is required.", "altorank workspaces get <id>");
      return agentRequest(`/workspaces/${encodeURIComponent(id)}`, { apiKey });

    case "keywords list":
      return needWorkspace() ?? agentRequest("/keywords", {
        apiKey,
        query: { workspace_id: workspace, status: str(flags.status), limit: num(flags.limit) },
      });
    case "keywords suggest":
      return needWorkspace() ?? agentRequest("/keywords/suggest", {
        apiKey,
        method: "POST",
        body: {
          workspace_id: workspace,
          seeds: str(flags.seeds)?.split(",").map((s) => s.trim()).filter(Boolean),
          limit: num(flags.limit),
        },
      });

    case "articles list":
      return needWorkspace() ?? agentRequest("/articles", {
        apiKey,
        query: { workspace_id: workspace, status: str(flags.status), limit: num(flags.limit) },
      });
    case "articles get":
      if (!id) return fail("invalid_request", "Article id is required.", "altorank articles get <id>");
      return agentRequest(`/articles/${encodeURIComponent(id)}`, { apiKey });
    case "articles content":
      if (!id) return fail("invalid_request", "Article id is required.", "altorank articles content <id> [--format markdown|html|tiptap]");
      return agentRequest(`/articles/${encodeURIComponent(id)}/content`, { apiKey, query: { format: str(flags.format) } });
    case "articles generate": {
      const missing = needWorkspace();
      if (missing) return missing;
      const keyword = str(flags.keyword);
      if (!keyword) return fail("invalid_request", "--keyword is required.", "Pass the keyword the draft should target, agreed with the human.");
      return agentRequest("/articles/generate", {
        apiKey,
        method: "POST",
        body: {
          workspace_id: workspace,
          keyword,
          title: str(flags.title),
          article_id: str(flags.article),
          allow_overage: flags["allow-overage"] === true,
        },
      });
    }

    case "readiness check":
      if (!workspace && !str(flags.domain)) {
        return fail("invalid_request", "--workspace or --domain is required.", "altorank readiness check --workspace <id>, or --domain example.com");
      }
      return agentRequest("/readiness", { apiKey, query: { workspace_id: workspace, domain: str(flags.domain) } });

    case "usage":
      return agentRequest("/usage", { apiKey });

    default:
      return fail("invalid_request", `Unknown command: ${positional.join(" ") || "(none)"}.`, USAGE);
  }
}

// No top-level await: apps/web compiles scripts as CJS (see scripts/mcp.ts).
run(process.argv.slice(2))
  .then((envelope) => {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    process.exit(envelope.ok ? 0 : 1);
  })
  .catch((err) => {
    const envelope = fail("internal_error", err instanceof Error ? err.message : String(err), "Unexpected CLI failure. Report the message.");
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    process.exit(1);
  });
