/**
 * One voice for the trial refusals.
 *
 * A trial-gated account is refused three things - another draft, an
 * existing article's text, and other paid work - and each has one sentence, defined in
 * lib/billing/trial-refusal.ts. On the combined tree of 2026-09-25 the
 * session /api/generate answered a new-draft request with the body lock's
 * sentence while the agent API answered it with the hold's. This walks the
 * source and fails when a file other than the refusal module spells either
 * sentence out, so a door can only pick one of the two, never reword it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BODY_LOCKED_MESSAGE, TRIAL_HOLD_MESSAGE, TRIAL_SPEND_MESSAGE, trialRefusal } from "../trial-refusal";

const ROOT = join(__dirname, "..", "..", "..");
const SEARCH_DIRS = ["app", "lib", "components"];
const HOME = "lib/billing/trial-refusal.ts";

/** The opening words of each sentence: enough to catch a copy, reworded tail or not. */
const OPENINGS = ["Waiting for your trial to start", "The article text opens when", "Nothing more runs until the"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("trial refusals", () => {
  it("maps each ask to its sentence", () => {
    expect(trialRefusal("draft")).toBe(TRIAL_HOLD_MESSAGE);
    expect(trialRefusal("body")).toBe(BODY_LOCKED_MESSAGE);
    expect(trialRefusal("spend")).toBe(TRIAL_SPEND_MESSAGE);
    expect(new Set([TRIAL_HOLD_MESSAGE, BODY_LOCKED_MESSAGE, TRIAL_SPEND_MESSAGE]).size).toBe(3);
    for (const opening of OPENINGS) {
      expect([TRIAL_HOLD_MESSAGE, BODY_LOCKED_MESSAGE, TRIAL_SPEND_MESSAGE].some((m) => m.startsWith(opening))).toBe(true);
    }
  });

  it("is spelled out in lib/billing/trial-refusal.ts and nowhere else", () => {
    const copies: string[] = [];
    for (const dir of SEARCH_DIRS) {
      for (const file of sources(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === HOME) continue;
        const text = readFileSync(file, "utf8");
        for (const opening of OPENINGS) if (text.includes(opening)) copies.push(`${rel}: "${opening}"`);
      }
    }
    expect(copies).toEqual([]);
  });
});
