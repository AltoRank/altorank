import { describe, it, expect } from "vitest";
import {
  businessEvidence,
  businessClaimsNote,
  removeUnsupportedBusinessClaims,
  unsupportedClaim,
} from "@/lib/content/business-claims";
import type { SiteFacts } from "@/lib/ai/types";

const facts: SiteFacts = {
  pagesRead: 6,
  offerings: [{ name: "Boiler servicing", url: "https://acme-heating.example/boilers/" }],
  work: [],
  headings: [{ page: "Home", url: "https://acme-heating.example/", items: ["Gas Safe registered engineers", "Free quotes"] }],
  stated: [
    { kind: "founded", text: "Family run since 2004", source: "https://acme-heating.example/about/" },
    { kind: "location", text: "Based in Northampton", source: "https://acme-heating.example/contact/" },
  ],
  about: { text: "Hello, my name is Sam Reed and I have fitted boilers across Northamptonshire for twenty years with my brother.", source: "https://acme-heating.example/about/" },
  people: [{ name: "Sam Reed", role: "Director", source: "https://acme-heating.example/about/" }],
  pages: [{ role: "contact", name: "Contact", url: "https://acme-heating.example/contact/" }],
  conversion: { url: "https://acme-heating.example/contact/", check: "200" },
  notes: [],
};

const ev = businessEvidence({
  domain: "acme-heating.example",
  profile: { name: "Acme Heating", description: "Boiler servicing and repairs. Call 01604 555 010.", differentiators: ["5-year guarantee on installs"] },
  facts,
});

describe("unsupportedClaim", () => {
  it("keeps what the business's own pages and profile say", () => {
    expect(unsupportedClaim("Acme Heating has been family run since 2004.", ev)).toBeNull();
    expect(unsupportedClaim("Acme Heating is based in Northampton.", ev)).toBeNull();
    expect(unsupportedClaim("Call Acme Heating on 01604 555010 to book.", ev)).toBeNull();
    expect(unsupportedClaim("Our engineers are Gas Safe registered.", ev)).toBeNull();
    expect(unsupportedClaim("We give a 5 year guarantee on every install.", ev)).toBeNull();
    expect(unsupportedClaim("Ask us for a free quote.", ev)).toBeNull();
  });

  it("leaves advice alone: a sentence not about the business makes no claim about it", () => {
    expect(unsupportedClaim("A boiler should be serviced every 12 months by a registered engineer.", ev)).toBeNull();
    expect(unsupportedClaim("An unserviced boiler can put your warranty at risk.", ev)).toBeNull();
    expect(unsupportedClaim("Most boilers last 10 to 15 years.", ev)).toBeNull();
  });

  it("catches each kind of claim the business never made", () => {
    expect(unsupportedClaim("Call Acme Heating on 01632 960 123.", ev)?.kind).toBe("phone");
    expect(unsupportedClaim("Email jobs@acme-mail.example for a quote.", ev)?.kind).toBe("email");
    expect(unsupportedClaim("Acme Heating is at 14 Mill Lane, Bedford MK40 1AA.", ev)?.kind).toBe("address");
    expect(unsupportedClaim("Acme Heating has over 30 years of experience.", ev)?.kind).toBe("years");
    expect(unsupportedClaim("Acme Heating was founded in 1987.", ev)?.kind).toBe("years");
    expect(unsupportedClaim("We have completed more than 4,300 installations.", ev)?.kind).toBe("count");
    expect(unsupportedClaim("Acme Heating is headquartered in Leicester.", ev)?.kind).toBe("place");
    expect(unsupportedClaim("We offer a lifetime guarantee on all work.", ev)?.kind).toBe("offer");
    expect(unsupportedClaim("Our engineers are NICEIC approved.", ev)?.kind).toBe("accreditation");
  });

  it("does not take one figure for another: 20 years is not supported by 20 reviews", () => {
    const reviews = businessEvidence({ domain: "acme-heating.example", profile: { name: "Acme Heating", description: "Rated 4.9 from 20 reviews." }, facts: null });
    expect(unsupportedClaim("Acme Heating has 20 years of experience.", reviews)?.kind).toBe("years");
  });

  it("catches a pasted first-person bio and invented initials", () => {
    expect(unsupportedClaim("Hello, my name is Sam Reed, and I fit boilers.", ev)?.kind).toBe("bio");
    const initials = businessEvidence({ domain: "bta.example", profile: { name: "BTA Impianti" }, facts: null });
    expect(unsupportedClaim("BTA (Bergamo Tecnologie Avanzate) installa impianti dal 2010.", initials)?.kind).toBe("initials");
  });

  it("reads Italian claims", () => {
    const it = businessEvidence({ domain: "rossi.example", profile: { name: "Rossi Serramenti", description: "Serramenti in alluminio a Brescia dal 1995." }, facts: null });
    expect(unsupportedClaim("Rossi Serramenti lavora a Brescia dal 1995.", it)).toBeNull();
    expect(unsupportedClaim("Rossi Serramenti ha oltre 40 anni di esperienza nel settore.", it)?.kind).toBe("years");
    expect(unsupportedClaim("Rossi Serramenti ha sede a Verona.", it)?.kind).toBe("place");
    expect(unsupportedClaim("Offriamo una garanzia a vita su ogni finestra.", it)?.kind).toBe("offer");
  });
});

describe("removeUnsupportedBusinessClaims", () => {
  it("takes out only the sentence, keeps the rest, drops a block left empty", () => {
    const html = [
      "<h2>Who services boilers near you?</h2>",
      "<p>Book a service once a year. Acme Heating has over 30 years of experience. It covers Northampton.</p>",
      "<p>Call Acme Heating on 01632 960 123.</p>",
      '<p>Read <a href="https://acme-heating.example/boilers/">our boiler page</a> for details.</p>',
    ].join("");
    const out = removeUnsupportedBusinessClaims(html, ev);
    expect(out.removed.map((r) => r.kind)).toEqual(["years", "phone"]);
    expect(out.html).toContain("<p>Book a service once a year. It covers Northampton.</p>");
    expect(out.html).not.toContain("01632");
    expect(out.html).toContain("<h2>Who services boilers near you?</h2>");
    expect(out.html).toContain('href="https://acme-heating.example/boilers/"');
  });

  it("changes nothing in a draft with no unsupported claim", () => {
    const html = "<p>Acme Heating has been family run since 2004.</p><ul><li>Gas Safe registered engineers.</li></ul>";
    expect(removeUnsupportedBusinessClaims(html, ev)).toEqual({ html, removed: [] });
  });

  it("tells the reviewer what was removed", () => {
    expect(businessClaimsNote([])).toBeNull();
    expect(businessClaimsNote([{ kind: "phone", claim: "01632 960 123", sentence: "Call us on 01632 960 123." }])).toMatch(/Removed 1 sentence .*"01632 960 123"/);
  });
});
