// ---------------------------------------------------------------------------
// Research chat: natural language in, proposals out, nothing scheduled
// ---------------------------------------------------------------------------
//
// The model is given the business profile, the plan's state and five tools.
// Three of them research (generate, find, import) and run for real, spending
// DataForSEO calls through the same pipeline the tabs use. Two of them -
// schedule and store - do NOT act. They turn the model's choice into a card
// with a button, and the person clicks the button. A chat that could schedule
// thirty keywords because a sentence was read a little too eagerly is worse
// than one that cannot schedule at all.
//
// Every candidate the model shows comes from a provider row. It cannot type a
// volume, because volumes never pass through its output: it returns terms,
// and the terms are matched back to the candidates the tools returned.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicModel } from "@/lib/ai/models";
import { withInstructions } from "./instructions";
import { capacityLine } from "./funnel";
import type { PlanCapacity, ResearchCandidate, ResearchFunnel, ResearchResult, ResearchSource } from "./types";
import type { ResearchWorkspace } from "./pipeline";

export const CHAT_PROMPT_CHIPS = [
  "Find easy wins: solid search volume with low difficulty",
  "Fill my free calendar slots with high-potential keywords",
  "Research keywords that compare us to our competitors",
  "Replace the weakest keywords on my calendar with stronger ones",
] as const;

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** A card in the chat: researched rows, or a set the model wants scheduled or stored. */
export interface ChatProposal {
  kind: "research" | "schedule" | "store";
  label: string;
  candidates: ResearchCandidate[];
  funnel: ResearchFunnel | null;
}

export interface ChatReply {
  text: string;
  proposals: ChatProposal[];
  trace: string[];
}

// --- Tool definitions -------------------------------------------------------

const SOURCES = ["both", "competitors", "audiences"] as const;

export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "generate",
    description:
      "Research keywords from the workspace's competitors and/or target audiences. Returns candidates with search volume, difficulty, CPC and intent. Costs money; call it at most once per request.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: [...SOURCES], description: "Which evidence to use." },
        count: { type: "integer", minimum: 1, maximum: 30, description: "How many keywords to propose." },
      },
      required: ["source", "count"],
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Tool,
  {
    name: "find",
    description: "Look up one word or phrase: its own metrics plus up to 10 related terms.",
    input_schema: {
      type: "object",
      properties: { term: { type: "string", description: "The word or phrase to look up." } },
      required: ["term"],
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Tool,
  {
    name: "import",
    description: "Look up metrics for a list of exact terms in one batch.",
    input_schema: {
      type: "object",
      properties: { terms: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 } },
      required: ["terms"],
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Tool,
  {
    name: "schedule",
    description:
      "Propose putting these keywords on the calendar. Use only terms that appeared in a tool result. The person sees a card with a Schedule button; nothing is scheduled until they click it.",
    input_schema: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 60 },
        reason: { type: "string", description: "One sentence on why these." },
      },
      required: ["terms", "reason"],
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Tool,
  {
    name: "store",
    description:
      "Propose keeping these keywords for later without scheduling them. Use only terms that appeared in a tool result. The person confirms with a click.",
    input_schema: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 60 },
        reason: { type: "string" },
      },
      required: ["terms", "reason"],
      additionalProperties: false,
    },
    strict: true,
  } as Anthropic.Tool,
];

const GenerateInput = z.object({ source: z.enum(SOURCES), count: z.number().int().min(1).max(30) });
const FindInput = z.object({ term: z.string().trim().min(1).max(200) });
const ImportInput = z.object({ terms: z.array(z.string().trim().min(1)).min(1).max(100) });
const SetInput = z.object({ terms: z.array(z.string().trim().min(1)).min(1).max(60), reason: z.string().default("") });

export type ChatToolCall =
  | { tool: "generate"; source: ResearchSource; count: number }
  | { tool: "find"; term: string }
  | { tool: "import"; terms: string[] }
  | { tool: "schedule"; terms: string[]; reason: string }
  | { tool: "store"; terms: string[]; reason: string };

/**
 * Validate a tool call from the model. Returns null for an unknown tool or a
 * malformed input; the loop reports that back as a tool error rather than
 * guessing at what was meant.
 */
export function parseToolCall(name: string, input: unknown): ChatToolCall | null {
  switch (name) {
    case "generate": {
      const r = GenerateInput.safeParse(input);
      return r.success ? { tool: "generate", ...r.data } : null;
    }
    case "find": {
      const r = FindInput.safeParse(input);
      return r.success ? { tool: "find", term: r.data.term } : null;
    }
    case "import": {
      const r = ImportInput.safeParse(input);
      return r.success ? { tool: "import", terms: r.data.terms } : null;
    }
    case "schedule":
    case "store": {
      const r = SetInput.safeParse(input);
      return r.success ? { tool: name, terms: r.data.terms, reason: r.data.reason } : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve the terms a schedule/store call names against candidates the tools
 * actually returned. Anything unmatched is reported, not invented.
 */
export function resolveTerms(
  terms: string[],
  known: ResearchCandidate[],
): { matched: ResearchCandidate[]; unknown: string[] } {
  const byTerm = new Map(known.map((c) => [c.term.toLowerCase().trim(), c]));
  const matched: ResearchCandidate[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const key = t.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byTerm.get(key);
    if (hit) matched.push(hit);
    else unknown.push(t);
  }
  return { matched, unknown };
}

/** The compact table a tool result hands back to the model. Dashes stay dashes. */
export function candidatesForModel(candidates: ResearchCandidate[]): string {
  if (!candidates.length) return "(no candidates)";
  const dash = (n: number | null) => (n === null ? "—" : String(n));
  return [
    "term | volume/mo | difficulty | cpc | intent | origin",
    ...candidates.map((c) => `${c.term} | ${dash(c.volume)} | ${dash(c.difficulty)} | ${c.cpc === null ? "—" : c.cpc.toFixed(2)} | ${c.intent} | ${c.origin}`),
  ].join("\n");
}

// --- System prompt ------------------------------------------------------------

export interface ChatContext {
  ws: ResearchWorkspace;
  capacity: PlanCapacity;
  /** Terms currently planned, newest first, for "replace the weakest" requests. */
  planned: Array<{ term: string; volume: number | null; difficulty: number | null; date: string }>;
  instructions: string;
}

export function buildChatSystem(ctx: ChatContext): string {
  const p = ctx.ws.profile;
  const plan = ctx.planned.length
    ? ctx.planned
        .slice(0, 60)
        .map((k) => `- ${k.date}: ${k.term} (vol ${k.volume ?? "—"}, kd ${k.difficulty ?? "—"})`)
        .join("\n")
    : "(nothing planned yet)";
  return withInstructions(
    ctx.instructions,
    [
      "You are the keyword research assistant inside an SEO content planner.",
      "You help one person decide which keywords to write articles for. You research with the tools; you never write articles and you never schedule anything yourself.",
      "",
      `SITE: ${ctx.ws.name || ctx.ws.domain} (${ctx.ws.domain})`,
      p.description ? `WHAT IT DOES: ${p.description}` : "",
      `AUDIENCES: ${p.audiences.length ? p.audiences.join("; ") : "(none recorded)"}`,
      `COMPETITORS: ${p.competitors.length ? p.competitors.join(", ") : "(none recorded)"}`,
      `CALENDAR: ${capacityLine(ctx.capacity)}`,
      "PLANNED KEYWORDS:",
      plan,
      "",
      "How to work:",
      "- To find keywords, call generate, find or import. Do not call the same research tool twice in one turn.",
      "- To recommend action, call schedule or store with terms copied EXACTLY from a tool result. The person sees a card and decides. Say that nothing has been scheduled until they click.",
      "- 'Easy win' means volume >= 100 and difficulty <= 30. Prefer those when asked for easy wins.",
      "- Never state a volume, difficulty or CPC that was not in a tool result. A dash means unknown; say 'no search data', never zero.",
      "- If a tool returns nothing, say so and say why (the tool result explains). Do not make up keywords.",
      "- Be brief. One or two short paragraphs, then let the cards speak.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// --- The loop -----------------------------------------------------------------

export interface ChatExecutors {
  generate: (source: ResearchSource, count: number) => Promise<ResearchResult>;
  find: (term: string) => Promise<ResearchResult>;
  import: (terms: string[]) => Promise<ResearchResult>;
}

const MAX_ITERATIONS = 4;

/**
 * One assistant turn. Runs research tools for real, turns schedule/store into
 * proposals, and returns the text plus the cards. `knownCandidates` carries
 * rows from earlier turns so "schedule the first three" can resolve them.
 */
export async function runResearchChat(
  ctx: ChatContext,
  history: ChatTurn[],
  knownCandidates: ResearchCandidate[],
  exec: ChatExecutors,
  client: Anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
): Promise<ChatReply> {
  const system = buildChatSystem(ctx);
  const messages: Anthropic.MessageParam[] = history.map((t) => ({ role: t.role, content: t.text }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return { text: "Ask me something about keywords to get started.", proposals: [], trace: [] };
  }

  const proposals: ChatProposal[] = [];
  const trace: string[] = [];
  const known = [...knownCandidates];
  const used = new Set<string>();
  let text = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: anthropicModel("structured"),
      max_tokens: 1500,
      system,
      tools: CHAT_TOOLS,
      messages,
    });

    text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim() || text;
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !toolUses.length) break;

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const call = parseToolCall(use.name, use.input);
      if (!call) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid input for ${use.name}.` });
        continue;
      }
      if (call.tool === "generate" || call.tool === "find" || call.tool === "import") {
        if (used.has(call.tool)) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `${call.tool} was already called this turn; use its result.` });
          continue;
        }
        used.add(call.tool);
        const result =
          call.tool === "generate"
            ? await exec.generate(call.source, call.count)
            : call.tool === "find"
              ? await exec.find(call.term)
              : await exec.import(call.terms);
        trace.push(...result.trace);
        known.push(...result.candidates.filter((c) => !known.some((k) => k.term.toLowerCase() === c.term.toLowerCase())));
        if (result.candidates.length) {
          proposals.push({ kind: "research", label: labelFor(call), candidates: result.candidates, funnel: result.funnel });
        }
        const body = [
          result.note ? `NOTE: ${result.note}` : "",
          `Funnel: found ${result.funnel.found}, ${result.funnel.skippedExisting} already tracked, ${result.funnel.skippedNoData} no search data, ${result.funnel.skippedLowVolume} too little volume, ${result.funnel.proposed} proposed.`,
          candidatesForModel(result.candidates),
        ]
          .filter(Boolean)
          .join("\n");
        results.push({ type: "tool_result", tool_use_id: use.id, content: body });
        continue;
      }

      // schedule / store: a proposal, never an action.
      const { matched, unknown } = resolveTerms(call.terms, known);
      if (matched.length) {
        proposals.push({ kind: call.tool, label: call.reason || (call.tool === "schedule" ? "Schedule these" : "Store these"), candidates: matched, funnel: null });
        trace.push(`Proposed ${matched.length} to ${call.tool}`);
      }
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: [
          matched.length ? `Shown to the person as a card with a ${call.tool === "schedule" ? "Schedule" : "Store"} button (${matched.length} keywords). Nothing has been ${call.tool === "schedule" ? "scheduled" : "stored"} yet.` : "",
          unknown.length ? `Not in any tool result, so not proposed: ${unknown.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }

    messages.push({ role: "user", content: results });
  }

  if (!text) {
    text = proposals.length
      ? "Here is what the research turned up."
      : "The research returned nothing I can propose. See the notes above for why.";
  }
  return { text, proposals, trace };
}

function labelFor(call: ChatToolCall): string {
  switch (call.tool) {
    case "generate":
      return call.source === "both" ? "From competitors and audiences" : call.source === "competitors" ? "From competitors" : "From audiences";
    case "find":
      return `Related to "${call.term}"`;
    case "import":
      return `${call.terms.length} looked up`;
    default:
      return "";
  }
}

/** "Researched 3 competitors → 22 candidates → 8 had no search data → 14 proposed", compacted. */
export function compactTrace(trace: string[]): string {
  return trace.join(" → ").replace(/\s*→\s*→\s*/g, " → ");
}
