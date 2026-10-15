import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// renderToStaticMarkup, as the other dashboard panels are tested: no jsdom here.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/actions/settings", () => ({ updateAccountProfile: async () => {} }));

import { SettingsForm } from "../settings-form";
import type { Account } from "@/lib/types";

const account = { id: "acc-1", name: "Acme Agency", report_email: null, accent_color: null, api_key: "fr_live_sk_old" } as unknown as Account;

describe("SettingsForm", () => {
  it("shows no legacy API key and no Rotate: the database refuses that write for everyone", () => {
    const html = renderToStaticMarkup(<SettingsForm account={account} quotaReason="plan" canEdit />);
    expect(html).not.toContain("Legacy API key");
    expect(html).not.toContain("Rotate");
    expect(html).not.toContain("fr_live_sk_old");
    expect(html).toContain('href="/settings/api-keys"');
  });

  it("gives an owner or admin a Save", () => {
    const html = renderToStaticMarkup(<SettingsForm account={account} quotaReason="plan" canEdit />);
    expect(html).toContain("Save changes");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });

  it("shows an editor the values read-only instead of a Save that always failed", () => {
    const html = renderToStaticMarkup(<SettingsForm account={account} quotaReason="plan" canEdit={false} />);
    expect(html).not.toContain("Save changes");
    expect(html).toContain("Only an owner or admin can change these.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
  });
});
