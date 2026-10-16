import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The exchange cron expired a `matched` status nothing writes, and never
// released an `accepted` claim whose draft-writing function was killed: the
// request stayed claimed by a host that would never deliver. It now releases
// stale claims with no draft and expires only open (`requested`) requests.

type Row = {
  id: string;
  status: string;
  provider_account_id: string | null;
  provider_workspace_id: string | null;
  provider_article_id: string | null;
  matched_at: string | null;
  expires_at: string;
};

const db = vi.hoisted(() => ({ rows: [] as Row[] }));

/** Just enough of PostgREST's update builder: eq / is / lt filters, then select. */
function updateBuilder(values: Partial<Row>) {
  const filters: Array<(r: Row) => boolean> = [];
  const b = {
    eq: (c: keyof Row, v: unknown) => (filters.push((r) => r[c] === v), b),
    in: (c: keyof Row, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
    is: (c: keyof Row, v: null) => (filters.push((r) => r[c] === v), b),
    lt: (c: keyof Row, v: string) => (filters.push((r) => r[c] !== null && String(r[c]) < v), b),
    select: async () => {
      const hit = db.rows.filter((r) => filters.every((f) => f(r)));
      for (const r of hit) Object.assign(r, values);
      return { data: hit.map((r) => ({ id: r.id })), error: null };
    },
  };
  return b;
}

vi.mock("@/lib/cron-auth", () => ({ isAuthorizedCron: () => true }));
vi.mock("@/lib/observability/cron", () => ({ observedCron: (_s: string, h: unknown) => h }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: () => ({ update: (v: Partial<Row>) => updateBuilder(v) }) }),
}));

const NOW = new Date("2026-10-16T09:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

const row = (over: Partial<Row>): Row => ({
  id: "x",
  status: "requested",
  provider_account_id: null,
  provider_workspace_id: null,
  provider_article_id: null,
  matched_at: null,
  expires_at: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cron/exchange", () => {
  it("releases a claim whose draft never arrived, and leaves a fresh or delivered one", async () => {
    db.rows = [
      row({ id: "stale", status: "accepted", provider_account_id: "host", provider_workspace_id: "ws", matched_at: ago(3 * HOUR) }),
      row({ id: "fresh", status: "accepted", provider_account_id: "host", provider_workspace_id: "ws", matched_at: ago(5 * 60 * 1000) }),
      row({ id: "delivered", status: "accepted", provider_account_id: "host", provider_workspace_id: "ws", provider_article_id: "a1", matched_at: ago(3 * HOUR) }),
    ];
    const { GET } = await import("../exchange/route");
    const body = await (await GET(new Request("http://x/api/cron/exchange"))).json();
    expect(body.released).toBe(1);
    const byId = Object.fromEntries(db.rows.map((r) => [r.id, r]));
    expect(byId.stale).toMatchObject({ status: "requested", provider_account_id: null, provider_workspace_id: null, matched_at: null });
    expect(byId.fresh.status).toBe("accepted");
    expect(byId.delivered.status).toBe("accepted");
  });

  it("expires open requests past their date, including one just released", async () => {
    db.rows = [
      row({ id: "old", expires_at: ago(HOUR) }),
      row({ id: "open" }),
      row({ id: "stale-old", status: "accepted", provider_account_id: "host", matched_at: ago(3 * HOUR), expires_at: ago(HOUR) }),
    ];
    const { GET } = await import("../exchange/route");
    const body = await (await GET(new Request("http://x/api/cron/exchange"))).json();
    expect(body.expired).toBe(2);
    expect(db.rows.find((r) => r.id === "open")!.status).toBe("requested");
  });
});
