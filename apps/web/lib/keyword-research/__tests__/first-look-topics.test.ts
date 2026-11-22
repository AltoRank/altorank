import { describe, expect, it } from "vitest";
import {
  asksQuestion,
  bestCase,
  demandScore,
  describeScore,
  fallbackAngle,
  ownerConfirmedBrief,
  pageScore,
  parseSuggestions,
  proposalOf,
  reachScore,
  readProposal,
  relatedEvidence,
  relatedness,
  secondAskPrompt,
  rejectBeforeResults,
  rejectOnResults,
  salvageTopics,
  scoreTopic,
  selectionReasons,
  suggestCachePrefix,
  suggestTopicsPrompt,
  topicBrief,
  UNMEASURED_DEMAND,
  type ChosenTopic,
  type SuggestedTopic,
} from "../first-look-topics";
import { contextKey, readOpportunity } from "../opportunity";
import { readResultsPage, type ResultsPageEntry } from "../results-page";

const TOPIC: SuggestedTopic = {
  query: "how to apply for a housing grant",
  fromList: false,
  reader: "Residents looking for public support",
  job: "Find out whether they qualify and how to apply",
  offering: "The scheme finder",
  angle: "How to apply for a housing grant: eligibility, documents and steps",
  shape: "howTo",
  fit: 5,
  kind: "question",
  why: "The site's readers come to it to understand public support they can claim.",
};

const article = (n: number, term = "housing grant"): ResultsPageEntry => ({
  rank: n, title: `How to apply for a ${term}: a guide`, url: `https://news-${n}.example/blog/${term.replace(/ /g, "-")}-guide`, description: `A guide to the ${term}.`,
});
const provider = (n: number): ResultsPageEntry => ({ rank: n, title: `Housing grant help | Acme ${n} | Book now`, url: `https://provider-${n}.example/`, description: "Housing grant applications done for you. Call us today" });

describe("the suggestion prompt", () => {
  it("asks for readers, not only buyers, and gives the model the site, its pages, its searches and its rivals", () => {
    const prompt = suggestTopicsPrompt({
      business: { name: "Example Relief", description: "Independent guides to public support schemes.", audiences: ["citizens seeking support"], offerings: ["scheme guides"] },
      domain: "https://relief.example",
      language: "English",
      pages: [{ title: "Find schemes", path: "/find-schemes/" }],
      pool: [
        { term: "housing grant eligibility", volume: 320, difficulty: 12 },
        { term: "grant application status", volume: null, difficulty: null, parked: true },
      ],
      rivalPages: [{ rival: "rival.example", pages: ["how to check grant status online"] }],
    });
    expect(prompt).toMatch(/Not only people about to buy/);
    expect(prompt).toContain("citizens");
    expect(prompt).toContain("Domain: relief.example");
    expect(prompt).toContain("- Find schemes (/find-schemes/)");
    expect(prompt).toContain("- housing grant eligibility (320/month, difficulty 12)");
    // The buyer test's refusal is said as what it was: a buyers-only check.
    expect(prompt).toContain("- grant application status (volume not measured, an earlier buyers-only check refused it)");
    expect(prompt).toContain("- rival.example: how to check grant status online");
    // The instructions come first and are the cached part.
    expect(prompt.slice(suggestCachePrefix(prompt))).toMatch(/^The site:/);
  });
});

describe("parseSuggestions", () => {
  it("keeps complete topics, one per search, and drops the rest", () => {
    const parsed = parseSuggestions({
      topics: [
        TOPIC,
        { ...TOPIC, query: "  How To Apply For A  Housing Grant " },
        { ...TOPIC, query: "grant deadlines", reader: "" },
        { ...TOPIC, query: "grant deadlines 2026", fit: 9, kind: "nonsense" },
        { ...TOPIC, query: "who qualifies for a housing grant", fit: 3.6, shape: "poem" },
      ],
    });
    expect(parsed.map((t) => t.query)).toEqual(["how to apply for a housing grant", "who qualifies for a housing grant"]);
    expect(parsed[1]).toMatchObject({ fit: 4, shape: "explainer" });
  });
  it("is empty, not an error, for an unusable reply", () => {
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions({ topics: "no" })).toEqual([]);
  });
});

describe("salvageTopics", () => {
  const second = { ...TOPIC, query: "who qualifies for a housing grant", why: 'Says "eligible" {twice}, with braces' };
  const whole = JSON.stringify({ topics: [TOPIC, second, { ...TOPIC, query: "grant deadlines" }] });
  it("keeps the topics a cut-off reply finished, and not the one it stopped inside", () => {
    const cut = whole.slice(0, whole.indexOf("grant deadlines") + 5);
    const kept = parseSuggestions(salvageTopics(cut));
    expect(kept.map((t) => t.query)).toEqual(["how to apply for a housing grant", "who qualifies for a housing grant"]);
    expect(kept[1].why).toBe('Says "eligible" {twice}, with braces');
  });
  it("reads a whole reply the same as the parser, and nothing from no reply", () => {
    expect(salvageTopics(whole)).toHaveLength(3);
    expect(salvageTopics(null)).toEqual([]);
    expect(salvageTopics('{"topics": [{"query": "how')).toEqual([]);
  });
});

describe("scoring", () => {
  it("counts unmeasured demand as neutral, and any measured volume above it", () => {
    expect(demandScore(null)).toBe(UNMEASURED_DEMAND);
    expect(demandScore(0)).toBe(UNMEASURED_DEMAND);
    expect(demandScore(10)).toBeGreaterThan(UNMEASURED_DEMAND);
    expect(demandScore(1_000)).toBeGreaterThan(demandScore(100));
    expect(demandScore(1_000_000)).toBe(1);
  });
  it("reads reach against the site's authority", () => {
    expect(reachScore(null, 10)).toBe(0.6);
    expect(reachScore(20, 30)).toBeGreaterThan(reachScore(60, 30));
    expect(reachScore(90, 0)).toBeGreaterThan(0);
  });
  it("prefers results pages that articles win, and one the site already holds less", () => {
    const editorial = readResultsPage([article(1), article(2), article(3)], { term: "housing grant" });
    expect(pageScore(null)).toBe(0.5);
    expect(pageScore({ reading: editorial })).toBe(1);
    expect(pageScore({ reading: editorial, ownUrl: "https://relief.example/grant" })).toBeLessThan(0.5);
  });
  it("ranks a better-fitting unmeasured topic above a measured one that barely fits", () => {
    const fits = scoreTopic({ fit: 5, kind: "question" }, { volume: null, difficulty: null, authority: 5 });
    const measured = scoreTopic({ fit: 2, kind: "question" }, { volume: 5_000, difficulty: 10, authority: 5 });
    expect(fits.total).toBeGreaterThan(measured.total);
    expect(fits.demandMeasured).toBe(false);
    expect(measured.demandMeasured).toBe(true);
    // Measured demand wins between two topics that fit the same.
    const twin = scoreTopic({ fit: 5, kind: "question" }, { volume: 300, difficulty: null, authority: 5 });
    expect(twin.total).toBeGreaterThan(fits.total);
  });
  it("knows the most an unread topic could still score", () => {
    const s = scoreTopic(TOPIC, { volume: null, difficulty: null, authority: null });
    expect(bestCase(s)).toBeCloseTo(s.total + 12.5, 5);
    expect(describeScore(s)).toMatch(/^\d+(\.\d)?\/100: fit 1\.00, demand unmeasured, reach 0\.60, page 0\.50$/);
  });
});

describe("what removes a topic", () => {
  const ctx = { domain: "relief.example", business: { competitors: ["rivalaid.example"], competitorNames: ["Grant Helpers"] } };
  it("removes names, navigational and off-topic searches before any results page", () => {
    expect(rejectBeforeResults(TOPIC, ctx)).toBeNull();
    expect(rejectBeforeResults({ ...TOPIC, kind: "brand" }, ctx)).toBe("brand");
    expect(rejectBeforeResults({ ...TOPIC, kind: "navigational" }, ctx)).toBe("navigational");
    expect(rejectBeforeResults({ ...TOPIC, kind: "offtopic" }, ctx)).toBe("offtopic");
    expect(rejectBeforeResults({ ...TOPIC, fit: 1 }, ctx)).toBe("offtopic");
    expect(rejectBeforeResults({ ...TOPIC, query: "rivalaid housing grant" }, ctx)).toBe("brand");
    expect(rejectBeforeResults({ ...TOPIC, query: "grant helpers review" }, ctx)).toBe("brand");
    // The site's own name: someone looking for it, not for an article.
    expect(rejectBeforeResults({ ...TOPIC, query: "examplerelief housing grant login" }, { ...ctx, domain: "examplerelief.example" })).toBe("brand");
  });
  it("never removes a topic for unmeasured demand, a buyer test or a transactional label alone", () => {
    expect(rejectBeforeResults({ ...TOPIC, kind: "transactional" }, ctx)).toBeNull();
    expect(rejectBeforeResults({ ...TOPIC, fit: 2 }, ctx)).toBeNull();
  });
  it("removes a search whose results are providers' own pages", () => {
    const providers = readResultsPage([1, 2, 3, 4, 5, 6, 7].map(provider), { term: "housing grant" });
    expect(rejectOnResults(providers)).toBe("needs_page");
    expect(rejectOnResults(readResultsPage([article(1), article(2)], { term: "housing grant" }))).toBeNull();
  });
  it("keeps a search whose words ask a question, whoever wins its results page", () => {
    const providers = readResultsPage([1, 2, 3, 4, 5, 6, 7].map(provider), { term: "housing grant" });
    expect(rejectOnResults(providers, { question: true })).toBeNull();
    expect(rejectOnResults({ type: "navigational" }, { question: true })).toBe("navigational");
  });
  it("reads a question from the words alone, and only in a language it has words for", () => {
    for (const q of ["how to soundproof a room", "garden office ideas", "roof repair tips", "what is a party wall", "come scegliere un materasso"]) {
      expect(asksQuestion(q, q.startsWith("come") ? "it" : "en"), q).toBe(true);
    }
    for (const q of ["roofing contractor", "buy garden office", "best roofing company", "party wall surveyor"]) {
      expect(asksQuestion(q, "en"), q).toBe(false);
    }
    // No lexicon: the words say nothing either way, and the results page decides.
    expect(asksQuestion("πώς να διαλέξετε στρώμα", "el")).toBe(false);
  });
});

describe("the brief", () => {
  const CONTEXT = { domain: "relief.example", business: { name: "Example Relief" }, languageCode: "en", locationCode: 2586 };
  const fingerprint = contextKey(CONTEXT);
  const chosen = (organic: ResultsPageEntry[], volume: number | null = null): ChosenTopic => {
    const reading = readResultsPage(organic, { term: TOPIC.query });
    const score = scoreTopic(TOPIC, { volume, difficulty: null, authority: null, page: { reading } });
    return { topic: TOPIC, score, volume, difficulty: null, page: { reading }, organicUrls: organic.map((r) => r.url) };
  };

  it("passes the writer's own check, says unmeasured demand plainly, and carries its score", () => {
    const c = chosen([article(1, "housing grant"), article(2, "housing grant"), article(3, "housing grant")]);
    const brief = topicBrief(c, { fingerprint, domain: "relief.example", conversionUrl: "https://relief.example/find-schemes/" })!;
    expect(brief).toMatchObject({ status: "qualified", demand: "unmeasured", format: "article", shape: "howTo", conversionPath: "https://relief.example/find-schemes/" });
    expect(brief.reason).toContain("No search volume is reported for it in this market yet (unmeasured); chosen for fit.");
    expect(brief.firstLookScore?.total).toBe(c.score.total);
    expect(brief.confidence).toBeUndefined();
    // What lib/content/generate.ts reads back before an automatic draft.
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
    expect(selectionReasons(c)[1]).toMatch(/demand is unmeasured/);
  });

  it("is lower confidence on one article, and still passes the check", () => {
    const c = chosen([article(1, "housing grant"), provider(2), provider(3)], 480);
    const brief = topicBrief(c, { fingerprint, domain: "relief.example" })!;
    expect(brief.confidence).toBe("lower");
    expect(brief.demand).toBeUndefined();
    expect(brief.reason).toContain("About 480 searches a month.");
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
  });

  it("is lower confidence on a page providers' own pages win, however many articles it cites", () => {
    const organic = [article(1, "housing grant"), article(2, "housing grant"), ...[3, 4, 5, 6, 7, 8, 9].map(provider)];
    const c = chosen(organic);
    expect(c.page.reading.type).toBe("service");
    const brief = topicBrief(c, { fingerprint, domain: "relief.example" })!;
    expect(brief.evidenceUrls).toHaveLength(2);
    expect(brief.confidence).toBe("lower");
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
    expect(selectionReasons(c)[2]).toMatch(/Providers' own pages win most of this search/);
  });

  it("is not written with nothing in the results to cite or a destination off the site, and replaces a dated headline", () => {
    expect(topicBrief(chosen([provider(1), provider(2)]), { fingerprint, domain: "relief.example" })).toBeNull();
    // A headline the model dated used to cost the topic; the search stands in.
    const dated = { ...chosen([article(1), article(2)]), topic: { ...TOPIC, angle: "Housing grants in 2019" } };
    const redated = topicBrief(dated, { fingerprint, domain: "relief.example" })!;
    expect(redated.angle).toBe(fallbackAngle(TOPIC.query));
    expect(redated.angle).not.toMatch(/2019/);
    expect(readOpportunity(redated, fingerprint)).not.toBeNull();
    const elsewhere = topicBrief(chosen([article(1), article(2)]), { fingerprint, domain: "relief.example", conversionUrl: "https://other.example/buy" })!;
    expect(elsewhere.conversionPath).toBe("https://relief.example");
  });
  it("cites a related search's articles when its own results have none, and says so", () => {
    const c = chosen([provider(1), provider(2)]);
    const borrowed = { from: "housing grant application steps", urls: ["https://news-1.example/blog/housing-grant-guide"] };
    const brief = topicBrief(c, { fingerprint, domain: "relief.example", borrowed, rung: "related_evidence" })!;
    expect(brief).toMatchObject({ confidence: "lower", evidenceFrom: "housing grant application steps", rung: "related_evidence", evidenceUrls: borrowed.urls });
    // The borrowed page is listed after the search's own results, never in their place.
    expect(brief.organicUrls).toEqual([...c.organicUrls, ...borrowed.urls]);
    expect(brief.reason).toMatch(/related search "housing grant application steps"/);
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
    // Its own evidence wins when it has any: nothing is borrowed then.
    const own = topicBrief(chosen([article(1), article(2)]), { fingerprint, domain: "relief.example", borrowed })!;
    expect(own.evidenceFrom).toBeUndefined();
  });

  it("borrows only from a closely related search that had something to cite", () => {
    expect(relatedness("garden office cost", "how much does a garden office cost")).toBe(1);
    expect(relatedness("garden office cost", "office chair reviews")).toBeLessThan(0.6);
    const read = [
      { query: "office chair reviews", evidence: ["https://a.example/blog/chairs"] },
      { query: "garden office installers", evidence: [] },
      { query: "garden office prices", evidence: ["https://b.example/blog/prices", "https://c.example/blog/prices"] },
    ];
    expect(relatedEvidence("how much does a garden office cost", read)).toEqual({ from: "garden office prices", urls: ["https://b.example/blog/prices", "https://c.example/blog/prices"] });
    expect(relatedEvidence("party wall surveyor fees", read)).toBeNull();
    // Never from itself.
    expect(relatedEvidence("garden office prices", read)).toBeNull();
  });

  it("turns a proposal into a brief only with the owner's confirmation, citing nothing", () => {
    const c = chosen([provider(1), provider(2)]);
    const proposal = proposalOf(c);
    expect(proposal).toMatchObject({ term: TOPIC.query, checked: true, why: TOPIC.why });
    // Off a run's row and back.
    expect(readProposal(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
    expect(readProposal({ term: "x" })).toBeNull();
    const brief = ownerConfirmedBrief(proposal, { fingerprint, domain: "relief.example", now: new Date() });
    expect(brief).toMatchObject({ status: "qualified", confidence: "lower", rung: "owner_confirmed", evidenceUrls: [] });
    expect(brief.reason).toMatch(/confirmed by the site's owner/);
    expect(readOpportunity(brief, fingerprint)).not.toBeNull();
    // Without the confirmation the same brief is refused: a planner cannot write it.
    const { ownerConfirmed: _confirmed, ...unconfirmed } = brief;
    expect(readOpportunity(unconfirmed, fingerprint)).toBeNull();
    // And the confirmation excuses nothing at full confidence.
    expect(readOpportunity({ ...brief, confidence: undefined }, fingerprint)).toBeNull();
  });
});

describe("the second ask", () => {
  it("asks for question searches built from the profile, and names what was tried", () => {
    const prompt = secondAskPrompt({
      business: { name: "Example Relief", description: "Guides to public support.", buyingJobs: ["work out which scheme they qualify for"], offerings: ["scheme finder"], audiences: ["residents on low incomes"] },
      domain: "https://relief.example",
      language: "English",
      tried: ["housing grant consultant", "housing grant agency"],
    });
    expect(prompt).toContain("- work out which scheme they qualify for");
    expect(prompt).toContain("- scheme finder");
    expect(prompt).toContain("- residents on low incomes");
    expect(prompt).toContain("Searches already tried:\n- housing grant consultant\n- housing grant agency");
    expect(prompt).toMatch(/how to choose/);
    // The instructions are the cached part, as in the first ask.
    expect(suggestCachePrefix(prompt)).toBeGreaterThan(0);
    expect(fallbackAngle("how to choose a garden office")).toBe("How to choose a garden office");
  });
});
