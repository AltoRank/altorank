import { describe, expect, it } from "vitest";
import { buildChatSystem, candidatesForModel, CHAT_TOOLS, compactTrace, parseToolCall, resolveTerms } from "../chat";
import type { ResearchCandidate } from "../types";

const cand = (term: string, volume: number | null = 100): ResearchCandidate => ({
  term,
  volume,
  difficulty: null,
  cpc: null,
  intent: "info",
  origin: "t",
  existingId: null,
  existingStatus: null,
});

describe("parseToolCall", () => {
  it("accepts well-formed calls for every tool", () => {
    expect(parseToolCall("generate", { source: "competitors", count: 5 })).toEqual({ tool: "generate", source: "competitors", count: 5 });
    expect(parseToolCall("find", { term: "  crm software " })).toEqual({ tool: "find", term: "crm software" });
    expect(parseToolCall("import", { terms: ["a", "b"] })).toEqual({ tool: "import", terms: ["a", "b"] });
    expect(parseToolCall("schedule", { terms: ["a"], reason: "easy" })).toEqual({ tool: "schedule", terms: ["a"], reason: "easy" });
    expect(parseToolCall("store", { terms: ["a"] })).toEqual({ tool: "store", terms: ["a"], reason: "" });
  });
  it("rejects unknown tools and malformed input rather than guessing", () => {
    expect(parseToolCall("publish", { terms: ["a"] })).toBeNull();
    expect(parseToolCall("generate", { source: "everything", count: 5 })).toBeNull();
    expect(parseToolCall("generate", { source: "both", count: 500 })).toBeNull();
    expect(parseToolCall("find", { term: "" })).toBeNull();
    expect(parseToolCall("import", { terms: [] })).toBeNull();
  });
  it("declares exactly the five tools the prompt promises, all strict", () => {
    expect(CHAT_TOOLS.map((t) => t.name).sort()).toEqual(["find", "generate", "import", "schedule", "store"]);
    expect(CHAT_TOOLS.every((t) => (t as { strict?: boolean }).strict === true)).toBe(true);
  });
});

describe("resolveTerms", () => {
  it("matches case-insensitively against what the tools returned and reports the rest", () => {
    const { matched, unknown } = resolveTerms(["CRM Software", "made up term", "crm software"], [cand("crm software")]);
    expect(matched.map((c) => c.term)).toEqual(["crm software"]);
    expect(unknown).toEqual(["made up term"]);
  });
});

describe("candidatesForModel", () => {
  it("renders unknown metrics as dashes, never zeros", () => {
    const table = candidatesForModel([cand("x", null)]);
    expect(table).toContain("x | — | — | — | info | t");
    expect(candidatesForModel([])).toBe("(no candidates)");
  });
});

describe("buildChatSystem", () => {
  it("puts the owner's instructions first and states capacity and the plan", () => {
    const system = buildChatSystem({
      ws: {
        id: "w",
        name: "Cal.com",
        domain: "cal.com",
        languageCode: "en",
        locationCode: 2840,
        profile: { name: "Cal.com", language: "English", country: "US", description: "Scheduling.", audiences: ["Sales teams"], competitors: ["calendly.com"] },
      },
      capacity: { scheduled: 12, cap: 60, slots: 48 },
      planned: [{ term: "calendly alternatives", volume: 1600, difficulty: null, date: "2026-09-10" }],
      instructions: "Only the UK market.",
    });
    expect(system.startsWith("KEYWORD INSTRUCTIONS FROM THE SITE OWNER")).toBe(true);
    expect(system).toContain("Only the UK market.");
    expect(system).toContain("12 of 60 scheduled · 48 slots available");
    expect(system).toContain("2026-09-10: calendly alternatives (vol 1600, kd —)");
    expect(system).toContain("never schedule anything yourself");
  });
});

describe("compactTrace", () => {
  it("joins steps with arrows", () => {
    expect(compactTrace(["Researched 3 competitors → 22 candidates", "8 had no search data → 14 proposed"])).toBe(
      "Researched 3 competitors → 22 candidates → 8 had no search data → 14 proposed",
    );
  });
});
