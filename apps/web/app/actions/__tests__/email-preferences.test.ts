import { describe, it, expect, vi, beforeEach } from "vitest";

// The point of these: the address written is the session's, never the caller's
// input. `email_preferences` has RLS on with no policies (073), so the action
// writes through the service client - which will silence any address it is
// handed. The session is the only thing standing between that and a member
// switching off a colleague's mail by editing a form field.
const unsubscribeAddress = vi.fn(async (_c: unknown, _e: string, t: string) => [t]);
const resubscribeAddress = vi.fn(async () => [] as string[]);
const readUnsubscribed = vi.fn(async () => ["drafts"]);

vi.mock("@/lib/email/preferences", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email/preferences")>("@/lib/email/preferences");
  return { ...actual, unsubscribeAddress, resubscribeAddress, readUnsubscribed };
});

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requireAuth } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({
    accountId: "account-1",
    role: "editor",
    user: { id: "u1", email: "member@example.com" },
  })),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));

async function set(target: string, wanted: boolean) {
  const { setEmailPreference } = await import("../email-preferences");
  return setEmailPreference(target, wanted);
}

beforeEach(() => {
  unsubscribeAddress.mockClear();
  resubscribeAddress.mockClear();
  readUnsubscribed.mockClear();
  requireAuth.mockClear();
  requireAuth.mockResolvedValue({
    accountId: "account-1",
    role: "editor",
    user: { id: "u1", email: "member@example.com" },
  });
});

describe("setEmailPreference", () => {
  it("writes the session's address, not anything the caller supplies", async () => {
    await set("drafts", false);
    expect(unsubscribeAddress).toHaveBeenCalledWith(expect.anything(), "member@example.com", "drafts");
  });

  it("turns a category back on through resubscribe", async () => {
    await set("reports", true);
    expect(resubscribeAddress).toHaveBeenCalledWith(expect.anything(), "member@example.com", "reports");
    expect(unsubscribeAddress).not.toHaveBeenCalled();
  });

  it("accepts the everything-optional pseudo-category", async () => {
    await expect(set("all", false)).resolves.toEqual({ ok: true, unsubscribed: ["all"] });
  });

  it("refuses a slug that is not a category, without writing", async () => {
    await expect(set("newsletter", false)).resolves.toEqual({
      ok: false,
      error: "That is not a kind of email we send.",
    });
    expect(unsubscribeAddress).not.toHaveBeenCalled();
    expect(resubscribeAddress).not.toHaveBeenCalled();
  });

  it("surfaces the refusal for a required category rather than reporting success", async () => {
    unsubscribeAddress.mockRejectedValueOnce(new Error("That kind of email cannot be switched off."));
    await expect(set("billing", false)).resolves.toEqual({
      ok: false,
      error: "That kind of email cannot be switched off.",
    });
  });

  it("returns the row the server actually stored, not the optimistic guess", async () => {
    // Turning one category back on while everything is off expands `all` into
    // the remaining categories, so the answer is not the input.
    resubscribeAddress.mockResolvedValueOnce(["publishing", "improvements", "reports", "product"]);
    await expect(set("drafts", true)).resolves.toEqual({
      ok: true,
      unsubscribed: ["publishing", "improvements", "reports", "product"],
    });
  });

  it("refuses an account with no address instead of writing an empty one", async () => {
    requireAuth.mockResolvedValueOnce({
      accountId: "account-1",
      role: "editor",
      user: { id: "u1", email: undefined },
    } as never);
    await expect(set("drafts", false)).resolves.toEqual({
      ok: false,
      error: "Your account has no email address on it.",
    });
    expect(unsubscribeAddress).not.toHaveBeenCalled();
  });
});

describe("getMyEmailPreferences", () => {
  it("reads the session's own address", async () => {
    const { getMyEmailPreferences } = await import("../email-preferences");
    await expect(getMyEmailPreferences()).resolves.toEqual({
      email: "member@example.com",
      unsubscribed: ["drafts"],
    });
  });

  it("renders as everything-on when the preferences row cannot be read", async () => {
    // A failed read must not present as "you unsubscribed from everything":
    // the default state is wanting the mail.
    readUnsubscribed.mockRejectedValueOnce(new Error("timeout"));
    const { getMyEmailPreferences } = await import("../email-preferences");
    await expect(getMyEmailPreferences()).resolves.toEqual({
      email: "member@example.com",
      unsubscribed: [],
    });
  });
});
