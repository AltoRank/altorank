import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import { announceArticlePublished, announcePublishFailed } from "../article-events";

type Row = Record<string, unknown>;

const claimed = new Set<string>();
let article: Row | null = null;
let members: { user_id: string; workspace_ids: string[] | null }[] = [];
let emails: Record<string, string> = {};

/** Enough of PostgREST for these two functions: one article, the members, the ledger. */
function client() {
  return {
    from(table: string) {
      if (table === "articles") {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: article, error: null }),
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

const LIVE: Row = {
  id: "art-1",
  title: "How to choose a CRM",
  status: "live",
  published_url: "https://acme.com/blog/how-to-choose-a-crm",
  cms: "wordpress",
  workspace_id: "ws-1",
  indexing_status: { urlVerified: "confirmed" },
  workspaces: { domain: "acme.com", agency_id: "ag-1" },
};

beforeEach(() => {
  claimed.clear();
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  article = { ...LIVE };
  members = [{ user_id: "u1", workspace_ids: null }];
  emails = { u1: "owner@acme.co" };
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});

describe("announceArticlePublished", () => {
  it("carries the live URL to everyone with access to the site", async () => {
    const line = await announceArticlePublished(client(), "art-1");
    expect(sends()).toHaveLength(1);
    expect(sends()[0].to).toBe("owner@acme.co");
    expect(sends()[0].subject).toBe('Published on acme.com: "How to choose a CRM"');
    expect(sends()[0].html).toContain("https://acme.com/blog/how-to-choose-a-crm");
    expect(line).toBe("emailed 1");
  });

  /**
   * A CMS draft is not on the web. Saying "it is live" about a post the CMS is
   * still holding is the claim this check exists to prevent.
   */
  it("says nothing while the CMS is holding it as a draft", async () => {
    article = { ...LIVE, status: "approved" };
    await announceArticlePublished(client(), "art-1");
    expect(sends()).toHaveLength(0);
  });

  /**
   * A git publish returns a predicted URL. cron/publish Phase 3 calls this
   * again once a build has made the address real; until then a link would very
   * likely 404 in the inbox.
   */
  it("waits for a git build rather than mailing an unverified URL", async () => {
    article = { ...LIVE, indexing_status: { urlVerified: "pending" } };
    await announceArticlePublished(client(), "art-1");
    expect(sends()).toHaveLength(0);
  });

  it("sends once even if the cron reaches it twice", async () => {
    const c = client();
    await announceArticlePublished(c, "art-1");
    await announceArticlePublished(c, "art-1");
    expect(sends()).toHaveLength(1);
  });

  it("honours workspace scoping, so a restricted editor is not told about another client", async () => {
    members = [
      { user_id: "u1", workspace_ids: null },
      { user_id: "u2", workspace_ids: ["ws-9"] },
    ];
    emails = { u1: "owner@acme.co", u2: "editor@acme.co" };
    await announceArticlePublished(client(), "art-1");
    expect(sends().map((s) => s.to)).toEqual(["owner@acme.co"]);
  });

  it("returns a line instead of throwing when the row is gone", async () => {
    article = null;
    expect(await announceArticlePublished(client(), "art-1")).toBe("");
    expect(sends()).toHaveLength(0);
  });
});

describe("announcePublishFailed", () => {
  it("quotes the CMS's own message and names the destination", async () => {
    article = { ...LIVE, status: "error", published_url: null };
    await announcePublishFailed(client(), {
      articleId: "art-1",
      workspaceId: "ws-1",
      reason: "401 Unauthorized",
      attemptKey: "2026-09-06T10:00:00.000Z",
    });
    expect(sends()[0].subject).toBe('Could not publish to acme.com: "How to choose a CRM"');
    expect(sends()[0].html).toContain("401 Unauthorized");
    expect(sends()[0].html).toContain("wordpress");
  });

  /** The same run reporting twice is not news; a later failure is. */
  it("keys on the attempt, so a retry that fails again is a second email", async () => {
    article = { ...LIVE, status: "error" };
    const c = client();
    const opts = { articleId: "art-1", workspaceId: "ws-1", reason: "401" };
    await announcePublishFailed(c, { ...opts, attemptKey: "run-1" });
    await announcePublishFailed(c, { ...opts, attemptKey: "run-1" });
    expect(sends()).toHaveLength(1);
    await announcePublishFailed(c, { ...opts, attemptKey: "run-2" });
    expect(sends()).toHaveLength(2);
  });

  it("tells the truth about the git case, where the content did land", async () => {
    article = { ...LIVE, status: "review", cms: "git" };
    await announcePublishFailed(client(), {
      articleId: "art-1",
      workspaceId: "ws-1",
      reason: "Committed to the repo, but the published URL never resolved.",
      committed: true,
      attemptKey: "unconfirmed:8",
    });
    expect(sends()[0].html).toContain("committed to the repository");
    expect(sends()[0].html).not.toContain("back in review");
  });

  /** The publish already failed; the email must not fail it a second way. */
  it("never throws when the mail provider refuses", async () => {
    article = { ...LIVE, status: "error" };
    sendTransactionalEmail.mockRejectedValue(new Error("Resend refused the email"));
    const line = await announcePublishFailed(client(), {
      articleId: "art-1",
      workspaceId: "ws-1",
      reason: "401",
      attemptKey: "run-1",
    });
    expect(line).toContain("failed");
  });
});
