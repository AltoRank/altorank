#!/usr/bin/env tsx
/**
 * altorank - a thin CLI over /api/agent/v1.
 *
 *   npm run cli -- auth whoami
 *   npm run cli -- workspaces list
 *   npm run cli -- keywords list --workspace <id> [--status new] [--limit 50]
 *   npm run cli -- keywords suggest --workspace <id> [--seeds "a,b"] [--limit 50]
 *   npm run cli -- keywords export --workspace <id> [--format csv|json] [--status planned]
 *   npm run cli -- keywords bulk-reschedule --workspace <id> --ids a,b --shift-days 7 | --json '{"items":[{"keyword_id":"…","date":"2026-10-01"}]}'
 *   npm run cli -- keywords bulk-remove --workspace <id> --ids a,b
 *   npm run cli -- articles list --workspace <id> [--status review]
 *   npm run cli -- articles get <id>
 *   npm run cli -- articles content <id> [--format markdown|html|tiptap]
 *   npm run cli -- articles generate --workspace <id> --keyword "…" [--title "…"] [--article <id>] [--allow-overage]
 *   npm run cli -- articles replace <id> --find "…" --replace "…" [--match-case] [--whole-word] [--apply]
 *   npm run cli -- articles bulk-replace --workspace <id> --find "…" --replace "…" [--ids a,b] [--apply]
 *   npm run cli -- articles retry-publish <id>
 *   npm run cli -- workspaces pause <id> | resume <id>
 *   npm run cli -- gsc performance|cannibalization|coverage --workspace <id> [--days 28]
 *   npm run cli -- gsc inspect --workspace <id> --url https://…
 *   npm run cli -- readiness check --workspace <id> | --domain example.com
 *   npm run cli -- usage
 *
 * Auth: --api-key > ALTORANK_API_KEY > ~/.altorank/config.json. Base URL from
 * ALTORANK_BASE_URL (default https://app.altorank.co).
 *
 * Every command prints one JSON envelope, errors included, and exits 1 when
 * ok is false (`keywords export --format csv` prints the CSV itself). Nothing
 * here publishes, approves or deletes: the API has no such calls, so neither
 * does this. `articles retry-publish` re-runs a publish a human already
 * approved and that failed; `articles replace` proposes unless --apply.
 *
 * Mutations (replace --apply, bulk-*, retry-publish, pause/resume) need a key
 * with the "write" scope.
 */

import { readFileSync } from "node:fs";
import { agentRequest, resolveApiKey, resolveBaseUrl, CONFIG_PATH } from "./lib/agent-client";
import { fail, ok, type Envelope } from "../lib/agent/envelope";
import { keywordsToCsv, type ExportableKeyword } from "../lib/keywords/export";

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
  "Usage: altorank <auth whoami|status> | <workspaces list|get ID|pause ID|resume ID> | " +
  "<keywords list|suggest|export|bulk-reschedule|bulk-remove> | " +
  "<articles list|get ID|content ID|generate|replace ID|bulk-replace|retry-publish ID> | " +
  "<gsc performance|cannibalization|coverage|inspect> | <readiness check> | <usage>. See scripts/cli.ts for flags.";

const list = (v: string | boolean | undefined): string[] | undefined =>
  str(v)?.split(",").map((x) => x.trim()).filter(Boolean);

/** --json '{…}' inline, or --json-file path. Returns the parsed body or an envelope saying why not. */
function jsonFlag(flags: Flags): { body: Record<string, unknown> } | { envelope: Envelope } | null {
  const inline = str(flags.json);
  const file = str(flags["json-file"]);
  if (!inline && !file) return null;
  try {
    const text = inline ?? readFileSync(file as string, "utf8");
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { body: body as Record<string, unknown> };
  } catch (err) {
    return { envelope: fail("invalid_request", `--json is not a JSON object: ${err instanceof Error ? err.message : String(err)}`, "Pass --json '{...}' or --json-file path.json with an object body.") };
  }
}

/** The find/replace body shared by `articles replace` and `bulk-replace`. */
function replaceBody(flags: Flags): { body: Record<string, unknown> } | { envelope: Envelope } {
  const find = str(flags.find);
  if (!find) return { envelope: fail("invalid_request", "--find is required.", "Pass --find \"text\" and --replace \"text\"; add --apply to write (default is a preview).") };
  return {
    body: {
      find,
      replace: str(flags.replace) ?? "",
      match_case: flags["match-case"] === true,
      whole_word: flags["whole-word"] === true,
      preview_only: flags.apply !== true,
    },
  };
}

async function run(argv: string[]): Promise<Envelope> {
  const { positional, flags } = parseArgs(argv);
  const [group, command, id] = positional;
  // Asking for help is not an error, and neither is running with no command.
  if (flags.help || flags.h || !group) return ok({ usage: USAGE }, "Pick a command from the usage line; every one returns this envelope.");
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
    case "workspaces pause":
    case "workspaces resume":
      if (!id) return fail("invalid_request", "Workspace id is required.", `altorank workspaces ${command} <id>`);
      return agentRequest(`/workspaces/${encodeURIComponent(id)}/${command}`, { apiKey, method: "POST" });

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

    case "keywords export": {
      const missing = needWorkspace();
      if (missing) return missing;
      const format = str(flags.format) ?? "json";
      if (format !== "csv" && format !== "json") return fail("invalid_request", `Unknown format "${format}".`, "Use --format csv or --format json.");
      // Always fetch the envelope; render CSV locally with the same function
      // the route uses, so the terminal never has to parse a non-envelope.
      const env = await agentRequest<{ rows: ExportableKeyword[] }>("/keywords/export", {
        apiKey,
        query: { workspace_id: workspace, format: "json", status: str(flags.status) },
      });
      if (format === "csv" && env.ok) {
        process.stdout.write(keywordsToCsv(env.data.rows));
        process.exit(0);
      }
      return env;
    }
    case "keywords bulk-reschedule": {
      const missing = needWorkspace();
      if (missing) return missing;
      const json = jsonFlag(flags);
      if (json && "envelope" in json) return json.envelope;
      const ids = list(flags.ids);
      const shift = str(flags["shift-days"]);
      const body: Record<string, unknown> = json
        ? { ...json.body, workspace_id: workspace }
        : ids && shift !== undefined
          ? { workspace_id: workspace, keyword_ids: ids, shift_days: Number(shift) }
          : {};
      if (!("items" in body) && !("keyword_ids" in body)) {
        return fail("invalid_request", "Say what to move.", "Either --ids a,b --shift-days 7, or --json '{\"items\":[{\"keyword_id\":\"…\",\"date\":\"YYYY-MM-DD\"}]}'.");
      }
      return agentRequest("/keywords/bulk-reschedule", { apiKey, method: "POST", body });
    }
    case "keywords bulk-remove": {
      const missing = needWorkspace();
      if (missing) return missing;
      const ids = list(flags.ids);
      if (!ids?.length) return fail("invalid_request", "--ids is required.", "Pass --ids a,b with keyword ids from `keywords list`. Removal keeps the keywords tracked.");
      return agentRequest("/keywords/bulk-remove", { apiKey, method: "POST", body: { workspace_id: workspace, keyword_ids: ids } });
    }

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

    case "articles replace": {
      if (!id) return fail("invalid_request", "Article id is required.", "altorank articles replace <id> --find … --replace … [--apply]");
      const rb = replaceBody(flags);
      if ("envelope" in rb) return rb.envelope;
      return agentRequest(`/articles/${encodeURIComponent(id)}/replace`, { apiKey, method: "POST", body: rb.body });
    }
    case "articles bulk-replace": {
      const missing = needWorkspace();
      if (missing) return missing;
      const rb = replaceBody(flags);
      if ("envelope" in rb) return rb.envelope;
      return agentRequest("/articles/bulk-replace", {
        apiKey,
        method: "POST",
        body: { ...rb.body, workspace_id: workspace, article_ids: list(flags.ids) },
      });
    }
    case "articles retry-publish":
      if (!id) return fail("invalid_request", "Article id is required.", "altorank articles retry-publish <id>");
      return agentRequest(`/articles/${encodeURIComponent(id)}/retry-publish`, { apiKey, method: "POST" });

    case "gsc performance":
    case "gsc cannibalization":
    case "gsc coverage":
      return needWorkspace() ?? agentRequest(`/gsc/${command}`, {
        apiKey,
        query: {
          workspace_id: workspace,
          days: num(flags.days),
          min_impressions: num(flags["min-impressions"]),
          limit: num(flags.limit),
          bucket: str(flags.bucket),
        },
      });
    case "gsc inspect":
      if (!str(flags.url)) return fail("invalid_request", "--url is required.", "altorank gsc inspect --workspace <id> --url https://example.com/page");
      return needWorkspace() ?? agentRequest("/gsc/url-inspection", {
        apiKey,
        query: { workspace_id: workspace, url: str(flags.url), days: num(flags.days) },
      });

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
