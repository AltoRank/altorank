import { describe, it, expect } from "vitest";
import { FakeDb } from "@/lib/plan/__tests__/fake-postgrest";
import { setupFinishedElsewhere } from "../setup-state";

/**
 * "Setup never finished" asks about the person, not only the site
 * (lib/onboarding/setup-state.ts): a member who finished setup on another
 * site - in this account or another one - or has an article there, knows
 * where setup is.
 */

function db(extra: { workspaces?: Record<string, unknown>[]; articles?: Record<string, unknown>[]; members?: Record<string, unknown>[] } = {}) {
  return new FakeDb({
    account_members: [
      { account_id: "acc-twin", user_id: "u1" },
      { account_id: "acc-main", user_id: "u1" },
      { account_id: "acc-stranger", user_id: "u9" },
      ...(extra.members ?? []),
    ],
    workspaces: [
      { id: "ws-twin", account_id: "acc-twin", onboarded_at: null, onboarding_skipped_at: null },
      ...(extra.workspaces ?? []),
    ],
    articles: extra.articles ?? [],
  });
}

describe("setupFinishedElsewhere", () => {
  it("is true when the person finished setup on a site in another of their accounts", async () => {
    const d = db({ workspaces: [{ id: "ws-main", account_id: "acc-main", onboarded_at: "2026-09-22T19:40:00Z", onboarding_skipped_at: null }] });
    expect(await setupFinishedElsewhere(d.client, "acc-twin", "ws-twin")).toBe(true);
  });

  it("counts a skipped wizard as finished, as the email does", async () => {
    const d = db({ workspaces: [{ id: "ws-main", account_id: "acc-main", onboarded_at: null, onboarding_skipped_at: "2026-09-22T19:40:00Z" }] });
    expect(await setupFinishedElsewhere(d.client, "acc-twin", "ws-twin")).toBe(true);
  });

  it("is true when the person has an article on another site, even one whose wizard stalled", async () => {
    const d = db({
      workspaces: [{ id: "ws-main", account_id: "acc-main", onboarded_at: null, onboarding_skipped_at: null }],
      articles: [{ id: "a1", workspace_id: "ws-main", status: "review" }],
    });
    expect(await setupFinishedElsewhere(d.client, "acc-twin", "ws-twin")).toBe(true);
  });

  it("does not count a draft whose run died, or the site the email is about", async () => {
    const d = db({
      workspaces: [{ id: "ws-main", account_id: "acc-main", onboarded_at: null, onboarding_skipped_at: null }],
      articles: [
        { id: "a1", workspace_id: "ws-main", status: "error" },
        { id: "a2", workspace_id: "ws-twin", status: "review" },
      ],
    });
    expect(await setupFinishedElsewhere(d.client, "acc-twin", "ws-twin")).toBe(false);
  });

  it("does not look at somebody else's accounts", async () => {
    const d = db({ workspaces: [{ id: "ws-stranger", account_id: "acc-stranger", onboarded_at: "2026-09-01T00:00:00Z", onboarding_skipped_at: null }] });
    expect(await setupFinishedElsewhere(d.client, "acc-twin", "ws-twin")).toBe(false);
  });

  it("is false for a person with only this one unfinished site", async () => {
    expect(await setupFinishedElsewhere(db().client, "acc-twin", "ws-twin")).toBe(false);
  });
});
