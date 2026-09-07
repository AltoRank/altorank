import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A daily email that fails every morning is worse than no daily email: it
 * trains whoever receives the cron's output to ignore it. So the digest's
 * important behaviour is all in what it declines to do.
 *
 * The production case as of 2026-09-07: `ADMIN_EMAILS` is unset, so
 * lib/auth/operators.ts falls back to the AltoRank address and there *is* a
 * recipient. An install that sets it to empty on purpose, or that has no mail
 * provider at all, must no-op quietly with a reason instead.
 */

const { sendOnce } = vi.hoisted(() => ({ sendOnce: vi.fn(async () => ({ sent: 1, skipped: 0, failed: 0 })) }));
vi.mock("@/lib/email/send-once", () => ({ sendOnce }));

/** A client whose `system_events` query answers with these rows. */
function db(rows: unknown[], error?: string) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    in: self,
    gte: self,
    order: self,
    limit: async () => (error ? { data: null, error: { message: error } } : { data: rows, error: null }),
  });
  return { from: () => chain } as never;
}

/** The four arguments `sendOnce` is called with, which vi.fn() does not type. */
type SendOnceCall = [
  unknown,
  string[],
  { type: string; subjectId: string; category: string },
  () => { subject: string; html: string; footerNote: string },
];

const EVENT = (over: Record<string, unknown> = {}) => ({
  level: "error",
  source: "cron.publish",
  message: "401 from WordPress",
  created_at: new Date().toISOString(),
  ...over,
});

async function load(adminEmails: string | undefined, resendKey: string | undefined) {
  vi.resetModules();
  if (adminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = adminEmails;
  if (resendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = resendKey;
  return import("../digest");
}

beforeEach(() => {
  sendOnce.mockClear();
});
afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.RESEND_API_KEY;
});

describe("the digest no-ops quietly", () => {
  it("sends nothing when ADMIN_EMAILS is deliberately empty", async () => {
    const { sendOperatorDigest } = await load("", "re_test");
    const out = await sendOperatorDigest(db([EVENT()]));
    expect(out).toEqual({ sent: false, reason: expect.stringContaining("no operator") });
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it("sends nothing when the install has no mail provider", async () => {
    const { sendOperatorDigest } = await load("ops@example.com", undefined);
    const out = await sendOperatorDigest(db([EVENT()]));
    expect(out).toEqual({ sent: false, reason: expect.stringContaining("RESEND_API_KEY") });
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it("sends nothing when the log cannot be read", async () => {
    // The realistic case: the code is deployed and migration 082 is not.
    const { sendOperatorDigest } = await load("ops@example.com", "re_test");
    const out = await sendOperatorDigest(db([], 'relation "system_events" does not exist'));
    expect(out).toMatchObject({ sent: false });
    expect(sendOnce).not.toHaveBeenCalled();
  });

  it("sends nothing on a clean day", async () => {
    // An operator who receives one of these knows, without opening it, that
    // something happened. An empty one every morning would destroy that.
    const { sendOperatorDigest } = await load("ops@example.com", "re_test");
    const out = await sendOperatorDigest(db([]));
    expect(out).toEqual({ sent: false, reason: expect.stringContaining("nothing was recorded") });
    expect(sendOnce).not.toHaveBeenCalled();
  });
});

describe("the digest when there is something to say", () => {
  it("sends once, to the operators, keyed by the day", async () => {
    const { sendOperatorDigest } = await load("ops@example.com, second@example.com", "re_test");
    const out = await sendOperatorDigest(db([EVENT(), EVENT({ level: "warn" })]), new Date("2026-09-07T11:00:00Z"));
    expect(out).toMatchObject({ sent: true, errors: 1, warnings: 1 });

    const [, recipients, meta, render] = (sendOnce.mock.calls as unknown as SendOnceCall[])[0];
    expect(recipients).toEqual(["ops@example.com", "second@example.com"]);
    expect(meta.type).toBe("ops_digest");
    // The date, so a second run the same day is a duplicate `sent_emails`
    // claim and sends nothing.
    expect(meta.subjectId).toBe("2026-09-07");

    const body = render();
    expect(body.subject).toContain("1 error, 1 warning");
    expect(body.html).toContain("cron.publish");
    // The footer says how to turn it off, because the only lever is an env var.
    expect(body.footerNote).toContain("ADMIN_EMAILS");
  });

  it("groups by source, worst first, and counts each level", async () => {
    const { groupEvents } = await load("ops@example.com", "re_test");
    const groups = groupEvents([
      EVENT({ source: "email.deliver", level: "warn" }),
      EVENT({ source: "cron.publish", message: "a" }),
      EVENT({ source: "cron.publish", message: "b" }),
      EVENT({ source: "cron.publish", message: "b" }),
    ]);
    expect(groups[0]).toMatchObject({ source: "cron.publish", errors: 3, warnings: 0 });
    // Two examples at most, and never the same line twice.
    expect(groups[0].examples).toEqual(["a", "b"]);
    expect(groups[1]).toMatchObject({ source: "email.deliver", errors: 0, warnings: 1 });
  });

  it("escapes a provider's error text rather than trusting it as HTML", async () => {
    const { sendOperatorDigest } = await load("ops@example.com", "re_test");
    await sendOperatorDigest(db([EVENT({ message: "<img src=x onerror=alert(1)>" })]));
    const [, , , render] = (sendOnce.mock.calls as unknown as SendOnceCall[])[0];
    expect(render().html).not.toContain("<img");
    expect(render().html).toContain("&lt;img");
  });
});
