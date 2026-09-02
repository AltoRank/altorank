import { describe, it, expect, vi, beforeEach } from "vitest";

// The SDK is replaced wholesale. These tests are about how this module reacts
// to what Resend answers, and the answer is the one thing controlled here.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

/** The module caches its client, so each test gets a fresh copy. */
async function freshModule() {
  vi.resetModules();
  return await import("../resend");
}

describe("Resend delivery", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.RESEND_FROM_EMAIL;
  });

  it("throws when Resend refuses the email, carrying its code and status", async () => {
    // Resend's SDK resolves on a 4xx rather than rejecting. This is its shape
    // for a from-address on a domain the key's team has not verified.
    send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", statusCode: 403, message: "The updates.altorank.co domain is not verified." },
      headers: null,
    });
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).rejects.toThrow(
      "Resend refused the email (validation_error 403): The updates.altorank.co domain is not verified.",
    );
  });

  it("resolves when Resend accepts the email", async () => {
    send.mockResolvedValue({ data: { id: "em_1" }, error: null, headers: null });
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: "a@b.co",
      subject: "Hello",
      from: "AltoRank <noreply@updates.altorank.co>",
    });
  });

  it("applies to the auth emails' sender too", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests." },
      headers: null,
    });
    const { sendTransactionalEmail } = await freshModule();
    await expect(
      sendTransactionalEmail("a@b.co", "Reset", "<p>x</p>", "Sent to a@b.co because a reset was requested.", "Preheader"),
    ).rejects.toThrow("Resend refused the email (rate_limit_exceeded 429): Too many requests.");
  });

  it("names the missing key instead of sending", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendToolResultEmail } = await freshModule();
    await expect(sendToolResultEmail("a@b.co", "Hello", "<p>hi</p>")).rejects.toThrow("RESEND_API_KEY not configured");
    expect(send).not.toHaveBeenCalled();
  });
});
