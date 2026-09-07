/**
 * Signup must not turn automatic approval on.
 *
 * Migration 079 defaults `workspaces.auto_approve` to false, `createWorkspace`
 * inherits that default, and `setAutoApprove` only enables it when somebody
 * ticks the box — recording who, so an automatic approval stays attributable.
 * Signup was the one path that set it true, which recorded a brand-new user as
 * having "set" a rule they were never shown, on the account least able to judge
 * the drafts yet. The product sells the veto: AGENTS.md says "review ALWAYS",
 * and the onboarding wizard states it as an ALWAYS ON card.
 *
 * Read from the source rather than exercised, because the insert lives inside a
 * server action that vitest cannot call: it needs a real Supabase session and a
 * Resend send. Same approach as lib/plan/__tests__/cron-pause-guard.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SIGNUP = join(__dirname, "..", "..", "..", "app", "(auth)", "signup", "page.tsx");

describe("signup leaves automatic approval off", () => {
  const source = readFileSync(SIGNUP, "utf8");
  // Comments explain why the field is absent, so only real assignments count.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  it("does not write any auto_approve field on the workspace it creates", () => {
    const writes = code.match(/auto_approve\w*\s*:/g) ?? [];
    expect(
      writes,
      "signup must leave auto_approve at the column default; enabling it is a choice made in workspace settings",
    ).toEqual([]);
  });

  it("still creates the workspace it is meant to create", () => {
    // Guards the test above against passing because the insert was deleted.
    expect(code).toMatch(/from\("workspaces"\)/);
    expect(code).toMatch(/auto_generate:\s*true/);
  });
});
