import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_ANSWER_NOTE_MAX, GATE_REASON_LABELS, gateAnswerNote, isGateReason } from "../gate-answer";
import { GATE_REASONS } from "../step-props";
import { readWhyParams, signWhy, whyUrl } from "@/lib/email/why-link";

const WS = "11111111-2222-4333-8444-555555555555";

describe("what stopped you: the words", () => {
  it("has a label for every reason, each said once", () => {
    expect(Object.keys(GATE_REASON_LABELS).sort()).toEqual([...GATE_REASONS].sort());
    expect(new Set(Object.values(GATE_REASON_LABELS)).size).toBe(GATE_REASONS.length);
  });

  it("takes only a reason on the list", () => {
    expect(isGateReason("price")).toBe(true);
    expect(isGateReason("because")).toBe(false);
    expect(isGateReason(null)).toBe(false);
  });

  it("keeps a note trimmed and bounded, and nothing for nothing", () => {
    expect(gateAnswerNote("  too   expensive\nfor now ")).toBe("too expensive for now");
    expect(gateAnswerNote("x".repeat(GATE_ANSWER_NOTE_MAX + 50))).toHaveLength(GATE_ANSWER_NOTE_MAX);
    expect(gateAnswerNote("   ")).toBeNull();
    expect(gateAnswerNote(undefined)).toBeNull();
  });
});

describe("the /why link", () => {
  beforeAll(() => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
    process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
  });
  afterAll(() => {
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it("round-trips the site, the address and the reason the mail named", () => {
    const url = new URL(whyUrl(WS, "Owner@Acme.example", "card")!);
    expect(url.pathname).toBe("/why");
    expect(readWhyParams(url.searchParams)).toEqual({ ok: true, workspaceId: WS, email: "owner@acme.example", reason: "card" });
  });

  it("refuses another address, another site, and a reason that is not one", () => {
    const s = signWhy(WS, "owner@acme.example")!;
    expect(readWhyParams(new URLSearchParams({ w: WS, e: "someone@else.example", s })).ok).toBe(false);
    expect(readWhyParams(new URLSearchParams({ w: WS.replace("1", "2"), e: "owner@acme.example", s })).ok).toBe(false);
    expect(readWhyParams(new URLSearchParams({ w: WS, e: "owner@acme.example", s, r: "because" }))).toMatchObject({ ok: true, reason: null });
    expect(readWhyParams(new URLSearchParams({ w: WS, e: "owner@acme.example" })).ok).toBe(false);
  });
});
