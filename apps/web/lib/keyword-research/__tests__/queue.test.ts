import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The qualified queue is kept short and refilled on demand. Verdicts are
 * bought for the best unjudged candidates only until the queue holds what
 * the pace will use; a refusal parks the row; a parked row parked by a
 * verdict or a person is never a candidate again; a row parked for want of
 * a verdict comes back on its own when judged good.
 */

const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("../opportunity", async (original) => ({ ...(await original<object>()), qualifyOpportunities: qualify }));

// The module under test is imported before the mocked module on purpose: with
// the order reversed this file's own import of "../opportunity" resolved
// first and queue.ts received the unmocked function (measured 2026-09-15).

import { countReady, isParkedForGood, isRequalifiable, parkKeywords, queueTarget, refillQualifiedQueue, unjudgedVerdict, QUEUE_MIN, type QueueRow } from "../queue";
import { contextKey, OPPORTUNITY_VERSION, type Opportunity } from "../opportunity";

const context = { domain: "x.co", languageCode: "en", locationCode: 2840, business: { description: "X sells order picking software to Shopify merchants." } };
const fp = contextKey(context);
const now = () => new Date().toISOString();
const verdict = (status: Opportunity["status"], cause?: Opportunity["cause"], over: Partial<Opportunity> = {}): Opportunity => ({
  version: OPPORTUNITY_VERSION, context: fp, checkedAt: now(), status, reason: "r", cause,
  ...(status === "qualified" ? { audience: "a", buyingJob: "b", offering: "o", angle: "Angle", format: "article", evidenceUrls: ["https://a.test/1", "https://b.test/2"], organicUrls: ["https://a.test/1", "https://b.test/2", "https://c.test/3"] } : {}),
  ...over,
});
const row = (id: string, over: Partial<QueueRow> = {}): QueueRow => ({ id, term: `term ${id}`, status: "new", ...over });

/** Records every write; answers reads with what the test put in. */
const writes: Array<{ table: string; op: string; patch?: unknown; filters: unknown[] }> = [];
let entries: Array<{ id: string }> = [];
let readyRows: QueueRow[] = [];
const db = {
  from: (table: string) => {
    const filters: unknown[] = [];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: (...a: unknown[]) => { filters.push(a); return chain; }, in: (...a: unknown[]) => { filters.push(a); return chain; },
      is: self, not: self,
      update: (patch: unknown, opts?: { count?: string }) => { writes.push({ table, op: "update", patch, filters }); return Object.assign(chain, { then: (r: (v: unknown) => unknown) => r({ error: null, count: opts?.count ? 1 : null }) }); },
      delete: () => { writes.push({ table, op: "delete", filters }); return chain; },
      then: (r: (v: unknown) => unknown) => r({ data: table === "calendar_entries" ? entries : table === "keywords" ? readyRows : [], error: null, count: 1 }),
    });
    return chain;
  },
} as never;

beforeEach(() => { qualify.mockClear(); qualify.mockImplementation(async () => new Map()); writes.length = 0; entries = []; readyRows = []; });

describe("queueTarget", () => {
  it("is about ten days of the pace, never under the floor", () => {
    expect(queueTarget(7)).toBe(10);
    expect(queueTarget(3)).toBe(5);
    expect(queueTarget(1)).toBe(QUEUE_MIN);
    expect(queueTarget(0)).toBe(QUEUE_MIN);
    expect(queueTarget(null)).toBe(10);
  });
});

describe("parked rows", () => {
  it("a verdict parks for good; a person parks for good; only 'unjudged' comes back", () => {
    expect(isParkedForGood(row("a", { plan_excluded_at: now(), opportunity: verdict("rejected", "buyer_mismatch") }))).toBe(true);
    expect(isParkedForGood(row("b", { plan_excluded_at: now() }))).toBe(true);
    expect(isRequalifiable(row("c", { plan_excluded_at: now(), opportunity: unjudgedVerdict(fp) }))).toBe(true);
    expect(isRequalifiable(row("d"))).toBe(false);
    // A rejection whose TTL lapsed is still a rejection.
    expect(isParkedForGood(row("e", { plan_excluded_at: now(), opportunity: verdict("rejected", "buyer_mismatch", { checkedAt: "2020-01-01T00:00:00.000Z" }) }))).toBe(true);
  });

  it("parkKeywords takes the row off the calendar, stamps it, and keeps the verdict", async () => {
    entries = [{ id: "ce-1" }];
    const out = await parkKeywords(db, "ws", [{ id: "k1", verdict: verdict("rejected", "buyer_mismatch") }]);
    expect(out).toEqual({ parked: 1, entriesRemoved: 1 });
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual(["calendar_entries:delete", "keywords:update"]);
    const patch = writes[1].patch as { status: string; plan_excluded_at: string; opportunity: Opportunity };
    expect(patch.status).toBe("stored");
    expect(patch.plan_excluded_at).toEqual(expect.any(String));
    expect(patch.opportunity.cause).toBe("buyer_mismatch");
  });
});

describe("refillQualifiedQueue", () => {
  it("buys nothing when the queue already holds the target", async () => {
    const candidates = [row("a", { opportunity: verdict("qualified") }), row("b", { opportunity: verdict("qualified") }), row("c", { opportunity: verdict("qualified") }), row("d")];
    const out = await refillQualifiedQueue(db, "ws", candidates, context, { target: 3 });
    expect(out).toMatchObject({ ready: 3, judged: 0, qualified: 0, parked: 0 });
    expect(qualify).not.toHaveBeenCalled();
  });

  it("judges the best unjudged candidates, three per topic needed, and stops when the target is met", async () => {
    qualify.mockImplementation(async (_db: unknown, _ws: string, asked: Array<{ id: string }>) =>
      new Map(asked.map((c, i) => [c.id, i === 0 ? verdict("qualified") : verdict("rejected", "not_editorial")])));
    const candidates = Array.from({ length: 12 }, (_, i) => row(`c${i}`));
    const out = await refillQualifiedQueue(db, "ws", candidates, context, { target: 1 });
    expect(qualify).toHaveBeenCalledOnce();
    expect((qualify.mock.calls[0][2] as unknown[]).length).toBe(3);
    expect(out).toMatchObject({ ready: 1, judged: 3, qualified: 1, parked: 2 });
    // The two refusals are parked with their verdicts.
    expect(writes.filter((w) => w.table === "keywords" && w.op === "update")).toHaveLength(2);
  });

  it("buys a second batch when the first did not fill the queue, and no more than the batch cap", async () => {
    qualify.mockImplementation(async (_db: unknown, _ws: string, asked: Array<{ id: string }>) => new Map(asked.map((c) => [c.id, verdict("rejected", "buyer_mismatch")])));
    const candidates = Array.from({ length: 40 }, (_, i) => row(`c${i}`));
    const out = await refillQualifiedQueue(db, "ws", candidates, context, { target: 2 });
    expect(qualify).toHaveBeenCalledTimes(2);
    expect(out.ready).toBe(0);
    expect(out.judged).toBe(12);
  });

  it("never asks about a row a verdict or a person parked, and returns a parked-unjudged row to the queue when it qualifies", async () => {
    qualify.mockImplementation(async (_db: unknown, _ws: string, asked: Array<{ id: string }>) => new Map(asked.map((c) => [c.id, verdict("qualified")])));
    const candidates = [
      row("gone", { plan_excluded_at: now(), opportunity: verdict("rejected", "buyer_mismatch") }),
      row("byhand", { plan_excluded_at: now() }),
      row("sediment", { status: "stored", plan_excluded_at: now(), opportunity: unjudgedVerdict(fp) }),
    ];
    const out = await refillQualifiedQueue(db, "ws", candidates, context, { target: 1 });
    expect((qualify.mock.calls[0][2] as Array<{ id: string }>).map((c) => c.id)).toEqual(["sediment"]);
    expect(out.ready).toBe(1);
    const unparked = writes.find((w) => w.table === "keywords" && (w.patch as { status?: string }).status === "new");
    expect(unparked?.patch).toEqual({ status: "new", plan_excluded_at: null });
  });

  it("leaves a pending verdict for the next run without parking it", async () => {
    qualify.mockImplementation(async (_db: unknown, _ws: string, asked: Array<{ id: string }>) => new Map(asked.map((c) => [c.id, verdict("pending", "provider_error")])));
    const out = await refillQualifiedQueue(db, "ws", [row("a")], context, { target: 1 });
    expect(out).toMatchObject({ ready: 0, judged: 1, parked: 0 });
    expect(writes).toHaveLength(0);
  });
});

describe("countReady", () => {
  it("counts only current qualified verdicts on open rows", async () => {
    readyRows = [row("a", { opportunity: verdict("qualified") }), row("b", { opportunity: verdict("qualified", undefined, { context: "other" }) }), row("c", { opportunity: verdict("rejected", "buyer_mismatch") })];
    expect(await countReady(db, "ws", context)).toBe(1);
  });
});
