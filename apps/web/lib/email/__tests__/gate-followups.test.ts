import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// After the gate: the next articles a day later, the one question four days
// later, each once, only before the trial, and never to a site whose gate was
// first shown before the windows.

const { trialGate, latestRun, recipients, sendOnce, answered } = vi.hoisted(() => ({
  trialGate: vi.fn(async (..._a: unknown[]) => "gated"),
  latestRun: vi.fn(),
  recipients: vi.fn(async (..._a: unknown[]) => ["owner@acme.example"]),
  sendOnce: vi.fn(async (..._a: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 })),
  answered: vi.fn(async (..._a: unknown[]) => new Set<string>()),
}));
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: (...a: unknown[]) => trialGate(...a) }));
vi.mock("@/lib/onboarding/run-store", () => ({ latestRun: (...a: unknown[]) => latestRun(...a) }));
vi.mock("../account-recipients", () => ({ accountRecipients: (...a: unknown[]) => recipients(...a) }));
vi.mock("@/lib/onboarding/gate-answer-store", () => ({ gateAnswered: (...a: unknown[]) => answered(...a) }));
vi.mock("../send-once", async (orig) => ({ ...(await orig<typeof import("../send-once")>()), sendOnce: (...a: unknown[]) => sendOnce(...a) }));

import {
  followupDue,
  GATE_FOLLOWUP_TOPICS,
  GATE_FOLLOWUP_WHY,
  renderGateFollowupTopics,
  renderGateFollowupWhy,
  sweepGateFollowups,
  TOPICS_AFTER_MS,
  TOPICS_WITHIN_MS,
  WHY_AFTER_MS,
  WHY_WITHIN_MS,
} from "../gate-followups";
import { GATE_REASONS } from "@/lib/onboarding/step-props";

const WS = "11111111-2222-4333-8444-555555555555";
const NOW = Date.parse("2026-11-20T07:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const fresh = { topicsSent: false, whySent: false, answered: false, topics: 2 };

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("followupDue", () => {
  it("leaves the first day alone, then names the next articles, then asks", () => {
    expect(followupDue(NOW - 5 * HOUR, NOW, fresh)).toBeNull();
    expect(followupDue(NOW - TOPICS_AFTER_MS, NOW, fresh)).toBe("topics");
    expect(followupDue(NOW - TOPICS_WITHIN_MS - HOUR, NOW, fresh)).toBeNull();
    expect(followupDue(NOW - WHY_AFTER_MS, NOW, { ...fresh, topicsSent: true })).toBe("why");
  });

  it("does not name articles when there is none to name, and still asks later", () => {
    expect(followupDue(NOW - TOPICS_AFTER_MS, NOW, { ...fresh, topics: 0 })).toBeNull();
    expect(followupDue(NOW - WHY_AFTER_MS, NOW, { ...fresh, topics: 0 })).toBe("why");
  });

  it("sends each once, and never asks a site that has answered", () => {
    expect(followupDue(NOW - TOPICS_AFTER_MS, NOW, { ...fresh, topicsSent: true })).toBeNull();
    expect(followupDue(NOW - WHY_AFTER_MS, NOW, { ...fresh, whySent: true })).toBeNull();
    expect(followupDue(NOW - WHY_AFTER_MS, NOW, { ...fresh, answered: true })).toBeNull();
  });

  it("writes to nobody whose gate was first shown before the windows", () => {
    // Every signup from before this shipped: no backlog of old accounts.
    expect(followupDue(NOW - WHY_WITHIN_MS - HOUR, NOW, fresh)).toBeNull();
    expect(followupDue(Date.parse("2026-09-22T10:00:00Z"), NOW, fresh)).toBeNull();
  });
});

describe("the two emails", () => {
  const facts = {
    workspaceId: WS,
    domain: "acme-clinic.example",
    title: "Trigger Finger: Causes & Treatment",
    live: false,
    topics: [{ term: "trigger finger treatment", volume: 4400 }, { term: "knee support for torn meniscus", volume: null }],
  };

  it("names the next articles with how often each is searched, and promises no traffic", () => {
    const e = renderGateFollowupTopics(facts, "owner@acme.example");
    expect(e.subject).toBe("Your next articles for acme-clinic.example");
    expect(e.html).toContain("<strong>trigger finger treatment</strong>, searched about 4,400 times a month");
    // No count, no claim about it.
    expect(e.html).toContain("<strong>knee support for torn meniscus</strong></p>");
    expect(e.html).toContain("A card is required, €0 is charged today, then €69/month");
    expect(e.html).not.toMatch(/\b(traffic|rank(s|ed|ing)?|visitors|guarantee[ds]?)\b/i);
    expect(e.html).toContain("/why?w=" + WS);
    expect(e.footerNote).toContain("At most one more email follows");
  });

  it("says so when the owner already put the first article on their site", () => {
    expect(renderGateFollowupTopics({ ...facts, live: true }, "owner@acme.example").html).toContain("You put it on your site");
    expect(renderGateFollowupTopics(facts, "owner@acme.example").html).not.toContain("You put it on your site");
  });

  it("asks the one question, each answer a link signed for this recipient", () => {
    const e = renderGateFollowupWhy(facts, "owner@acme.example");
    expect(e.subject).toBe("What stopped you?");
    for (const reason of GATE_REASONS) expect(e.html).toContain(`r=${reason}`);
    expect(e.html).toContain("e=owner%40acme.example");
    expect(e.footerNote).toContain("last email");
    // Another member's links are their own.
    expect(renderGateFollowupWhy(facts, "other@acme.example").html).not.toContain("e=owner%40acme.example");
  });
});

describe("sweepGateFollowups", () => {
  /** A client answering the sweep's reads from what the test seeds. */
  function client(seed: { visits: Array<{ workspace_id: string; account_id: string; seen_at: string }>; sent?: Array<{ workspace_id: string; email_type: string }>; status?: string }) {
    const chain = (result: unknown) => {
      const c: Record<string, unknown> = {};
      for (const k of ["select", "eq", "gte", "in", "order", "limit"]) c[k] = () => c;
      c.maybeSingle = async () => result;
      c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return c;
    };
    return {
      from(table: string) {
        if (table === "gate_visits") return chain({ data: seed.visits, error: null });
        if (table === "sent_emails") return chain({ data: seed.sent ?? [], error: null });
        if (table === "workspaces") return chain({ data: { domain: "acme-clinic.example", status: seed.status ?? "on" } });
        if (table === "keywords") return chain({ data: [{ term: "trigger finger treatment", volume: 4400 }] });
        return chain({ data: null });
      },
    } as never;
  }
  const visit = (agoMs: number) => ({ workspace_id: WS, account_id: "acc-1", seen_at: new Date(NOW - agoMs).toISOString() });
  const run = {
    run: { planned: [{ term: "osteochondritis dissecans", date: "2026-11-19" }] },
    article: { id: "a1", title: "Osteochondritis Dissecans", keyword: "osteochondritis dissecans", word_count: 1500, status: "review" },
    held: { count: 1, dates: [], topics: ["trigger finger treatment"] },
  };

  beforeEach(() => {
    trialGate.mockReset().mockResolvedValue("gated");
    latestRun.mockReset().mockResolvedValue(run);
    recipients.mockClear();
    sendOnce.mockClear();
    answered.mockReset().mockResolvedValue(new Set());
  });

  it("sends the next-articles email a day after the gate, once per site", async () => {
    const lines = await sweepGateFollowups(client({ visits: [visit(26 * HOUR)] }), new Date(NOW));
    expect(sendOnce).toHaveBeenCalledTimes(1);
    expect(sendOnce.mock.calls[0][2]).toMatchObject({ type: GATE_FOLLOWUP_TOPICS, subjectId: WS, category: "product", workspaceId: WS });
    expect(lines).toEqual(["acme-clinic.example: topics, emailed 1"]);
    const render = sendOnce.mock.calls[0][3] as (r: string) => { html: string };
    expect(render("owner@acme.example").html).toContain("trigger finger treatment</strong>, searched about 4,400 times a month");
  });

  it("asks the question on day four, and not of a site that has answered", async () => {
    const seed = { visits: [visit(4 * 24 * HOUR + HOUR)], sent: [{ workspace_id: WS, email_type: GATE_FOLLOWUP_TOPICS }] };
    await sweepGateFollowups(client(seed), new Date(NOW));
    expect(sendOnce.mock.calls[0][2]).toMatchObject({ type: GATE_FOLLOWUP_WHY });
    sendOnce.mockClear();
    answered.mockResolvedValue(new Set([WS]));
    expect(await sweepGateFollowups(client(seed), new Date(NOW))).toEqual([]);
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it("counts from the first visit: a return this week to an old gate is not a new arrival", async () => {
    await sweepGateFollowups(client({ visits: [visit(40 * 24 * HOUR), visit(26 * HOUR)] }), new Date(NOW));
    expect(sendOnce).not.toHaveBeenCalled();
    expect(latestRun).not.toHaveBeenCalled();
  });

  it("writes to nobody whose trial started, whose site is paused, or who has no article", async () => {
    trialGate.mockResolvedValue("open");
    await sweepGateFollowups(client({ visits: [visit(26 * HOUR)] }), new Date(NOW));
    trialGate.mockResolvedValue("gated");
    await sweepGateFollowups(client({ visits: [visit(26 * HOUR)], status: "paused" }), new Date(NOW));
    latestRun.mockResolvedValue({ run: { planned: [] }, article: null });
    await sweepGateFollowups(client({ visits: [visit(26 * HOUR)] }), new Date(NOW));
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it("never throws: a database without the visits table sends nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = { from: () => { throw new Error("relation gate_visits does not exist"); } } as never;
    expect(await sweepGateFollowups(broken, new Date(NOW))).toEqual([]);
  });
});
