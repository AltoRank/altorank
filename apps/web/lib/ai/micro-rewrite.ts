// ---------------------------------------------------------------------------
// Micro-rewrites, the call: one field or selection, metered
// ---------------------------------------------------------------------------
//
// The prompts and parsers are in lib/ai/micro.ts, which the editor's client
// components import. The call is here, server-only, because it is metered
// (lib/ai/metered.ts) as `editor/micro`: the calls wrote no spend row until
// 2026-10-16, so Operations never saw them.

import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "./models";
import { createMetered } from "./metered";
import {
  buildMicroPrompt,
  parseMicroResponse,
  keepsAssets,
  FIELD_LIMITS,
  type RewriteFieldInput,
} from "./micro";

/** The spend row's operation for a field or selection rewrite. */
export const MICRO_OPERATION = "editor/micro";

export interface RewriteFieldResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function rewriteField(
  input: RewriteFieldInput,
  client: Anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
): Promise<RewriteFieldResult> {
  if (!input.text.trim()) throw new Error("Nothing to rewrite");
  if (input.action === "ask" && !input.prompt?.trim()) throw new Error("Say what to change");

  const { system, user } = buildMicroPrompt(input);
  const message = await createMetered(client, {
    model: anthropicModel("structured"),
    // A selection can be a few paragraphs; the fields are a line.
    max_tokens: input.field === "selection" ? 4096 : 400,
    system,
    messages: [{ role: "user", content: user }],
  }, MICRO_OPERATION);

  const raw = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let text = parseMicroResponse(raw, input.field);
  if (!text) throw new Error("The model returned nothing usable");
  if (input.field === "selection" && !keepsAssets(input.text, text)) {
    throw new Error("The rewrite dropped a link or image, so it was not proposed. Try again or select less.");
  }
  let inputTokens = message.usage?.input_tokens ?? 0;
  let outputTokens = message.usage?.output_tokens ?? 0;

  // The prompt states the limit; the model ignores it about half the time on
  // "shorten" (live: 178 and 173 characters against a 160 limit). One retry
  // that quotes the overshoot brings it under; a second miss is shown as-is,
  // over, so the counter tells the truth rather than a loop burning tokens.
  const limit = input.field === "selection" ? null : FIELD_LIMITS[input.field];
  if (limit && text.length > limit) {
    const retry = await createMetered(client, {
      model: anthropicModel("structured"),
      max_tokens: 400,
      system,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: text },
        { role: "user", content: `That is ${text.length} characters; the limit is ${limit}. Return the same idea in at most ${limit} characters, plain text only.` },
      ],
    }, MICRO_OPERATION);
    const retried = parseMicroResponse(
      retry.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(""),
      input.field,
    );
    if (retried && retried.length < text.length) text = retried;
    inputTokens += retry.usage?.input_tokens ?? 0;
    outputTokens += retry.usage?.output_tokens ?? 0;
  }

  return { text, inputTokens, outputTokens };
}
