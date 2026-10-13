// ---------------------------------------------------------------------------
// What a public tool is
// ---------------------------------------------------------------------------

import type { z } from "zod";
import type { Block } from "./blocks";
import type { SafeFetch } from "./safe-fetch";

/**
 * - `fetch`: reads a public URL server-side. Free to run; no spend guard.
 * - `ai`:    calls a model (lib/public-tools/ai.ts). Paid; spend-guarded.
 * - `data`:  calls a data provider (lib/public-tools/data.ts). Paid; spend-guarded.
 */
export type ToolKind = "fetch" | "ai" | "data";

export interface ToolContext {
  /** The caller's address as our edge saw it. For logging, never for output. */
  ip: string;
  /** Aborted at the route's deadline. Pass it to every fetch and provider call. */
  signal: AbortSignal;
  /** The only way a tool may fetch a URL: the SSRF-guarded fetch. Injected so tests can fake it. */
  fetch: SafeFetch;
}

export interface PublicTool<S extends z.ZodType = z.ZodType> {
  slug: string;
  kind: ToolKind;
  /** Validates and normalises the JSON body. The first issue's message is shown to the visitor. */
  input: S;
  /** Fresh runs allowed per IP per window, for this tool alone. */
  perIpLimit: { limit: number; windowMs: number };
  /** What one run is expected to cost, in US cents. 0 for `fetch` tools. Reserved before `run`. */
  estimateCents: number;
  /** How long an identical input is answered from memory. Default 5 minutes; 0 disables. */
  cacheTtlMs?: number;
  run(input: z.output<S>, ctx: ToolContext): Promise<Block[]>;
}

/** Identity helper that keeps `run`'s input typed from the schema. */
export function defineTool<S extends z.ZodType>(tool: PublicTool<S>): PublicTool<S> {
  return tool;
}
