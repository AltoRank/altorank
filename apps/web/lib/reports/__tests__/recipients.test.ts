import { describe, it, expect, vi } from "vitest";
import { reportRecipients } from "../recipients";

const agencyRecipients = vi.fn(async () => ["owner@agency.test", "editor@agency.test"]);
vi.mock("@/lib/email/agency-recipients", () => ({
  agencyRecipients: (...args: unknown[]) => agencyRecipients(...(args as [])),
}));

const supabase = {} as never;

describe("reportRecipients", () => {
  it("uses the configured report address when there is one", async () => {
    expect(await reportRecipients(supabase, "ag1", "ws1", " Client@Example.test ")).toEqual(["client@example.test"]);
    expect(agencyRecipients).not.toHaveBeenCalled();
  });

  it("falls back to the members who can see the site when report_email is unset", async () => {
    // report_email is NULL by default. Without this the cron generated the
    // PDF, mailed nobody and reported success, every month, for every account
    // that had not found the field on the Settings page.
    for (const unset of [null, undefined, "", "   "]) {
      agencyRecipients.mockClear();
      expect(await reportRecipients(supabase, "ag1", "ws1", unset)).toEqual(["owner@agency.test", "editor@agency.test"]);
      expect(agencyRecipients).toHaveBeenCalledWith(supabase, "ag1", "ws1");
    }
  });
});
