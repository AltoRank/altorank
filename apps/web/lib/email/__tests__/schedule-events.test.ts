import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import {
  announceNothingWritten,
  announcePausedSites,
  announceSetupUnfinished,
  nothingWrittenReason,
  remindEndingPauses,
  setupUnfinishedFacts,
  sweepUnfinishedSetups,
  PAUSE_REMINDER_DAYS,
  SETUP_UNFINISHED_LINE,
} from "../schedule-events";

type Row = Record<string, unknown>;

const claimed = new Set<string>();
let workspaceRows: Row[] = [];
/** The oldest draft in review, the keyword count and the latest audit, for the setup email's facts. */
let reviewArticle: Row | null = null;
let keywordCount = 0;
let latestAudit: Row | null = null;
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
          neq: record("neq"),
          is: record("is"),
          lt: record("lt"),
          not: (c: string, o: string, v: unknown) => (workspaceFilters.push([`not ${c} ${o}`, v]), q),
          gte: record("gte"),
          lte: record("lte"),
          maybeSingle: async () => ({ data: workspaceRows[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: workspaceRows, error: null }),
        });
        return q as never;
      }
      if (table === "articles" || table === "domain_audits" || table === "keywords") {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          order: () => q,
          limit: () => q,
          maybeSingle: async () => ({ data: table === "articles" ? reviewArticle : latestAudit, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, count: keywordCount, error: null }),
        });
        return q as never;
      }
      if (table === "accounts") {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: { name: "Acme" }, error: null }),
        });
        return q as never;
      }
      if (table === "account_members") {
        return { select: () => ({ eq: async () => ({ data: members, error: null }) }) } as never;
      }
      if (table === "email_preferences") {
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) } as never;
      }
      if (table === "sent_emails") {
        return {
          // The sweep's ledger read: which of these sites were already told.
          select: () => ({
            eq: (_c: string, type: string) => ({
              in: async (_col: string, ids: string[]) => ({
                data: ids
                  .filter((id) => [...claimed].some((k) => k.startsWith(`${type}|${id}|`)))
                  .map((id) => ({ workspace_id: id })),
                error: null,
              }),
            }),
          }),
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
  reviewArticle = null;
  keywordCount = 0;
  latestAudit = null;
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
    workspaceRows = [{ account_id: "ag-1", paused_until: "2026-09-08" }];
    const out = await remindEndingPauses(client(), today);

    expect(out).toEqual([{ accountId: "ag-1", pausedUntil: "2026-09-08", emailed: "emailed 1" }]);
    expect(sends()[0].to).toBe("owner@acme.co");
    expect(sends()[0].subject).toBe("Your pause ends in 2 days");
    expect(sends()[0].html).toContain("September 8, 2026");
  });

  /** Billing is owner and admin business; an editor cannot open that page. */
  it("does not tell an editor", async () => {
    workspaceRows = [{ account_id: "ag-1", paused_until: "2026-09-08" }];
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
      { account_id: "ag-1", paused_until: "2026-09-08" },
      { account_id: "ag-1", paused_until: "2026-09-08" },
      { account_id: "ag-1", paused_until: "2026-09-09" },
    ];
    await remindEndingPauses(client(), today);
    expect(sends()).toHaveLength(1);
  });

  it("does not repeat across the four daily runs inside the window", async () => {
    workspaceRows = [{ account_id: "ag-1", paused_until: "2026-09-08" }];
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
  const scope = { accountId: "ag-1", workspaceId: "ws-1", domain: "acme.com" };

  it("says which reason, and what to do about it", async () => {
    const line = await announceNothingWritten(client(), scope, "no-keywords");
    expect(line).toBe("emailed 2");
    expect(sends()[0].subject).toBe("Nothing is being written for acme.com");
    expect(sends()[0].html).toContain("https://app.altorank.co/keywords");
  });

  /**
   * A site whose wizard was never finished or skipped is the setup email's
   * to talk to, not this one's: "add keywords" sends somebody who has not
   * seen the plan screen to the wrong page for the wrong reason.
   */
  it("stands down for a site still in setup, and never sends both", async () => {
    workspaceRows = [{ id: "ws-1", onboarded_at: null, onboarding_skipped_at: null }];
    const line = await announceNothingWritten(client(), scope, "no-keywords");
    expect(line).toBe(SETUP_UNFINISHED_LINE);
    expect(sends()).toHaveLength(0);
  });

  it("treats a skipped wizard as finished", async () => {
    workspaceRows = [{ id: "ws-1", onboarded_at: null, onboarding_skipped_at: "2026-09-07T10:00:00Z" }];
    expect(await announceNothingWritten(client(), scope, "no-keywords")).toBe("emailed 2");
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
    workspaceRows = [
      { id: "ws-1", domain: "acme.com", account_id: "ag-1", paused_until: "2026-10-01", onboarded_at: "2026-08-01T00:00:00Z" },
    ];
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

describe("the setup email", () => {
  const scope = { accountId: "ag-1", workspaceId: "ws-1", domain: "acme.com" };
  const usable = { terms: { crm: 1, sales: 1, pipeline: 1, forecast: 1 } };

  it("carries the draft when one is in review, to everyone scoped to the site", async () => {
    reviewArticle = { id: "art-1", title: "How to choose a CRM", keyword: "best crm" };
    keywordCount = 8;
    workspaceRows = [{ id: "ws-1", topical_profile: usable }];
    const line = await announceSetupUnfinished(client(), scope);

    expect(line).toBe("emailed 2");
    expect(sends().map((s) => s.to).sort()).toEqual(["editor@acme.co", "owner@acme.co"]);
    expect(sends()[0].subject).toBe("While you were away: a first draft for acme.com");
    expect(sends()[0].html).toContain("https://app.altorank.co/content/art-1");
    expect(sends()[0].html).toContain("https://app.altorank.co/onboarding?step=4");
  });

  it("states only what was measured when there is no draft", async () => {
    keywordCount = 8;
    workspaceRows = [{ id: "ws-1", topical_profile: usable }];
    expect(await setupUnfinishedFacts(client(), "ws-1", "acme.com")).toEqual({
      domain: "acme.com",
      draft: null,
      keywordCount: 8,
      unreadable: null,
    });
    await announceSetupUnfinished(client(), scope);
    expect(sends()[0].subject).toBe("We read acme.com while you were away");
    expect(sends()[0].html).toContain("<strong>8</strong> keywords");
  });

  it("says what could not be read, from the audit, never from a guess", async () => {
    latestAudit = { pages_crawled: 0 };
    workspaceRows = [{ id: "ws-1", topical_profile: null }];
    expect((await setupUnfinishedFacts(client(), "ws-1", "acme.com")).unreadable).toBe("not one page answered");

    latestAudit = null;
    expect((await setupUnfinishedFacts(client(), "ws-1", "acme.com")).unreadable).toBe(
      "too little of its text could be read to find keywords",
    );

    // Keywords exist: the site was read well enough, whatever the profile says.
    keywordCount = 3;
    expect((await setupUnfinishedFacts(client(), "ws-1", "acme.com")).unreadable).toBeNull();
  });

  /** Once per site, ever - not per week, not per draft, not per run. */
  it("goes out once per workspace, whatever changes afterwards", async () => {
    const c = client();
    workspaceRows = [{ id: "ws-1", topical_profile: usable }];
    await announceSetupUnfinished(c, scope);
    reviewArticle = { id: "art-1", title: "Later", keyword: null };
    expect(await announceSetupUnfinished(c, scope)).toBe("2 already told or opted out");
    expect(sends()).toHaveLength(2);
    expect([...claimed].every((k) => k.startsWith("setup_unfinished|ws-1|"))).toBe(true);
  });

  it("is a site-status email a person can opt out of", async () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-signing-secret";
    workspaceRows = [{ id: "ws-1", topical_profile: usable }];
    await announceSetupUnfinished(client(), scope);
    const options = sendTransactionalEmail.mock.calls[0][5] as { unsubscribeUrl: unknown; headers?: Record<string, string> };
    expect(String(options.unsubscribeUrl)).toContain("/unsubscribe?");
    expect(options.headers?.["List-Unsubscribe"]).toBeTruthy();
  });
});

describe("sweepUnfinishedSetups", () => {
  const now = new Date("2026-09-08T07:00:00Z");

  it("asks for the sites that stalled a day ago or more, were read, and are not paused", async () => {
    await sweepUnfinishedSetups(client(), now);
    expect(workspaceFilters).toContainEqual(["is onboarded_at", null]);
    expect(workspaceFilters).toContainEqual(["is onboarding_skipped_at", null]);
    expect(workspaceFilters).toContainEqual(["not first_analysed_at is", null]);
    expect(workspaceFilters).toContainEqual(["neq status", "paused"]);
    expect(workspaceFilters).toContainEqual(["lt created_at", "2026-09-07T07:00:00.000Z"]);
  });

  it("tells each stalled site once and reports it", async () => {
    workspaceRows = [{ id: "ws-1", domain: "acme.com", account_id: "ag-1", topical_profile: null }];
    keywordCount = 8;
    const c = client();
    expect(await sweepUnfinishedSetups(c, now)).toEqual(["acme.com: emailed 2"]);
    // The next run reads the ledger and does not even build the email.
    expect(await sweepUnfinishedSetups(c, now)).toEqual([]);
    expect(sends()).toHaveLength(2);
  });

  it("says nothing when nothing stalled", async () => {
    expect(await sweepUnfinishedSetups(client(), now)).toEqual([]);
    expect(sends()).toHaveLength(0);
  });
});
