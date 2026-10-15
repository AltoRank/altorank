import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions/workspaces", () => ({ setAutoApprove: async () => ({ cadenceCreated: false }) }));

import { AutoApproveForm } from "../auto-approve-form";

const base = { workspaceId: "ws-1", holdHours: 24, minSeo: 70, setByName: null, hasCadence: true };

/** The two radios, in order: review each draft, publish automatically. */
function radios(html: string): string[] {
  return html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
}

describe("AutoApproveForm", () => {
  /**
   * With no CMS connected the rule holds every draft (decideAutoApproval), so
   * saving "Publish automatically" there used to save a mode that never
   * published anything, with no word about why.
   */
  it("does not offer automatic publishing with no CMS connected, and says why", () => {
    const html = renderToStaticMarkup(<AutoApproveForm {...base} enabled={false} hasDestination={false} />);
    expect(radios(html)[1]).toMatch(/disabled/);
    expect(html).toContain("Connect a CMS in Integrations first");
  });

  it("keeps a rule that is already on switchable, and says every draft is held", () => {
    const html = renderToStaticMarkup(<AutoApproveForm {...base} enabled hasDestination={false} />);
    expect(radios(html)[1]).not.toMatch(/disabled/);
    expect(html).toContain("No CMS is connected, so every draft is held");
  });

  it("offers it with no warning once a CMS is connected", () => {
    const html = renderToStaticMarkup(<AutoApproveForm {...base} enabled={false} hasDestination />);
    expect(radios(html)[1]).not.toMatch(/disabled/);
    expect(html).not.toContain("Connect a CMS");
  });
});
