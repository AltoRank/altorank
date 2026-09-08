import { describe, it, expect } from "vitest";
import { audienceHead, audienceSeeds, categoryHead, categoryOf, keyNouns } from "../seeds";

/**
 * qasimcode.com. All twenty keywords it was given came from n-grams of its
 * blog tag headings, and not one contained book, appoint, clinic, salon,
 * dental, therap, trade, calendar or schedul - the entire subject of the
 * business. It had named six audiences in the wizard and nothing on the
 * automatic path had ever read them.
 */
const BUSINESS = {
  description:
    "Qasimcode builds appointment-based websites for clinics, salons, studios, and trades, with online booking integrated to existing calendars. Sites are written, built, and deployed live within two to four weeks at a fixed price agreed upfront. The studio provides ongoing monthly care including updates, backups, security, and support.",
  audiences: [
    "Speech therapy practices",
    "Medical and dental clinics",
    "Salons and beauty studios",
    "Trades and service businesses",
    "Small businesses needing appointment booking",
  ],
};

/** The head of the real stored profile, strongest first. */
const PROFILE = {
  topTerms: [
    "qasimcode", "studios", "websites", "clinics", "salons",
    "small", "design", "appointment", "english", "studio",
  ],
};

describe("categoryOf — after #180", () => {
  it("no longer answers with the payment terms", () => {
    // Every pair in a 3-sentence positioning paragraph occurs exactly once, so
    // the count separated nothing and `localeCompare` decided everything:
    // qasimcode.com's category came out as "agreed upfront", from the closing
    // clause about payment terms, and every audience playbook read "best
    // agreed upfront for medical and dental clinics".
    const nouns = keyNouns(BUSINESS.description, 8);
    expect(nouns).toContain("appointment-based websites");
    expect(nouns).not.toContain("agreed upfront");
    expect(categoryOf(BUSINESS, "qasimcode.com")).not.toContain("agreed");
    expect(categoryOf(BUSINESS, "qasimcode.com")).not.toContain("qasimcode");
  });

  it("is still a phrase from prose, which is why the seeds do not use it", () => {
    // "appointment-based websites" is a fair category and a terrible seed:
    // `keyword_suggestions` returns only phrases CONTAINING it, and nothing
    // contains "appointment-based". `categoryHead` below answers "website".
    expect(categoryOf(BUSINESS, "qasimcode.com")).toBe("appointment-based websites");
  });
});

describe("audienceHead", () => {
  it("reduces an audience to something a query can contain", () => {
    // `keyword_suggestions` returns phrases containing the seed, so a six-word
    // seed returns nothing at all.
    expect(audienceHead("Medical and dental clinics")).toBe("dental clinic");
    expect(audienceHead("Salons and beauty studios")).toBe("beauty studio");
    expect(audienceHead("Speech therapy practices")).toBe("therapy practice");
    expect(audienceHead("Small businesses needing appointment booking")).toBe("appointment booking");
  });
});

describe("categoryHead", () => {
  it("is what they sell, not who they sell to", () => {
    // "studios", "clinics" and "salons" outrank "websites" in the profile and
    // are the first three things a naive top-terms read would pick. They are
    // the audiences. The thing being sold is the website.
    expect(categoryHead(BUSINESS, PROFILE, "qasimcode.com")).toBe("website");
  });

  it("gives up rather than guessing", () => {
    expect(categoryHead(BUSINESS, null)).toBeNull();
    expect(categoryHead({ description: "", audiences: [] }, PROFILE)).toBeNull();
    // Nothing in the top terms is in the description: no category to state.
    expect(categoryHead(BUSINESS, { topTerms: ["quantum", "helium"] }, "qasimcode.com")).toBeNull();
  });
});

describe("audienceSeeds", () => {
  it("produces the long tail the headings could never reach", () => {
    const seeds = audienceSeeds(BUSINESS, PROFILE, "qasimcode.com");
    expect(seeds.map((s) => s.seed)).toEqual([
      "therapy practice website",
      "dental clinic website",
      "beauty studio website",
      "trade service website",
      "appointment booking website",
    ]);
    // Each row can say which audience paid for it.
    expect(seeds[1].audience).toBe("Medical and dental clinics");
  });

  it("returns nothing rather than a bad seed", () => {
    expect(audienceSeeds(null, PROFILE)).toEqual([]);
    expect(audienceSeeds({ ...BUSINESS, audiences: [] }, PROFILE)).toEqual([]);
    // No category head means no "<audience> <what>" to build.
    expect(audienceSeeds(BUSINESS, null)).toEqual([]);
  });

  it("does not repeat the category back at itself", () => {
    const seeds = audienceSeeds(
      { description: "We build websites.", audiences: ["Small business websites"] },
      { topTerms: ["websites"] },
    );
    expect(seeds).toEqual([]);
  });
});
