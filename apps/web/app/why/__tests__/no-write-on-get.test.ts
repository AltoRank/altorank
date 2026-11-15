// ---------------------------------------------------------------------------
// /why: a GET asks, only the button's POST answers
// ---------------------------------------------------------------------------
//
// Mail security scanners fetch every link in an inbound message, and the
// first answer to "what stopped you?" is the one kept: an answer written on
// GET would be a robot's. Same split as /hold.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

let db: FakeSupabase & { auth: { admin: { getUserById: (id: string) => Promise<unknown> } } };

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));
const { redirect, recordStep, recordEvent } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  }),
  recordStep: vi.fn(async (..._a: unknown[]) => true),
  recordEvent: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/onboarding/step-events", () => ({ recordOnboardingStep: (...a: unknown[]) => recordStep(...a), stepEventId: (w: string, s: string) => `${w}:${s}` }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: (...a: unknown[]) => recordEvent(...a) }));

import WhyPage from "../page";
import { answerWhy } from "../actions";
import { signWhy } from "@/lib/email/why-link";

const WS = "11111111-2222-4333-8444-555555555555";
const EMAIL = "owner@acme.example";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

beforeEach(() => {
  redirect.mockClear();
  recordStep.mockClear();
  recordEvent.mockClear();
  const base = fakeSupabase({
    workspaces: [{ id: WS, account_id: "acc-1", domain: "acme.example" }],
    account_members: [{ account_id: "acc-1", user_id: "u-owner" }],
  });
  db = Object.assign(base, {
    auth: { ...base.auth, admin: { getUserById: async (id: string) => ({ data: { user: id === "u-owner" ? { email: EMAIL } : null } }) } },
  });
});

const link = () => ({ w: WS, e: EMAIL, s: signWhy(WS, EMAIL)! });
function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("GET /why", () => {
  it("records nothing, even with a reason in the link", async () => {
    await WhyPage({ searchParams: Promise.resolve({ ...link(), r: "price" }) });
    expect(recordStep).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

describe("a /why button (POST)", () => {
  it("keeps the pick against the member whose address was signed, as an email answer", async () => {
    await expect(answerWhy(form({ ...link(), reason: "price" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(recordStep).toHaveBeenCalledWith(db, expect.objectContaining({ workspaceId: WS, accountId: "acc-1", userId: "u-owner", step: "gate_answer", props: { reason: "price", via: "email" } }));
    expect(recordEvent).not.toHaveBeenCalled();
    expect(redirect.mock.calls[0][0]).toContain("done=1");
  });

  it("keeps what the person typed, bounded, beside the pick", async () => {
    await expect(answerWhy(form({ ...link(), reason: "other", note: `  I  already have\na writer ${"x".repeat(600)}` }))).rejects.toThrow("NEXT_REDIRECT");
    const event = recordEvent.mock.calls[0][0] as { source: string; message: string };
    expect(event.source).toBe("onboarding.gate_answer");
    expect(event.message).toContain("Something else): I already have a writer");
    expect(event.message.length).toBeLessThan(600);
  });

  it("re-checks the signature: a forged form answers nothing", async () => {
    await expect(answerWhy(form({ ...link(), s: "0".repeat(32), reason: "price" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(recordStep).not.toHaveBeenCalled();
  });

  it("takes no reason off the list, and no answer for an address that left the account", async () => {
    await expect(answerWhy(form({ ...link(), reason: "because" }))).rejects.toThrow("NEXT_REDIRECT");
    db.tables.account_members.length = 0;
    await expect(answerWhy(form({ ...link(), reason: "price" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(recordStep).not.toHaveBeenCalled();
  });
});
