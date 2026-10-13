// ---------------------------------------------------------------------------
// One short model call for a public tool
// ---------------------------------------------------------------------------
//
// For `kind: "ai"` tools. The handler has already reserved the tool's
// `estimateCents` against the daily cap before `run` is called; this helper
// keeps each call inside that estimate by pinning the model and capping the
// output, and records the real token cost to provider_spend like every other
// Anthropic call in the app.
//
// The model is pinned to the repo's Haiku default (MODEL_DEFAULTS in
// lib/ai/models.ts), NOT `anthropicModel("structured")`: that one falls back
// to ANTHROPIC_MODEL, which a deployment may point at a larger model, and an
// anonymous endpoint's cost must not change because of a setting made for
// something else. PUBLIC_TOOLS_MODEL overrides it on purpose.
//
// Every failure becomes ToolError("upstream"), with a sentence a visitor can
// read. The provider's own message goes to the log, not to the caller.

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { MODEL_DEFAULTS } from "@/lib/ai/models";
import { anthropicCost } from "@/lib/billing/spend";
import { recordSpendByDefault } from "@/lib/billing/default-spend";
import { ToolError } from "./errors";

/**
 * Hard ceiling on output tokens for any public tool call. Sized for the
 * longest honest answer a tool gives: a rewrite of 1,500 pasted words.
 */
export const MAX_OUTPUT_TOKENS = 3072;
const DEFAULT_OUTPUT_TOKENS = 1024;
const UNAVAILABLE = "The AI step of this tool is unavailable right now. Try again later.";

export function publicToolModel(): string {
  return process.env.PUBLIC_TOOLS_MODEL?.trim() || MODEL_DEFAULTS.anthropicStructured;
}

/** The image types the model accepts as input. */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface AskOptions {
  /** The tool slug, for logs. */
  tool: string;
  system: string;
  user: string;
  /** One image, sent before the text. The caller fetched and checked it. */
  image?: { mediaType: ImageMediaType; base64: string };
  /** Capped at MAX_OUTPUT_TOKENS. Default 1024. */
  maxTokens?: number;
  temperature?: number;
  /** Pass ctx.signal so the route's deadline cancels the call. */
  signal?: AbortSignal;
  /** Injected in tests. */
  client?: Pick<Anthropic, "messages">;
}

export interface AskResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the model hit max_tokens: the text is cut off. */
  truncated: boolean;
}

/** One model call, text out. */
export async function askHaiku(opts: AskOptions): Promise<AskResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !apiKey) {
    console.error(`[public-tools/${opts.tool}] ANTHROPIC_API_KEY is not set`);
    throw new ToolError("upstream", UNAVAILABLE);
  }
  const client = opts.client ?? new Anthropic({ apiKey });
  const model = publicToolModel();
  const maxTokens = Math.min(Math.max(1, opts.maxTokens ?? DEFAULT_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);

  let message: Anthropic.Message;
  try {
    message = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: opts.system,
        messages: [
          {
            role: "user",
            content: opts.image
              ? [
                  { type: "image", source: { type: "base64", media_type: opts.image.mediaType, data: opts.image.base64 } },
                  { type: "text", text: opts.user },
                ]
              : opts.user,
          },
        ],
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch (err) {
    console.error(`[public-tools/${opts.tool}] model call failed`, err instanceof Error ? err.message : err);
    throw new ToolError("upstream", UNAVAILABLE);
  }

  const inputTokens = message.usage?.input_tokens ?? 0;
  const outputTokens = message.usage?.output_tokens ?? 0;
  recordSpendByDefault({
    provider: "anthropic",
    operation: model,
    inputTokens,
    outputTokens,
    costUsd: anthropicCost(model, inputTokens, outputTokens),
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { text, model, inputTokens, outputTokens, truncated: message.stop_reason === "max_tokens" };
}

/**
 * The first JSON object or array in a model answer. Tolerates a code fence
 * and prose around it, which Haiku adds often enough that "return only JSON"
 * in the prompt does not hold on its own.
 */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) s = fenced[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to the first balanced-looking span
  }
  const start = s.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in the answer");
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  if (end <= start) throw new Error("no JSON in the answer");
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * One model call whose answer must be JSON matching `schema`. Say so in the
 * prompt; this parses and validates, and a miss is `upstream`, not a crash.
 */
export async function askHaikuJson<S extends z.ZodType>(
  opts: AskOptions & { schema: S },
): Promise<{ data: z.output<S> } & Omit<AskResult, "text">> {
  const { schema, ...ask } = opts;
  const res = await askHaiku(ask);
  if (res.truncated) {
    console.error(`[public-tools/${opts.tool}] JSON answer hit max_tokens`);
    throw new ToolError("upstream", "The AI answer came back incomplete. Try again with a shorter input.");
  }
  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch {
    console.error(`[public-tools/${opts.tool}] answer was not JSON`, res.text.slice(0, 300));
    throw new ToolError("upstream", "The AI answer could not be read. Try again.");
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    console.error(`[public-tools/${opts.tool}] answer failed its schema`, checked.error.issues[0]?.message);
    throw new ToolError("upstream", "The AI answer could not be read. Try again.");
  }
  const { text: _text, ...meta } = res;
  void _text;
  return { data: checked.data, ...meta };
}
