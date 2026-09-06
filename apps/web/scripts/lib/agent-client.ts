/**
 * The one HTTP client the CLI and the MCP server share for /api/agent/v1.
 *
 * Auth precedence: an explicit key > ALTORANK_API_KEY > ~/.altorank/config.json.
 * Base URL from ALTORANK_BASE_URL, default the hosted app. Every call returns
 * an envelope, including transport failures, so callers never need a try/catch
 * to print something an agent can act on.
 *
 * Relative imports on purpose: tsx runs this outside Next, without the "@/"
 * alias (see scripts/mcp.ts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail, GUIDANCE, type Envelope } from "../../lib/agent/envelope";
import { looksLikeApiKey } from "../../lib/agent/api-keys";

export const DEFAULT_BASE_URL = "https://app.altorank.co";
export const CONFIG_PATH = join(homedir(), ".altorank", "config.json");

export type KeySource = "flag" | "env" | "config" | "none";

export function readConfig(): { api_key?: string; base_url?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { api_key?: string; base_url?: string };
  } catch {
    return {};
  }
}

export function resolveApiKey(flag?: string | null): { key: string | null; source: KeySource } {
  if (flag) return { key: flag, source: "flag" };
  if (process.env.ALTORANK_API_KEY) return { key: process.env.ALTORANK_API_KEY, source: "env" };
  const cfg = readConfig();
  if (cfg.api_key) return { key: cfg.api_key, source: "config" };
  return { key: null, source: "none" };
}

export function resolveBaseUrl(): string {
  const raw = process.env.ALTORANK_BASE_URL || readConfig().base_url || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  apiKey?: string | null;
  query?: Record<string, string | number | undefined | null>;
};

export async function agentRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<Envelope<T>> {
  const { key } = resolveApiKey(opts.apiKey);
  if (!key) return fail("unauthorized", "No API key configured.", GUIDANCE.missingKey);
  if (!looksLikeApiKey(key)) return fail("unauthorized", "Configured API key is malformed.", GUIDANCE.malformedKey);

  const url = new URL(`${resolveBaseUrl()}/api/agent/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    return fail(
      "upstream_error",
      `Could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
      "Check ALTORANK_BASE_URL and network access, then retry once.",
    );
  }

  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as Envelope<T>;
    if (typeof parsed === "object" && parsed !== null && "ok" in parsed) return parsed;
  } catch {
    // fall through
  }
  return fail(
    "upstream_error",
    `HTTP ${res.status} from ${url.pathname}: ${text.slice(0, 200)}`,
    "The server did not answer with an AltoRank envelope. Check ALTORANK_BASE_URL points at an AltoRank install with the agent API.",
  );
}
