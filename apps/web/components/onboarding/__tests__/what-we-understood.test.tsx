import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatWeUnderstood } from "../what-we-understood";
import { EMPTY_PROFILE } from "@/lib/onboarding/profile-shape";

// The panel beside a live first look, as markup: the restart it offers while
// the run is still reading the site, and what it says when it cannot
// (lib/onboarding/stop-to-change.ts decides which; the run screen asks it).

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const PROFILE = {
  ...EMPTY_PROFILE,
  name: "Acme Walks",
  description: "Guided walking holidays in the Dolomites.",
  offerings: ["guided walking holidays"],
  audiences: ["hikers"],
  language: "Italian",
  country: "Italy",
};

const render = (props: Partial<Parameters<typeof WhatWeUnderstood>[0]> = {}) =>
  renderToStaticMarkup(<WhatWeUnderstood profile={PROFILE} domain="acme-walks.example" {...props} />);

describe("What we understood: correcting it before the first article", () => {
  it("offers to stop and start over when the run screen allows it, and not Settings", () => {
    const html = render({ onRestart: () => undefined });
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Wrong\? Fix it and start over<\/button>/);
    expect(text(html)).toContain("This setup stops, and you correct what we found before it runs again.");
    expect(text(html)).not.toContain("Settings");
  });

  it("says plainly that Settings needs the trial when no restart is on offer", () => {
    const html = render();
    expect(html).not.toContain("Fix it and start over");
    expect(text(html)).toContain("Something off? Settings opens when your trial starts.");
    // The old line promised Settings "once you are in", which the trial gate keeps shut.
    expect(text(html)).not.toContain("once you are in");
  });

  it("says it is stopping while the stop is on its way, and cannot be pressed twice", () => {
    const html = render({ onRestart: () => undefined, restarting: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
  });

  it("keeps a refusal's reason under the panel after the link has gone", () => {
    const html = render({ restartError: "Setup has started planning on what we found, so it can no longer be stopped." });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("can no longer be stopped");
    expect(html).not.toContain("Fix it and start over");
  });
});
