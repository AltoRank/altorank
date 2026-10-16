import { describe, it, expect } from "vitest";
import { verifyOutboundLinks, type LinkFetcher } from "../link-check";
import { verifyCitedFigures, type PageFetcher } from "../citation-check";
import { factCheckArticle } from "@/lib/ai/fact-check";
import { addSectionImages } from "@/lib/content/enrich/images";

// The steps between the writer and the save, given what the draft has left
// (lib/content/generate.ts): a server that never answers ends the step at its
// signal, and what the step had already done is kept. The stand-ins never
// answer and never look at a signal.

const hang = <T,>() => new Promise<T>(() => undefined);

describe("the outbound link check against its deadline", () => {
  it("stops at the signal, removes nothing it could not check, and keeps what answered", async () => {
    const fetcher: LinkFetcher = async (url) => (url.includes("good") ? { status: 200 } : hang());
    const html = '<p><a href="https://good.example/a">a</a> <a href="https://slow.example/b">b</a> <a href="https://slow.example/c">c</a></p>';
    const started = Date.now();
    const { html: out, checks } = await verifyOutboundLinks(html, "acme.example", { fetcher, concurrency: 1, signal: AbortSignal.timeout(60) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toBe(html);
    expect(checks.map((c) => [c.url, c.verdict, c.removed])).toEqual([
      ["https://good.example/a", "live", false],
      ["https://slow.example/b", "unverified", false],
      ["https://slow.example/c", "unverified", false],
    ]);
    expect(checks[1].reason).toMatch(/no time left/);
  });
});

describe("the fact check's page reads against their deadline", () => {
  it("leaves a claim whose page never answered as the first pass marked it", async () => {
    const before = factCheckArticle(
      '<p>According to the Bureau of Labor Statistics, employment is projected to grow 8 percent from 2025 to 2035. <a href="https://www.bls.gov/ooh/x.htm">BLS</a></p>',
    );
    expect(before.claims[0].status).toBe("needs_verification");
    const fetcher: PageFetcher = () => hang();
    const started = Date.now();
    const after = await verifyCitedFigures(before, { fetcher, signal: AbortSignal.timeout(60) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(after.claims[0].status).toBe("needs_verification");
    expect(after.verdict).toBe(before.verdict);
  });
});

describe("the section images against their deadline", () => {
  const section = (h: string) => `<h2>${h}</h2><p>${Array.from({ length: 100 }, () => h.toLowerCase()).join(" ")}.</p>`;
  const html = ["<p>Intro.</p>", section("Alpha"), section("Beta"), section("Gamma"), section("Delta"), section("Epsilon")].join("");

  it("keeps the images made in time, abandons the one in flight and starts no more", async () => {
    let calls = 0;
    const produce = async () => (++calls === 1 ? "https://img.example/1.webp" : hang<string>());
    const signal = AbortSignal.timeout(80);
    const started = Date.now();
    const result = await addSectionImages(html, { produce, max: 3, signal });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toBe(2);
    expect(result.added).toBe(1);
    expect(result.html).toContain('src="https://img.example/1.webp"');
    expect(result.warnings.join(" ")).toMatch(/images stopped at 1 of \d: image 2 was not ready/);
  });

  it("starts none once the time is up", async () => {
    let calls = 0;
    const result = await addSectionImages(html, { produce: async () => { calls += 1; return "x"; }, max: 3, signal: AbortSignal.abort() });
    expect(calls).toBe(0);
    expect(result.html).toBe(html);
  });
});
