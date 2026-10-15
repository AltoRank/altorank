import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { usageGuidance } from "../usage-guidance";

// The free drafts have been a one-time allowance since migration 083. GET
// /usage told a no-plan account "N of 7 included drafts remain this month",
// and the agent skill described `quota_exceeded` as "the month's free drafts
// used": both a promise of a refill that never comes.

describe("usageGuidance", () => {
  it("calls the free drafts one-time, never this month's", () => {
    const line = usageGuidance({ reason: "no-plan", limit: 7, remaining: 3 });
    expect(line).toContain("3 of the account's one-time 7 free drafts remain");
    expect(line).toContain("do not reset");
    expect(line).not.toMatch(/this month/);
  });

  it("keeps a plan's included volume monthly, because it is", () => {
    expect(usageGuidance({ reason: "plan", limit: 100, remaining: 40 })).toBe(
      "40 of 100 included drafts remain this month. Say so before you spend several.",
    );
  });
});

describe("the agent skill's quota_exceeded row", () => {
  it("does not describe the free drafts as monthly", () => {
    const skill = readFileSync(path.resolve(__dirname, "../../../../../skills/altorank/SKILL.md"), "utf8");
    const row = skill.split("\n").find((l) => l.startsWith("| `quota_exceeded`"));
    expect(row).toBeDefined();
    expect(row).toContain("one-time free drafts");
    expect(row).not.toMatch(/month's free drafts/);
  });
});
