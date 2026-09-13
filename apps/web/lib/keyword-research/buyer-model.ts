// ---------------------------------------------------------------------------
// The one model call shape the buyer-side research makes, and its bill
// ---------------------------------------------------------------------------
//
// Both calls in this family (`buyer-seeds.ts`, `buyer-fit.ts`) are short,
// structured, and on the cheap tier. They share the client, the "no key means
// no call" rule, the JSON extraction, and the spend row, so neither can forget
// to bill and neither parses the reply its own way.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anthropicModel } from "@/lib/ai/models";
import { anthropicCost, recordSpend } from "@/lib/billing/spend";

/** Where to write the spend row. Optional: scripts and tests have none. */
export interface SpendSink {
  supabase: SupabaseClient;
  workspaceId: string | null;
}

export function modelAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * One structured call. Returns the text of the reply, or null when there is
 * no key or the call failed. Callers preserve the missing decision; automatic
 * writing must never interpret it as approval.
 */
export async function askStructured(
  operation: string,
  prompt: string,
  options: { maxTokens: number; spend?: SpendSink | null },
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = anthropicModel("structured");
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: options.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });
    if (options.spend) {
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      await recordSpend(options.spend.supabase, {
        provider: "anthropic",
        operation,
        costUsd: anthropicCost(model, inputTokens, outputTokens),
        inputTokens,
        outputTokens,
        workspaceId: options.spend.workspaceId,
      });
    }
    return response.content[0]?.type === "text" ? response.content[0].text : null;
  } catch {
    return null;
  }
}

/**
 * The JSON value inside a reply that may carry prose or a code fence around
 * it. `open`/`close` pick the bracket pair: "[" and "]" for an array reply.
 */
export function extractJson<T>(raw: string | null, open: "[" | "{", close: "]" | "}"): T | null {
  if (!raw) return null;
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** The lines of a business profile the prompts share. */
export function describeBusiness(business: {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
  buyingJobs?: string[] | null;
  differentiators?: string[] | null;
  exclusions?: string[] | null;
  conversionUrl?: string | null;
  country?: string | null;
  language?: string | null;
}): string {
  const lines: string[] = [];
  if (business.name?.trim()) lines.push(`Name: ${business.name.trim()}`);
  if (business.description?.trim()) lines.push(`What it does: ${business.description.trim()}`);
  if (business.offerings?.length) lines.push(`What people buy from it: ${business.offerings.join("; ")}`);
  if (business.audiences?.length) lines.push(`Who buys: ${business.audiences.join("; ")}`);
  if (business.competitors?.length) lines.push(`Competitors: ${business.competitors.join(", ")}`);
  if (business.buyingJobs?.length) lines.push(`Buying jobs: ${business.buyingJobs.join("; ")}`);
  if (business.differentiators?.length) lines.push(`Supported differences: ${business.differentiators.join("; ")}`);
  if (business.exclusions?.length) lines.push(`Not served: ${business.exclusions.join("; ")}`);
  if (business.conversionUrl) lines.push(`Conversion page: ${business.conversionUrl}`);
  if (business.language) lines.push(`Language: ${business.language}`);
  if (business.country) lines.push(`Market: ${business.country}`);
  return lines.join("\n");
}
