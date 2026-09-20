import { describe, expect, it } from "vitest";
import { findSerpRivals, pickSerpRivals, rivalCandidates, vetRivals } from "../serp-rivals";

describe("pickSerpRivals", () => {
  const pages = [
    ["www.capterra.it", "blog.revoo-app.com", "www.qomodo.me", "fitsuite.co"],
    ["gymkee.com", "www.qomodo.me", "www.reddit.com", "blog.revoo-app.com"],
    ["www.qomodo.me", "www.youtube.com", "trainerize.com"],
  ];
  it("ranks hosts by how many results pages they hold, then by how high", () => {
    expect(pickSerpRivals(pages, new Set(["fitsuite.co", "trainerize.com"]))).toEqual([
      "qomodo.me", "blog.revoo-app.com",
    ]);
  });
  it("does not top up from hosts seen on a single page", () => {
    expect(pickSerpRivals(pages, new Set())).not.toContain("gymkee.com");
  });
  it("never returns a directory, a social site, the site itself or a rival already named", () => {
    const out = pickSerpRivals(pages, new Set(["fitsuite.co", "trainerize.com"]), 10);
    for (const host of ["capterra.it", "reddit.com", "youtube.com", "fitsuite.co", "trainerize.com"]) {
      expect(out).not.toContain(host);
    }
  });
  it("counts a host once per page", () => {
    // a.com twice on one page is still one page, so it is not a rival.
    expect(pickSerpRivals([["a.com", "a.com", "b.com"], ["b.com"]], new Set())).toEqual(["b.com"]);
  });
});

const BUSINESS = { description: "Coaching software for personal trainers", offerings: ["client management"] };
const page = (...hosts: string[]) => hosts.map((host) => ({ host, title: `${host} title` }));

describe("vetRivals", () => {
  const candidates = rivalCandidates([page("qomodo.me", "aranzulla.it", "technogym.com"), page("qomodo.me", "aranzulla.it", "technogym.com")], new Set());
  it("reads only the hosts the model says sell against this business, in candidate order", async () => {
    const out = await vetRivals(candidates, BUSINESS, { ask: async () => '{"rivals":["www.qomodo.me"]}' });
    expect(out).toEqual({ rivals: ["qomodo.me"], vetted: true });
  });
  it("ignores a host the model invents", async () => {
    const out = await vetRivals(candidates, BUSINESS, { ask: async () => '{"rivals":["made-up.com"]}' });
    expect(out.rivals).toEqual([]);
  });
  it("reads no rival when the model cannot answer, and says it was not vetted", async () => {
    expect(await vetRivals(candidates, BUSINESS, { ask: async () => null })).toEqual({ rivals: [], vetted: false });
    expect(await vetRivals(candidates, null, { ask: async () => '{"rivals":["qomodo.me"]}' })).toEqual({ rivals: [], vetted: false });
  });
});

describe("findSerpRivals", () => {
  const ask = async () => '{"rivals":["qomodo.me"]}';
  it("reports a search that errored instead of reading it as an empty page", async () => {
    const out = await findSerpRivals(["crm palestra", "app personal trainer", "software palestra"], { languageCode: "it", locationCode: 2380 }, new Set(), {
      business: BUSINESS, ask,
      search: async (term) => { if (term === "crm palestra") throw new Error("503"); return page("www.qomodo.me"); },
    });
    expect(out.failed).toEqual(["crm palestra"]);
    expect(out.rivals).toEqual(["qomodo.me"]);
    expect(out.candidates).toEqual(["qomodo.me"]);
  });
  it("searches the seeds in the order given, up to the cap", async () => {
    const seen: string[] = [];
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    await findSerpRivals(seeds, { languageCode: "it", locationCode: 2380 }, new Set(), { business: BUSINESS, ask, search: async (t) => { seen.push(t); return []; } });
    expect(seen.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});
