import { beforeEach, describe, expect, it, vi } from "vitest";
const { quota, generate, schedule, wake, sweep } = vi.hoisted(() => ({ quota: vi.fn(), generate: vi.fn(), schedule: vi.fn(), wake: vi.fn(), sweep: vi.fn() }));
vi.mock("@/lib/billing/quota", () => ({ getQuota: quota }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: generate }));
vi.mock("@/lib/content/stale-drafts", () => ({ sweepStaleDrafts: sweep }));
vi.mock("@/lib/content/fan-out", () => ({ selfInvocation: () => ({}), selfInvoke: wake }));
vi.mock("../plan", () => ({ schedulePlan: schedule, fulfilPlannedEntry: async (db: ReturnType<typeof database>, id: string, article: string) => { await db.from("calendar_entries").update({ article_id: article }).eq("id", id); } }));
import { prepareFirstMonthStep, queueFirstMonth } from "../first-month";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Relational fixture permits heterogeneous table columns.
type Row = Record<string, any>; // A small relational fixture, not provider output.
let tables: Record<string, Row[]>;
function database() {
  return { from(table: string) {
    let filter: (row: Row) => boolean = () => true;
    let values: Row | undefined;
    let inserted: Row[] | undefined;
    let single = false;
    let cap = Infinity;
    const where = (predicate: (row: Row) => boolean) => { const before = filter; filter = row => before(row) && predicate(row); return q; };
    const q = {
      select: () => q, order: () => q,
      eq: (key: string, value: unknown) => where(row => row[key] === value),
      in: (key: string, value: unknown[]) => where(row => value.includes(row[key])),
      is: (key: string, value: unknown) => where(row => (row[key] ?? null) === value),
      not: (key: string) => where(row => row[key] != null),
      gte: (key: string, value: string) => where(row => row[key] >= value),
      lt: (key: string, value: string) => where(row => row[key] < value),
      limit: (limit: number) => (cap = limit, q),
      maybeSingle: () => (single = true, q), single: () => (single = true, q),
      update: (patch: Row) => (values = patch, q),
      upsert: (rows: Row | Row[]) => (inserted = Array.isArray(rows) ? rows : [rows], q),
      then: (resolve: (result: unknown) => unknown) => {
        const rows = tables[table] ??= [];
        if (inserted) for (const row of inserted) {
          if (!rows.some(existing => existing.workspace_id === row.workspace_id && existing.entry_id === row.entry_id)) rows.push({ ...row, status: "queued" });
        }
        const matches = rows.filter(filter).slice(0, cap);
        if (values) matches.forEach(row => Object.assign(row, values));
        return resolve({ data: single ? matches[0] ?? null : matches, count: matches.length, error: null });
      },
    };
    return q;
  } };
}
const step = () => prepareFirstMonthStep(database() as never, "site-a", "lease-a");
beforeEach(() => {
  vi.clearAllMocks();
  quota.mockResolvedValue({ reason: "plan", remaining: 99, limit: 100, used: 1 });
  wake.mockResolvedValue({ ok: true });
  tables = {
    workspaces: [{ id: "site-a", account_id: "account", auto_generate: true, auto_generate_weekly_limit: 7 }, { id: "site-b", account_id: "other-account", auto_generate: true, auto_generate_weekly_limit: 7 }],
    onboarding_runs: [{ workspace_id: "site-a", article_id: "preview" }],
    first_month_runs: [{ workspace_id: "site-a", starts_on: "2026-09-13", status: "writing", planned: true, lease: "lease-a", planning_attempts: 0 }],
    first_month_jobs: [], calendar_entries: [], keywords: [],
    articles: [{ id: "preview", workspace_id: "site-a", keyword_id: "first", status: "review" }],
  };
  generate.mockImplementation(async ({ keywordId }) => {
    const articleId = `article-${keywordId}`;
    tables.articles.push({ id: articleId, workspace_id: "site-a", keyword_id: keywordId, status: "review" });
    return { articleId };
  });
});
function jobs(count: number) {
  for (let i = 0; i < count; i++) {
    tables.first_month_jobs.push({ id: `job${i}`, entry_id: `entry${i}`, workspace_id: "site-a", status: "queued", attempts: 0 });
    tables.calendar_entries.push({ id: `entry${i}`, workspace_id: "site-a", keyword_id: `keyword${i}`, keyword: `topic${i}`, status: "queue", scheduled_date: "2026-09-15", article_id: null });
    tables.keywords.push({ id: `keyword${i}`, workspace_id: "site-a", opportunity: { status: "qualified" } });
  }
}
describe("first-month preparation", () => {
  it("activation is idempotent, raises the default pace and leaves another account alone", async () => {
    tables.first_month_runs = [];
    const db = database() as never;
    await queueFirstMonth(db, "account", "starter");
    await queueFirstMonth(db, "account", "starter");
    expect(tables.first_month_runs).toHaveLength(1);
    expect(tables.workspaces.map(row => row.auto_generate_weekly_limit)).toEqual([14, 7]);
    expect(tables.articles.map(row => row.id)).toEqual(["preview"]);
  });
  it("preserves a custom publishing pace", async () => {
    tables.first_month_runs = [];
    tables.workspaces[0].auto_generate_weekly_limit = 2;
    await queueFirstMonth(database() as never, "account", "starter");
    expect(tables.workspaces[0].auto_generate_weekly_limit).toBe(2);
  });
  it("a repeated activation does not overwrite a pace the customer changed afterwards", async () => {
    tables.first_month_runs = [];
    await queueFirstMonth(database() as never, "account", "starter");
    tables.workspaces[0].auto_generate_weekly_limit = 7;
    await queueFirstMonth(database() as never, "account", "starter");
    expect(tables.workspaces[0].auto_generate_weekly_limit).toBe(7);
  });
  it.each(["no-plan", "empty-quota", "paused"])("does not write for %s", async reason => {
    jobs(1);
    if (reason === "no-plan") quota.mockResolvedValue({ reason: "no-plan", remaining: 6 });
    if (reason === "empty-quota") quota.mockResolvedValue({ reason: "plan", remaining: 0 });
    if (reason === "paused") tables.workspaces[0].auto_generate = false;
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_runs[0].status).toBe("blocked");
  });
  it("prepares more than the old six-draft batch, one invocation at a time, preserving the preview", async () => {
    jobs(9);
    for (let i = 0; i < 10; i++) { tables.first_month_runs[0].lease = "lease-a"; await step(); }
    expect(generate).toHaveBeenCalledTimes(9);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ autonomous: true, verifySourceClaims: true, billToAccountId: "account" }));
    expect(tables.first_month_runs[0].status).toBe("ready");
    expect(tables.first_month_jobs.every(job => job.status === "ready")).toBe(true);
    expect(tables.articles[0].id).toBe("preview");
    expect(tables.articles.every(article => article.status === "review")).toBe(true);
  });
  it("recovers a saved article after a lost response instead of writing it again", async () => {
    jobs(1);
    tables.first_month_jobs[0].attempts = 2;
    tables.articles.push({ id: "already-saved", workspace_id: "site-a", keyword_id: "keyword0", status: "review" });
    await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.calendar_entries[0].article_id).toBe("already-saved");
  });
  it("finishes a fully saved month when the final article used the last allowance", async () => {
    jobs(1);
    tables.first_month_jobs[0].status = "ready";
    quota.mockResolvedValue({ reason: "plan", remaining: 0 });
    await step();
    expect(tables.first_month_runs[0].status).toBe("ready");
    expect(tables.first_month_runs[0].lease).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not spend on unsupported topics and exposes failure after bounded attempts", async () => {
    jobs(1); tables.keywords[0].opportunity.status = "pending";
    await step(); tables.first_month_runs[0].lease = "lease-a"; await step();
    tables.first_month_runs[0].lease = "lease-a"; await step();
    expect(generate).not.toHaveBeenCalled();
    expect(tables.first_month_jobs[0].status).toBe("failed");
    expect(tables.first_month_runs[0].status).toBe("attention");
  });
  it("budgets existing queued topics before adding more and keeps the fixed month", async () => {
    jobs(2); tables.first_month_runs[0].planned = false;
    quota.mockResolvedValue({ reason: "plan", remaining: 3 });
    await step();
    expect(schedule).toHaveBeenCalledWith(expect.anything(), "site-a", 7, expect.objectContaining({ mode: "fill-month", from: new Date("2026-09-13T00:00:00Z"), maxEntries: 1 }));
    expect(generate).not.toHaveBeenCalled();
  });
});
