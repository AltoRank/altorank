import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// captureToolLead: the email is ours to write, not the browser's
// ---------------------------------------------------------------------------
//
// The bug: `emailSubject` and `emailBody` were hidden form inputs and the
// action sent them verbatim to any address, from our domain, with no limit.

const inserted: Record<string, unknown>[] = [];
const { sendToolResultEmail, headerStore } = vi.hoisted(() => ({
  sendToolResultEmail: vi.fn(async () => undefined),
  headerStore: { ip: "1.1.1.1" },
}));

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));
vi.mock("@/lib/email/resend", () => ({ sendToolResultEmail }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": headerStore.ip }),
}));

import { captureToolLead } from "../capture";

const health = { url: "https://a.co", score: 72, errors: 2, warnings: 3, passes: 10 };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

let n = 0;
/** A fresh address per test, so the per-email limit never bleeds across tests. */
const fresh = () => `lead${++n}@example.com`;

beforeEach(() => {
  inserted.length = 0;
  sendToolResultEmail.mockClear();
  // A fresh ip per test for the same reason.
  headerStore.ip = `10.0.0.${++n}`;
});

describe("captureToolLead", () => {
  it("renders the email from the tool's data and ignores any client-supplied subject or body", async () => {
    const email = fresh();
    const r = await captureToolLead({ success: false }, form({
      email,
      toolSlug: "seo-health-checker",
      context: JSON.stringify(health),
      sendEmail: "true",
      emailSubject: "Urgent: verify your bank account",
      emailBody: `<a href="https://evil.example">Click</a>`,
    }));
    expect(r).toEqual({ success: true });
    expect(sendToolResultEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html] = sendToolResultEmail.mock.calls[0] as unknown as [string, string, string];
    expect(to).toBe(email);
    expect(subject).toBe("SEO Health Report: https://a.co");
    expect(html).toContain("72/100");
    expect(html).not.toContain("evil.example");
    expect(subject).not.toContain("bank");
    expect(inserted).toEqual([{ table: "tool_leads", email, tool_slug: "seo-health-checker", context: health }]);
  });

  it("refuses a slug with no renderer, saving nothing and sending nothing", async () => {
    const r = await captureToolLead({ success: false }, form({
      email: fresh(),
      toolSlug: "not-a-tool",
      context: JSON.stringify(health),
      sendEmail: "true",
    }));
    expect(r.success).toBe(false);
    expect(sendToolResultEmail).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("refuses a context that is not the tool's result when an email was asked for", async () => {
    const r = await captureToolLead({ success: false }, form({
      email: fresh(),
      toolSlug: "seo-health-checker",
      context: JSON.stringify({ html: "<b>x</b>" }),
      sendEmail: "true",
    }));
    expect(r).toEqual({ success: false, error: "Invalid input" });
    expect(sendToolResultEmail).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("saves the lead without sending when no email was asked for", async () => {
    const email = fresh();
    const r = await captureToolLead({ success: false }, form({
      email,
      toolSlug: "content-brief-generator",
      context: JSON.stringify({ keyword: "shoes" }),
    }));
    expect(r).toEqual({ success: true });
    expect(sendToolResultEmail).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  it("escapes markup typed into the tool before it reaches the body", async () => {
    await captureToolLead({ success: false }, form({
      email: fresh(),
      toolSlug: "keyword-gap-analyzer",
      context: JSON.stringify({ yourDomain: `<script>alert(1)</script>`, competitors: ["b.co"], totalGapsFound: 1 }),
      sendEmail: "true",
    }));
    const [, , html] = sendToolResultEmail.mock.calls[0] as unknown as [string, string, string];
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("rate-limits one address, then one ip", async () => {
    const email = fresh();
    const send = (e: string) =>
      captureToolLead({ success: false }, form({
        email: e,
        toolSlug: "seo-health-checker",
        context: JSON.stringify(health),
        sendEmail: "true",
      }));
    for (let i = 0; i < 3; i++) expect((await send(email)).success).toBe(true);
    // Fourth for the same address in the hour: refused, nothing sent, nothing saved.
    expect(await send(email)).toEqual({ success: false, error: "Too many requests. Try again later." });
    expect(sendToolResultEmail).toHaveBeenCalledTimes(3);
    expect(inserted).toHaveLength(3);

    // The same ip may address other people, up to ten in the hour in total.
    for (let i = 0; i < 6; i++) expect((await send(fresh())).success).toBe(true);
    expect(await send(fresh())).toEqual({ success: false, error: "Too many requests. Try again later." });
  });

  it("returns a plain error when the context is not JSON", async () => {
    const r = await captureToolLead({ success: false }, form({
      email: fresh(),
      toolSlug: "seo-health-checker",
      context: "{not json",
      sendEmail: "true",
    }));
    expect(r).toEqual({ success: false, error: "Invalid input" });
  });
});
