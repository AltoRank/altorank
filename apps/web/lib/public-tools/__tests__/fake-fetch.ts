// A SafeFetch stand-in for tool tests: routes by URL (and optionally user
// agent), never touches the network.

import { vi } from "vitest";
import type { SafeFetch, SafeFetchOptions, SafeFetchResult } from "../safe-fetch";
import { FetchFailedError } from "../safe-fetch";
import type { ToolContext } from "../types";

export type Route =
  | { status?: number; body?: string; headers?: Record<string, string>; bodyBuffer?: Buffer; finalUrl?: string }
  | Error;

export type Router = (url: string, opts: SafeFetchOptions) => Route | undefined;

export function fakeFetch(routes: Record<string, Route> | Router) {
  const router: Router = typeof routes === "function" ? routes : (url) => routes[url];
  const fn = vi.fn<SafeFetch>(async (url, opts = {}) => {
    const r = router(url, opts);
    if (r instanceof Error) throw r;
    if (!r) throw new FetchFailedError("the domain does not resolve", url);
    const body = opts.method === "HEAD" ? "" : (r.body ?? "");
    const buf = r.bodyBuffer ?? Buffer.from(body);
    const result: SafeFetchResult = {
      requestedUrl: url,
      url: r.finalUrl ?? url,
      status: r.status ?? 200,
      headers: r.headers ?? {},
      body,
      bodyBuffer: buf,
      bytes: buf.length,
      truncated: false,
      redirects: r.finalUrl && r.finalUrl !== url ? [{ url, status: 301, location: r.finalUrl }] : [],
      tlsUnverified: false,
      timeMs: 1,
    };
    return result;
  });
  return fn;
}

export function ctxWith(fetch: SafeFetch): ToolContext {
  return { ip: "test", signal: new AbortController().signal, fetch };
}

export const page = (head: string, body: string) => `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
