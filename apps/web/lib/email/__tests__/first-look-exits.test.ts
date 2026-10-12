import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

import { FIRST_ARTICLE_LINK, FIRST_ARTICLE_LINK_DAILY_CAP, renderFirstArticleLink, sendFirstArticleLink } from "../first-look-exits";
import { fakeEmailDb } from "./fake-email-db";

// "Email me this article" (UX audit 2026-10-12, #3): the title and the way
// back, to the owner who asked, once per article, respecting their
// preferences, and at most a few a day - never the article itself.

const OWNER = "owner@acme-shop.example";
const BODY_SENTENCE = "Acme kits come in three sizes and the middle one suits most beginners.";

/** The shared fake, plus the count query the daily cap asks. */
function db(opts: Parameters<typeof fakeEmailDb>[0] & { sentToday?: number } = {}) {
  const fake = fakeEmailDb(opts);
  const inner = fake.client as unknown as { from: (t: string) => Record<string, unknown> };
  const client = {
    from(table: string) {
      const base = inner.from(table);
      if (table !== "sent_emails") return base;
      return {
        ...base,
        select: () => {
          const chain = {
            eq: () => chain,
            gte: async () => ({
              count: (opts.sentToday ?? 0) + fake.inserted.filter((r) => r.email_type === FIRST_ARTICLE_LINK).length,
              error: null,
            }),
          };
          return chain;
        },
      };
    },
  };
  return { ...fake, client: client as never };
}

const ARTICLE = { domain: "acme-shop.example", title: "Acme kits: how to choose one", articleId: "a1", accountId: "acc1", workspaceId: "ws1" };

describe("the first-article link email", () => {
  beforeEach(() => {
    sendTransactionalEmail.mockReset();
    sendTransactionalEmail.mockResolvedValue(undefined);
  });

  it("carries the title and a link back to the setup page, and none of the article", () => {
    const mail = renderFirstArticleLink({ domain: "acme-shop.example", title: ARTICLE.title });
    expect(mail.html).toContain("Acme kits: how to choose one");
    expect(mail.html).toContain("/onboarding");
    expect(mail.html).not.toContain(BODY_SENTENCE);
    expect(mail.subject).toBe("Your first article for acme-shop.example");
  });

  it("says the text is there to read only when the owner can read it before the trial", () => {
    expect(renderFirstArticleLink({ domain: "acme-shop.example", title: ARTICLE.title, readable: true }).html).toContain("yours to read there");
    const off = renderFirstArticleLink({ domain: "acme-shop.example", title: ARTICLE.title, readable: false }).html;
    expect(off).not.toContain("yours to read");
    expect(off).toContain("the full text opens when your 7-day trial starts");
  });

  it("is sent once per article to the owner, in the drafts category", async () => {
    const { client, inserted } = db();
    expect(await sendFirstArticleLink(client, OWNER, ARTICLE)).toMatchObject({ sent: 1 });
    expect(await sendFirstArticleLink(client, OWNER, ARTICLE)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0]).toBe(OWNER);
    expect(inserted[0]).toMatchObject({ email_type: FIRST_ARTICLE_LINK, subject_id: "a1", recipient: OWNER });
  });

  it("respects an unsubscribe from draft emails", async () => {
    const { client } = db({ preferences: { [OWNER]: ["drafts"] } });
    expect(await sendFirstArticleLink(client, OWNER, ARTICLE)).toMatchObject({ sent: 0, skipped: 1 });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("stops at the daily cap, whatever the article", async () => {
    const { client } = db({ sentToday: FIRST_ARTICLE_LINK_DAILY_CAP });
    expect(await sendFirstArticleLink(client, OWNER, { ...ARTICLE, articleId: "a2" })).toMatchObject({ sent: 0, capped: true });
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});
