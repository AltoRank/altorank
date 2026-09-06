import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// inviteMember: whether the email left is a fact the caller gets to know
// ---------------------------------------------------------------------------
//
// The bug: the send was wrapped in a bare `catch {}` and the toast still read
// "Invite sent to X". A missing RESEND_API_KEY or any Resend refusal produced
// a confident success and an invite nobody had been told about.

const inserted: Record<string, unknown>[] = [];
let insertError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return Promise.resolve({ error: insertError });
      },
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: { name: "Acme SEO" } }),
          then: (r: (v: unknown) => unknown) => r({ data: [{ id: "ws-1" }] }),
        }),
      }),
    }),
  }),
}));

const { requireAuth, sendInviteEmail } = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({
    agencyId: "agency-1",
    role: "owner",
    user: { id: "u1", email: "owner@acme.test", user_metadata: { full_name: "Owner" } },
  })),
  sendInviteEmail: vi.fn(async () => "email-id"),
}));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth }));
vi.mock("@/lib/email/resend", () => ({ sendInviteEmail }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function form(email = "new@acme.test", role = "editor") {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("role", role);
  return fd;
}

async function invite(fd = form()) {
  const { inviteMember } = await import("../team");
  return inviteMember(fd);
}

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  inserted.length = 0;
  insertError = null;
  requireAuth.mockClear();
  sendInviteEmail.mockReset();
  sendInviteEmail.mockResolvedValue("email-id");
  errorSpy.mockClear();
});

afterAll(() => errorSpy.mockRestore());

describe("inviteMember", () => {
  it("reports the send when the email left", async () => {
    await expect(invite()).resolves.toEqual({
      email: "new@acme.test",
      emailed: true,
      emailError: null,
    });
    expect(sendInviteEmail).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reports emailed: false when Resend refuses, instead of swallowing it", async () => {
    sendInviteEmail.mockRejectedValue(new Error("Resend refused the email (validation_error 403)"));
    const result = await invite();
    expect(result.emailed).toBe(false);
    expect(result.emailError).toContain("Resend refused the email");
  });

  it("still creates the invite when the email fails, because the link works", async () => {
    sendInviteEmail.mockRejectedValue(new Error("RESEND_API_KEY not configured"));
    await expect(invite()).resolves.toMatchObject({ emailed: false });
    const invited = inserted.filter((r) => r.table === "invites");
    expect(invited).toHaveLength(1);
    expect(invited[0].email).toBe("new@acme.test");
    expect(typeof invited[0].token).toBe("string");
  });

  it("logs the refusal server-side, so the cause is recoverable", async () => {
    sendInviteEmail.mockRejectedValue(new Error("RESEND_API_KEY not configured"));
    await invite();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0][0])).toContain("RESEND_API_KEY not configured");
  });

  it("throws rather than reporting anything when the invite row itself fails", async () => {
    insertError = { message: "duplicate key value violates unique constraint" };
    await expect(invite()).rejects.toThrow("duplicate key");
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("returns the address it validated, not the raw form value", async () => {
    const result = await invite(form("Someone@Acme.test"));
    expect(result.email).toBe("Someone@Acme.test");
  });
});
