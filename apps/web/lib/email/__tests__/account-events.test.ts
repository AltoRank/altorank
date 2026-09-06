import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendTransactionalEmail } = vi.hoisted(() => ({ sendTransactionalEmail: vi.fn() }));
vi.mock("../resend", () => ({ sendTransactionalEmail }));

type Row = Record<string, unknown>;
const claimed = new Set<string>();
let members: { user_id: string; role: string }[] = [];
let emails: Record<string, string> = {};

vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === "agency_members") {
        return { select: () => ({ eq: async () => ({ data: members, error: null }) }) };
      }
      if (table === "email_preferences") {
        return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      }
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
      };
    },
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: emails[id] } } }) } },
  }),
}));

import { announceApiKeyCreated, announcePasswordChanged } from "../account-events";

function sends() {
  return sendTransactionalEmail.mock.calls.map((c) => ({ to: c[0], subject: c[1], html: c[2], footer: c[3] }));
}

beforeEach(() => {
  claimed.clear();
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  members = [
    { user_id: "u1", role: "owner" },
    { user_id: "u2", role: "admin" },
    { user_id: "u3", role: "editor" },
  ];
  emails = { u1: "owner@acme.co", u2: "admin@acme.co", u3: "editor@acme.co" };
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});

describe("announcePasswordChanged", () => {
  it("tells the address whose password it was", async () => {
    await announcePasswordChanged("dana@acme.co");
    expect(sends()).toHaveLength(1);
    expect(sends()[0].to).toBe("dana@acme.co");
    expect(sends()[0].subject).toBe("Your AltoRank password was changed");
    expect(sends()[0].html).toContain("https://app.altorank.co/reset-password");
  });

  /** The reset flow can double-submit; the account holder needs one notice. */
  it("does not double-send for one change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:30Z"));
    await announcePasswordChanged("dana@acme.co");
    vi.setSystemTime(new Date("2026-09-06T12:00:45Z"));
    await announcePasswordChanged("dana@acme.co");
    expect(sends()).toHaveLength(1);

    // An hour later is a different fact, and one worth hearing about.
    vi.setSystemTime(new Date("2026-09-06T13:00:00Z"));
    await announcePasswordChanged("dana@acme.co");
    expect(sends()).toHaveLength(2);
    vi.useRealTimers();
  });

  it("does nothing without an address, and never throws", async () => {
    await expect(announcePasswordChanged(null)).resolves.toBeUndefined();
    expect(sends()).toHaveLength(0);

    sendTransactionalEmail.mockRejectedValue(new Error("Resend refused the email"));
    await expect(announcePasswordChanged("dana@acme.co")).resolves.toBeUndefined();
  });
});

describe("announceApiKeyCreated", () => {
  const key = {
    agencyId: "ag-1",
    keyId: "key-1",
    keyName: "CI",
    prefix: "alto_ab12",
    createdBy: "Dana",
    canWrite: true,
    expiresAt: null,
  };

  /**
   * A key can act on the account without a password. The people who can revoke
   * it are the owners and admins; an editor cannot, and telling them would be
   * telling them about a control they do not have.
   */
  it("goes to owners and admins, not editors", async () => {
    await announceApiKeyCreated(key);
    expect(sends().map((s) => s.to).sort()).toEqual(["admin@acme.co", "owner@acme.co"]);
  });

  it("never carries the key value", async () => {
    await announceApiKeyCreated(key);
    expect(sends()[0].html).toContain("alto_ab12");
    expect(sends()[0].html).toContain("not in this email");
    expect(sends()[0].html).toContain("read <em>and change</em>");
  });

  it("sends once per key", async () => {
    await announceApiKeyCreated(key);
    await announceApiKeyCreated(key);
    expect(sends()).toHaveLength(2); // two recipients, one email each
  });

  it("never throws when the send is refused", async () => {
    sendTransactionalEmail.mockRejectedValue(new Error("Resend refused the email"));
    await expect(announceApiKeyCreated(key)).resolves.toBeUndefined();
  });
});
