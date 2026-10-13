// ---------------------------------------------------------------------------
// CTA generator: button text plus a supporting line, for one offer
// ---------------------------------------------------------------------------
//
// One honesty check in code: an option that promises "free", "no card",
// "cancel anytime" and the like when the visitor's own description of the
// offer never did is flagged, because the page warns about exactly that.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { list, table, text, type Block } from "../blocks";
import { optionalText, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged, unsupportedTerms } from "../prompt";

const SLUG = "cta-generator";
const BUTTON_MAX = 30;

const Answer = z.object({
  ctas: z
    .array(z.object({ button: z.string().min(1), supporting: z.string().default("") }))
    .min(1)
    .max(12),
});

const SYSTEM = [
  "You write calls to action for websites.",
  "Given an offer and, optionally, its audience, write 8 distinct options. Each has button text (2 to 5 words, under 30 characters, starting with a verb) and one supporting line (under 90 characters) placed next to the button that says what happens after the click.",
  "Only state terms the offer states. Do not say free, no card, instant, or name a trial length unless the offer says so.",
  "No exclamation marks, no all caps, no emoji.",
  'Shape: {"ctas":[{"button":"...","supporting":"..."}]}',
  JSON_ONLY,
  INPUT_RULES,
].join("\n");

export const ctaGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    offer: requiredText("what you are offering", 300),
    audience: optionalText("the audience", 200),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.5,
  async run({ offer, audience }, ctx) {
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: SYSTEM,
      user: [tagged("offer", offer), audience ? tagged("audience", audience) : ""].filter(Boolean).join("\n"),
      maxTokens: 700,
      temperature: 0.8,
      schema: Answer,
      signal: ctx.signal,
    });

    const rows = data.ctas.map(({ button, supporting }) => {
      const len = charLength(button);
      return [button, supporting, len > BUTTON_MAX ? `${len} (long for a button)` : len];
    });
    const flagged = unsupportedTerms(
      data.ctas.map((c) => `${c.button}: ${c.supporting}`),
      `${offer} ${audience ?? ""}`,
    );

    const blocks: Block[] = [table(["Button", "Supporting line", "Button characters"], rows, "CTA options")];
    if (flagged.length) {
      blocks.push(
        list(
          flagged.map(([line, term]) => `"${line}" promises ${term}, but your description of the offer does not. Check it against your real terms.`),
          "Check these",
        ),
      );
    }
    blocks.push(
      text(
        "The options know only what you typed about the offer. Make sure each one matches what the next screen actually does before it goes on a button.",
        "Before you use one",
      ),
    );
    return blocks;
  },
});
