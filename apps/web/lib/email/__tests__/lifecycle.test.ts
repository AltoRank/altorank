import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  renderDraftApproved,
  renderArticlePublished,
  renderPublishFailed,
  renderRefreshReady,
  renderPaymentFailed,
  renderSubscriptionCancelled,
  renderAccountPaused,
  renderPauseEnding,
  renderPlanChanged,
  renderWelcome,
  renderPasswordChanged,
  renderApiKeyCreated,
  renderNothingWritten,
  isoWeek,
} from "../lifecycle";
import { graceEndsAt } from "@/lib/billing/dunning";

beforeAll(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("draft approved", () => {
  const base = {
    domain: "acme.com",
    title: "How to choose a CRM",
    keyword: "best crm",
    articleId: "art-1",
    approvedBy: "Dana",
    scheduledFor: null as string | null,
  };

  it("names the site, the title and who approved it, and links to the article", () => {
    const e = renderDraftApproved(base);
    expect(e.subject).toBe('Approved for acme.com: "How to choose a CRM"');
    expect(e.html).toContain("Dana");
    expect(e.html).toContain("https://app.altorank.co/content/art-1");
    expect(e.footerNote).toContain("acme.com");
  });

  it("states the date when the cadence has one, and the honest version when it does not", () => {
    expect(renderDraftApproved({ ...base, scheduledFor: "2026-10-04T09:00:00Z" }).html).toContain("October 4, 2026");
    expect(renderDraftApproved(base).html).toContain("next scheduled slot");
  });

  /** Titles and keywords are customer data and reach the inbox as HTML. */
  it("escapes the title", () => {
    const e = renderDraftApproved({ ...base, title: '<img src=x onerror="alert(1)">' });
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&lt;img");
  });
});

describe("article published", () => {
  const base = { domain: "acme.com", title: "Post", articleId: "art-1", url: "https://acme.com/blog/post" };

  it("carries the live URL as the button and in full", () => {
    const e = renderArticlePublished(base);
    expect(e.subject).toBe('Published on acme.com: "Post"');
    expect(e.html).toContain('href="https://acme.com/blog/post"');
    expect(e.preheader).toContain("https://acme.com/blog/post");
  });

  /** No link is better than a link that 404s. */
  it("says there is no address rather than inventing one", () => {
    const e = renderArticlePublished({ ...base, url: null });
    expect(e.html).toContain("did not report a public address");
    expect(e.html).not.toContain("Open the live article");
  });

  it("makes no claim about rankings it has not measured", () => {
    expect(renderArticlePublished(base).html).toContain("once Search Console has something to report");
  });
});

describe("publish failed", () => {
  const base = {
    domain: "acme.com",
    title: "Post",
    articleId: "art-1",
    reason: "401 Unauthorized: the WordPress application password was rejected",
    destination: "wordpress",
  };

  it("quotes the reason verbatim and links to the retry", () => {
    const e = renderPublishFailed(base);
    expect(e.subject).toBe('Could not publish to acme.com: "Post"');
    expect(e.html).toContain("401 Unauthorized: the WordPress application password was rejected");
    expect(e.html).toContain("https://app.altorank.co/content/art-1");
    expect(e.html).toContain("https://app.altorank.co/connect");
  });

  it("tells the truth about the git case, where the content did land", () => {
    const e = renderPublishFailed({ ...base, committed: true, destination: "git" });
    expect(e.html).toContain("committed to the repository");
    expect(e.html).toContain("that the site built");
  });

  it("does not say the article is back in review when it is not", () => {
    expect(renderPublishFailed({ ...base, committed: true }).html).not.toContain("back in review");
  });
});

describe("refresh proposal ready", () => {
  const base = {
    domain: "acme.com",
    pageTitle: "Pricing guide",
    pageUrl: "https://acme.com/pricing-guide",
    executionId: "ex-1",
    changed: 3,
    hunks: 8,
    issues: 0,
  };

  it("says nothing has been sent to the site, and links to the diff", () => {
    const e = renderRefreshReady(base);
    expect(e.html).toContain("Nothing has been sent to the site");
    expect(e.html).toContain("https://app.altorank.co/improvements/ex-1");
    expect(e.html).toContain("<strong>3 of 8</strong>");
  });

  it("mentions flagged claims only when there are some", () => {
    expect(renderRefreshReady(base).html).toContain("flagged nothing");
    expect(renderRefreshReady({ ...base, issues: 2 }).html).toContain("2 claims were");
    expect(renderRefreshReady({ ...base, issues: 1 }).html).toContain("1 claim was");
  });

  it("offers an unsubscribe route in the footer that is a real setting", () => {
    expect(renderRefreshReady(base).footerNote).toContain("scheduled improvements are on");
  });
});

describe("payment failed", () => {
  const failedAt = "2026-09-01T10:00:00.000Z";
  const base = {
    agencyName: "Acme Agency",
    planLabel: "Managed",
    graceEndsAt: graceEndsAt(failedAt)!.toISOString(),
    amount: "€69.00",
  };

  /**
   * The banner and the email must agree. Both read `payment_failed_at` through
   * `graceEndsAt`, so the date in the inbox is the date on the screen.
   */
  it("states the same grace date the dunning banner computes", () => {
    const e = renderPaymentFailed(base);
    expect(e.subject).toContain("September 8");
    expect(e.html).toContain("September 8");
  });

  it("says plainly that nothing has stopped yet", () => {
    const e = renderPaymentFailed(base);
    expect(e.html).toContain("<strong>Nothing has stopped.</strong>");
    expect(e.html).toContain("Nothing is deleted");
    expect(e.html).toContain("https://app.altorank.co/settings/billing");
  });

  it("quotes an amount only when Stripe gave one", () => {
    expect(renderPaymentFailed(base).html).toContain("€69.00");
    expect(renderPaymentFailed({ ...base, amount: null }).html).toContain("was declined, so");
  });
});

describe("subscription cancelled", () => {
  it("names the end date and offers the undo", () => {
    const e = renderSubscriptionCancelled({
      agencyName: "Acme",
      planLabel: "Agency",
      endsAt: "2026-12-01T00:00:00Z",
    });
    expect(e.subject).toBe("Your plan ends on December 1, 2026");
    expect(e.html).toContain("Keep the plan instead");
    expect(e.html).toContain("stays readable and exportable");
  });

  it("stays honest when Stripe gave no date", () => {
    const e = renderSubscriptionCancelled({ agencyName: null, planLabel: "Managed", endsAt: null });
    expect(e.subject).toBe("Your plan is set to end");
    expect(e.html).toContain("end of the period you have paid for");
  });

  /** The retention screen already asked. Asking again here is the dark pattern. */
  it("makes no discount offer", () => {
    const html = renderSubscriptionCancelled({ agencyName: null, planLabel: "Managed", endsAt: null }).html;
    expect(html).not.toMatch(/discount|% off|special offer/i);
  });
});

describe("account paused and pause ending", () => {
  it("says what a pause stops and what it keeps", () => {
    const e = renderAccountPaused({ agencyName: "Acme", pausedUntil: "2026-11-15", workspaceCount: 3 });
    expect(e.subject).toBe("Paused until November 15, 2026");
    expect(e.html).toContain("All 3 of your workspaces");
    expect(e.html).toContain("kept exactly as they are");
  });

  it("uses the singular for one site", () => {
    expect(renderAccountPaused({ agencyName: null, pausedUntil: "2026-11-15", workspaceCount: 1 }).html).toContain(
      "Your workspace",
    );
  });

  /** A pause ends by itself at Stripe too, so the first sign would be a charge. */
  it("warns before billing resumes, in days", () => {
    expect(renderPauseEnding({ agencyName: null, pausedUntil: "2026-11-15", daysLeft: 3 }).subject).toBe(
      "Your pause ends in 3 days",
    );
    expect(renderPauseEnding({ agencyName: null, pausedUntil: "2026-11-15", daysLeft: 1 }).subject).toBe(
      "Your pause ends tomorrow",
    );
  });
});

describe("plan changed", () => {
  it("states the new allowance and which way the money went", () => {
    const up = renderPlanChanged({ fromLabel: "Managed", toLabel: "Agency", articleLimit: 400, upgrade: true });
    expect(up.subject).toBe("Your plan is now Agency");
    expect(up.html).toContain("400 articles a month");
    expect(up.html).toContain("charged the difference");

    const down = renderPlanChanged({ fromLabel: "Agency", toLabel: "Managed", articleLimit: 100, upgrade: false });
    expect(down.html).toContain("credited the unused part");
    expect(down.html).toContain("will slow to it");
  });

  it("does not invent a ceiling for a plan that has none", () => {
    const e = renderPlanChanged({ fromLabel: "Agency", toLabel: "Custom", articleLimit: null, upgrade: true });
    expect(e.html).toContain("no metered article ceiling");
  });
});

describe("account emails", () => {
  it("welcomes without promising a ranking", () => {
    const e = renderWelcome({ name: "Dana", domain: "acme.com" });
    expect(e.subject).toBe("Your AltoRank account is live");
    expect(e.html).toContain("You are in, Dana");
    expect(e.html).toContain("<strong>Nothing publishes without you.</strong>");
    expect(e.html).not.toMatch(/guarantee|page one|rank first|number one/i);
  });

  it("works with no name and no site yet", () => {
    const e = renderWelcome({ name: null, domain: null });
    expect(e.html).toContain("You are in<");
    expect(e.html).toContain("Add a workspace");
  });

  it("tells somebody their password changed and how to act if it was not them", () => {
    const e = renderPasswordChanged({ email: "a@x.co", at: "2026-09-06T12:00:00Z" });
    expect(e.subject).toBe("Your AltoRank password was changed");
    expect(e.html).toContain("September 6, 2026");
    expect(e.html).toContain("https://app.altorank.co/reset-password");
    expect(e.html).toContain("never ask you for your password by email");
  });

  it("announces an API key without ever carrying its value", () => {
    const e = renderApiKeyCreated({
      keyName: "CI",
      prefix: "alto_ab12",
      createdBy: "Dana",
      canWrite: true,
      expiresAt: null,
    });
    expect(e.html).toContain("alto_ab12");
    expect(e.html).toContain("read <em>and change</em>");
    expect(e.html).toContain("does not expire");
    expect(e.html).toContain("not in this email");
  });

  it("says read-only when the key is read-only, and names an expiry when there is one", () => {
    const e = renderApiKeyCreated({
      keyName: "Reporting",
      prefix: "alto_cd34",
      createdBy: "Sam",
      canWrite: false,
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(e.html).toContain("read only");
    expect(e.html).toContain("January 1, 2027");
  });
});

describe("nothing is being written", () => {
  it("gives the reason and the one-minute fix, per reason", () => {
    expect(renderNothingWritten({ domain: "acme.com", reason: "no-keywords" }).subject).toBe(
      "Nothing is being written for acme.com",
    );
    expect(renderNothingWritten({ domain: "acme.com", reason: "queue-exhausted" }).subject).toContain(
      "run out of keywords",
    );
    expect(renderNothingWritten({ domain: "acme.com", reason: "pace-zero" }).html).toContain("weekly pace is set to zero");
  });

  it("names the resume date for a paused site when it has one", () => {
    const e = renderNothingWritten({ domain: "acme.com", reason: "paused", pausedUntil: "2026-10-01" });
    expect(e.html).toContain("October 1, 2026");
  });

  /** Not an incident report: nothing is wrong, and the email should say so. */
  it("does not alarm", () => {
    const html = renderNothingWritten({ domain: "acme.com", reason: "no-keywords" }).html;
    expect(html).toContain("Nothing is wrong with the site or the account");
    expect(html).toContain("one email a week at most");
  });
});

describe("isoWeek", () => {
  it("keys a week, not a day", () => {
    expect(isoWeek(new Date("2026-09-06T23:00:00Z"))).toBe(isoWeek(new Date("2026-09-02T01:00:00Z")));
    expect(isoWeek(new Date("2026-09-07T00:00:00Z"))).not.toBe(isoWeek(new Date("2026-09-06T00:00:00Z")));
  });
});
