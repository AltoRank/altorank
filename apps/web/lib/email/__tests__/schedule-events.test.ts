import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import {
  announceNothingWritten,
  announcePausedSites,
  nothingWrittenReason,
  remindEndingPauses,
  PAUSE_REMINDER_DAYS,
} from "../schedule-events";

type Row = Record<string, unknown>;

const claimed = new Set<string>();
let workspaceRows: Row[] = [];
/** Filters the caller applied to `workspaces`, so a test can assert the window. */
let workspaceFilters: [string, unknown][] = [];
let members: { user_id: string; role: string; workspace_ids: string[] | null }[] = [];
let emails: Record<string, string> = {};

function client() {
  return {
    from(table: string) {
      if (table === "workspaces") {
        const q: Record<string, unknown> = {};
        const record = (op: string) => (c: string, v?: unknown) => (workspaceFilters.push([`${op} ${c}`, v]), q);
        Object.assign(q, {
          select: () => q,
          eq: record("eq"),
          not: (c: string, o: string, v: unknown) => (workspaceFilters.push([`not ${c} ${o}`, v]), q),
          gte: record("gte"),
          lte: record("lte"),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: workspaceRows, error: null }),
        });
        return q as never;
      }
      if (table === "agencies") {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: { name: "Acme" }, error: null }),
        });
        return q as never;
      }
      if (table === "agency_members") {
        return { select: () => ({ eq: async () => ({ data: members, error: null }) }) } as never;
      }
      if (table === "email_preferences") {
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) } as never;
      }
      if (table === "sent_emails") {
        return {
          insert: async (row: Row) => {
            const key = `${row.email_type}|${row.subject_id}|${row.recipient}`;
            if (claimed.has(key)) return { error: { code: "23505", message: "duplicate" } };
            claimed.add(key);
            return { error: null };
          },
          delete: () => {
            const chain = { eq: () => chain, then: (r: (v: unknown) => unknown) => r({ error: null }) };
            return chain;
          },
        } as never;
      }
      throw new Error(`unexpected table ${table}`);
    },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: emails[id] } } }) } },
  } as never;
}

function sends() {
  return sendTransactionalEmail.mock.calls.map((c) => ({ to: c[0], subject: c[1], html: c[2] }));
}

beforeEach(() => {
  claimed.clear();
  workspaceRows = [];
  workspaceFilters = [];
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  members = [
    { user_id: "u1", role: "owner", workspace_ids: null },
    { user_id: "u2", role: "editor", workspace_ids: null },
  ];
  emails = { u1: "owner@acme.co", u2: "editor@acme.co" };
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});

describe("remindEndingPauses", () => {
  const today = new Date("2026-09-06T07:00:00Z");

  it("warns the owners before Stripe starts collecting again", async () => {
    workspaceRows = [{ agency_id: "ag-1", paused_until: "2026-09-08" }];
    const out = await remindEndingPauses(client(), today);

    expect(out).toEqual([{ agencyId: "ag-1", pausedUntil: "2026-09-08", emailed: "emailed 1" }]);
    expect(sends()[0].to).toBe("owner@acme.co");
    expect(sends()[0].subject).toBe("Your pause ends in 2 days");
    expect(sends()[0].html).toContain("September 8, 2026");
  });

  /** Billing is owner and admin business; an editor cannot open that page. */
  it("does not tell an editor", async () => {
    workspaceRows = [{ agency_id: "ag-1", paused_until: "2026-09-08" }];
    await remindEndingPauses(client(), today);
    expect(sends().some((s) => s.to === "editor@acme.co")).toBe(false);
  });

  /** A window, not a single day, so a missed cron run does not lose it. */
  it("asks for the next few days, starting tomorrow", async () => {
    await remindEndingPauses(client(), today);
    expect(workspaceFilters).toContainEqual(["gte paused_until", "2026-09-07"]);
    expect(workspaceFilters).toContainEqual([
      "lte paused_until",
      new Date(today.getTime() + PAUSE_REMINDER_DAYS * 86400000).toISOString().slice(0, 10),
    ]);
  });

  it("sends one email per account, not per site", async () => {
    workspaceRows = [
      { agency_id: "ag-1", paused_until: "2026-09-08" },
      { agency_id: "ag-1", paused_until: "2026-09-08" },
      { agency_id: "ag-1", paused_until: "2026-09-09" },
    ];
    await remindEndingPauses(client(), today);
    expect(sends()).toHaveLength(1);
  });

  it("does not repeat across the four daily runs inside the window", async () => {
    workspaceRows = [{ agency_id: "ag-1", paused_until: "2026-09-08" }];
    const c = client();
    await remindEndingPauses(c, today);
    await remindEndingPauses(c, new Date("2026-09-06T13:00:00Z"));
    await remindEndingPauses(c, new Date("2026-09-07T01:00:00Z"));
    expect(sends()).toHaveLength(1);
  });
});

describe("nothingWrittenReason", () => {
  it("maps the skips a customer can fix", () => {
    expect(nothingWrittenReason("weekly limit is 0")).toBe("pace-zero");
    expect(nothingWrittenReason("no keywords tracked for this workspace")).toBe("no-keywords");
    expect(nothingWrittenReason("no keyword qualifies: all are covered, already ranking")).toBe("queue-exhausted");
  });

  /**
   * Silence is right for the rest. "Nothing was written because you are out of
   * quota" is the billing emails' job, and "the run limit was reached" is ours,
   * not theirs.
   */
  it("stays quiet about skips that are not theirs to fix", () => {
    expect(nothingWrittenReason("run limit reached (4); the next run starts here")).toBeNull();
    expect(nothingWrittenReason("weekly limit reached: 4 of 4 written")).toBeNull();
    expect(nothingWrittenReason("You have used all 100 articles on your plan")).toBeNull();
    expect(nothingWrittenReason("the site could not be read well enough to judge which keywords are on-topic")).toBeNull();
  });
});

describe("announceNothingWritten", () => {
  const scope = { agencyId: "ag-1", workspaceId: "ws-1", domain: "acme.com" };

  it("says which reason, and what to do about it", async () => {
    const line = await announceNothingWritten(client(), scope, "no-keywords");
    expect(line).toBe("emailed 2");
    expect(sends()[0].subject).toBe("Nothing is being written for acme.com");
    expect(sends()[0].html).toContain("https://app.altorank.co/keywords");
  });

  /** Four runs a day over the same skipped site is one email a week. */
  it("sends at most once a week per site", async () => {
    const c = client();
    const monday = new Date("2026-09-07T07:00:00Z");
    await announceNothingWritten(c, scope, "no-keywords", null, monday);
    await announceNothingWritten(c, scope, "no-keywords", null, new Date("2026-09-07T19:00:00Z"));
    await announceNothingWritten(c, scope, "no-keywords", null, new Date("2026-09-10T07:00:00Z"));
    expect(sends()).toHaveLength(2); // two members, one email each

    await announceNothingWritten(c, scope, "no-keywords", null, new Date("2026-09-15T07:00:00Z"));
    expect(sends()).toHaveLength(4);
  });
});

describe("announcePausedSites", () => {
  it("covers the sites the cron's own query filters out", async () => {
    workspaceRows = [{ id: "ws-1", domain: "acme.com", agency_id: "ag-1", paused_until: "2026-10-01" }];
    const lines = await announcePausedSites(client(), new Date("2026-09-07T07:00:00Z"));

    expect(lines).toEqual(["acme.com: emailed 2"]);
    expect(sends()[0].subject).toBe("acme.com is paused, so nothing is being written");
    expect(sends()[0].html).toContain("October 1, 2026");
    expect(workspaceFilters).toContainEqual(["eq auto_generate", true]);
    expect(workspaceFilters).toContainEqual(["eq status", "paused"]);
  });

  it("says nothing when no paused site is set to write", async () => {
    workspaceRows = [];
    expect(await announcePausedSites(client())).toEqual([]);
    expect(sends()).toHaveLength(0);
  });
});
