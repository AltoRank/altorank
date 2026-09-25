// Helpers for the paid-tool tests. Each test file mocks the Anthropic SDK
// and/or lib/seo/client itself (vi.mock is hoisted per file); these only build
// the fake answers and a context, so nothing here touches the network.

import { vi } from "vitest";
import type { Block, KvBlock, TableBlock, ListBlock, CodeBlock, TextBlock } from "../blocks";
import type { ToolContext } from "../types";
import type { SafeFetch } from "../safe-fetch";

/** A Messages API response carrying `body` (an object is sent as JSON). */
export function answer(body: unknown, stop_reason = "end_turn") {
  return {
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
    usage: { input_tokens: 100, output_tokens: 100 },
    stop_reason,
  };
}

/** A DataForSEO envelope whose first task has `result`. */
export function dfs(...result: unknown[]) {
  return { status_code: 20000, tasks: [{ status_code: 20000, result }] };
}

export function ctx(fetch?: SafeFetch): ToolContext {
  return {
    ip: "test",
    signal: new AbortController().signal,
    fetch: fetch ?? (vi.fn(async () => {
      throw new Error("this tool must not fetch");
    }) as unknown as SafeFetch),
  };
}

/** Silence the expected console.error from a failure path; returns the restore function. */
export function quiet() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => spy.mockRestore();
}

/** The first issue message of a failed parse, or null if it parsed. */
export function issue(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } }, v: unknown) {
  const r = schema.safeParse(v);
  return r.success ? null : (r.error?.issues[0]?.message ?? "invalid");
}

export const kvOf = (blocks: Block[], title?: string) => blocks.find((b): b is KvBlock => b.type === "kv" && (title === undefined || b.title === title))!;
export const tableOf = (blocks: Block[], title?: string) =>
  blocks.find((b): b is TableBlock => b.type === "table" && (title === undefined || b.title === title))!;
export const listOf = (blocks: Block[], title?: string) =>
  blocks.find((b): b is ListBlock => b.type === "list" && (title === undefined || b.title === title));
export const codeOf = (blocks: Block[]) => blocks.filter((b): b is CodeBlock => b.type === "code");
export const textOf = (blocks: Block[], title: string) => blocks.find((b): b is TextBlock => b.type === "text" && b.title === title);
export const item = (b: KvBlock, label: string) => b.items.find((i) => i.label === label);
