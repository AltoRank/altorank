import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two routes that mail FEEDBACK_EMAIL. Everything they reach past the
// recipient check is replaced, so the only question is who gets the mail.
const { sendPlainEmail } = vi.hoisted(() => ({ sendPlainEmail: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendPlainEmail }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ user: { id: "u1", email: "person@example.com" }, accountId: "acc1" }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => null }));
vi.mock("@/lib/tools/rate-limit", () => ({ takeToolRateLimit: () => ({ allowed: true }) }));

import { feedbackRecipient } from "../feedback-recipient";
import { POST as feedbackPOST } from "@/app/api/feedback/route";
import { POST as integrationPOST } from "@/app/api/integration-request/route";

function req(body: unknown) {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("feedback recipient", () => {
  beforeEach(() => {
    sendPlainEmail.mockReset();
    sendPlainEmail.mockResolvedValue("em_1");
    process.env.RESEND_API_KEY = "re_test";
  });
  afterEach(() => {
    delete process.env.FEEDBACK_EMAIL;
    delete process.env.RESEND_API_KEY;
  });

  it("is nobody when FEEDBACK_EMAIL is unset or blank", () => {
    delete process.env.FEEDBACK_EMAIL;
    expect(feedbackRecipient()).toBeNull();
    process.env.FEEDBACK_EMAIL = "   ";
    expect(feedbackRecipient()).toBeNull();
    process.env.FEEDBACK_EMAIL = " ops@example.com ";
    expect(feedbackRecipient()).toBe("ops@example.com");
  });

  it("feedback sends nothing, anywhere, when FEEDBACK_EMAIL is unset", async () => {
    delete process.env.FEEDBACK_EMAIL;
    const res = await feedbackPOST(req({ message: "it broke" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/FEEDBACK_EMAIL/);
    expect(sendPlainEmail).not.toHaveBeenCalled();
  });

  it("an integration request sends nothing when FEEDBACK_EMAIL is unset", async () => {
    delete process.env.FEEDBACK_EMAIL;
    const res = await integrationPOST(req({ integrationId: "ghost", integrationName: "Ghost" }));
    expect(res.status).toBe(503);
    expect(sendPlainEmail).not.toHaveBeenCalled();
  });

  it("both go to the configured address when it is set", async () => {
    process.env.FEEDBACK_EMAIL = "ops@example.com";
    expect((await feedbackPOST(req({ message: "it broke" }))).status).toBe(200);
    expect((await integrationPOST(req({ integrationId: "ghost" }))).status).toBe(200);
    expect(sendPlainEmail.mock.calls.map((c) => c[0].to)).toEqual(["ops@example.com", "ops@example.com"]);
  });
});
