import { describe, it, expect } from "vitest";
import { buildTopicalProfile, scoreRelevance, subjectVocabulary } from "../topical-profile";
import { isHopeless, isOutOfReach, HOPELESS_DIFFICULTY } from "../difficulty";
import type { CrawlResult } from "@/lib/audit/crawler";

/**
 * qasimcode.com, signed up 2026-09-07, authority 0.
 *
 * Its first article was "Do Other Countries Have States? Full 2026 Breakdown",
 * for a studio that builds appointment-booking websites for clinics and
 * salons. Nothing in the product objected, and the reason is here: the pages
 * list the markets the studio works in, so "other", "countries" and "states"
 * are genuinely in the site's vocabulary and the keyword scored a perfect
 * 1.00. The seed that produced it came out of the same headings, so the
 * vocabulary could never be the thing that rejects it.
 *
 * The profile below is a small reconstruction of the real one, chosen so the
 * junk words behave exactly as they do in production: present, and weak.
 */
const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://qasimcode.com/",
  status: 200,
  title: "",
  metaDescription: "",
  h1: [],
  h2: [],
  images: [],
  links: [],
  loadTimeMs: 0,
  ...over,
});

const QASIMCODE = buildTopicalProfile(
  "qasimcode.com",
  [
    page({
      title: "Appointment websites for clinics, salons and studios | Qasimcode",
      metaDescription: "Booking websites built at a fixed price, live in four weeks.",
      h1: ["Websites that fill the appointment book"],
      h2: ["Clinics and dental practices", "Salons and beauty studios"],
    }),
    page({
      title: "Where we work | Qasimcode",
      h1: ["Clients in other countries"],
      h2: ["The United States", "Danish and Irish clinics", "Trades and repair"],
    }),
    page({ title: "Design | Qasimcode", h1: ["Website design that books appointments"] }),
  ],
  "2026-09-07T23:09:02.212Z",
);

const BUSINESS = {
  description:
    "Qasimcode builds appointment-based websites for clinics, salons, studios, and trades, with online booking integrated to existing calendars. Sites are deployed live within two to four weeks at a fixed price agreed upfront.",
  audiences: [
    "Speech therapy practices",
    "Medical and dental clinics",
    "Salons and beauty studios",
    "Trades and service businesses",
  ],
  competitors: ["acuityscheduling.com", "calendly.com", "squarespace.com"],
};

const SUBJECT = subjectVocabulary(BUSINESS, QASIMCODE);

describe("subjectVocabulary", () => {
  it("is empty without a business profile, which disables the test entirely", () => {
    expect(subjectVocabulary(null, QASIMCODE).size).toBe(0);
    expect(subjectVocabulary({ description: "", audiences: [] }, QASIMCODE).size).toBe(0);
  });

  it("carries what they sell, who to and against whom", () => {
    expect(SUBJECT.has("websites")).toBe(true);
    expect(SUBJECT.has("booking")).toBe(true);
    expect(SUBJECT.has("dental")).toBe(true);
    // A competitor domain, reduced the way a searcher types it.
    expect(SUBJECT.has("calendly")).toBe(true);
    expect(SUBJECT.has("com")).toBe(false);
  });

  it("does not carry the words the copy merely passed through", () => {
    for (const w of ["countries", "states", "danish", "irish"]) {
      expect(SUBJECT.has(w)).toBe(false);
    }
  });
});

describe("scoreRelevance — the subject floor", () => {
  it("scores the keyword that got written 1.00 on vocabulary alone", () => {
    // Unchanged, and the point: this is not a filter the words can fail.
    expect(scoreRelevance("do other countries have states", QASIMCODE).score).toBeGreaterThan(0.9);
  });

  it("rejects it against what the business says it does", () => {
    const r = scoreRelevance("do other countries have states", QASIMCODE, SUBJECT);
    expect(r.score).toBe(0);
    expect(r.reason).toContain("says it does");
    expect(scoreRelevance("other countries", QASIMCODE, SUBJECT).score).toBe(0);
  });

  it("leaves the on-topic keywords alone", () => {
    for (const term of [
      "website design",
      "small business websites",
      "dental clinic website",
      "online booking for clinics",
    ]) {
      expect(scoreRelevance(term, QASIMCODE, SUBJECT).score).toBeGreaterThan(0);
    }
  });

  it("stops vetoing the competitor and audience terms the playbooks exist for", () => {
    // These are the terms worth writing and none of them could ever be stored:
    // a rival's brand and an audience with no page yet are, by definition, not
    // in the site's own headings, so the foreign-word veto refused all of them.
    for (const term of ["calendly alternative", "acuityscheduling pricing", "speech therapy website"]) {
      expect(scoreRelevance(term, QASIMCODE).score).toBe(0);
      expect(scoreRelevance(term, QASIMCODE, SUBJECT).score).toBeGreaterThan(0);
    }
  });

  it("scores the customer's say-so below the site's own vocabulary", () => {
    // Named but not yet written about, so it is worth less than a word the
    // business has built pages around - and still worth more than nothing.
    const named = scoreRelevance("speech therapy website", QASIMCODE, SUBJECT).score;
    const written = scoreRelevance("clinic website", QASIMCODE, SUBJECT).score;
    expect(named).toBeGreaterThan(0);
    expect(named).toBeLessThan(written);
  });

  it("still refuses a word from neither the site nor the profile", () => {
    expect(scoreRelevance("plumbing quotes", QASIMCODE, SUBJECT).score).toBe(0);
    expect(scoreRelevance("website plumbing", QASIMCODE, SUBJECT).score).toBe(0);
  });
});

describe("isHopeless", () => {
  it("is the only judgement allowed to drop a keyword, and needs no authority", () => {
    // qasimcode.com's five KD 100 rows. Nothing about anyone's authority makes
    // "create business websites" a plan for a studio that opened last month.
    expect(isHopeless(100)).toBe(true);
    expect(isHopeless(HOPELESS_DIFFICULTY)).toBe(true);
    expect(isHopeless(89)).toBe(false);
    expect(isHopeless(null)).toBe(false);
  });
});

describe("isOutOfReach", () => {
  it("refuses what a new site cannot win", () => {
    // qasimcode.com was measured at authority 0 by the same run that stored
    // five KD 100 keywords, and drafted one of them. At authority 0 the reach
    // runs out at KD 32, which is where "idea for small businesses" sits and
    // "website design firms" (35) does not.
    expect(isOutOfReach(100, 0)).toBe(true);
    expect(isOutOfReach(70, 0)).toBe(true);
    expect(isOutOfReach(35, 0)).toBe(true);
    expect(isOutOfReach(32, 0)).toBe(false);
    expect(isOutOfReach(14, 0)).toBe(false);
  });

  it("scales with the site rather than judging KD in the abstract", () => {
    expect(isOutOfReach(60, 0)).toBe(true);
    expect(isOutOfReach(60, 50)).toBe(false);
  });

  it("refuses a hopeless SERP even with no authority measured", () => {
    // Null authority is the state of every workspace mid-first-run, and it is
    // not a reason to store KD 100.
    expect(isOutOfReach(HOPELESS_DIFFICULTY, null)).toBe(true);
    expect(isOutOfReach(100, null)).toBe(true);
    expect(isOutOfReach(60, null)).toBe(false);
  });

  it("says nothing about a difficulty nobody measured", () => {
    expect(isOutOfReach(null, 0)).toBe(false);
    expect(isOutOfReach(undefined, 0)).toBe(false);
  });
});
