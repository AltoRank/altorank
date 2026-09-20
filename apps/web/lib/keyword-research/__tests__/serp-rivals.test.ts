import { describe, expect, it } from "vitest";
import { findSerpRivals, pickSerpRivals } from "../serp-rivals";

describe("pickSerpRivals", () => {
  const pages = [
    ["www.capterra.it", "blog.revoo-app.com", "www.qomodo.me", "fitsuite.co"],
    ["gymkee.com", "www.qomodo.me", "www.reddit.com", "blog.revoo-app.com"],
    ["www.qomodo.me", "www.youtube.com", "trainerize.com"],
  ];
  it("ranks hosts by how many results pages they hold, then by how high", () => {
    expect(pickSerpRivals(pages, new Set(["fitsuite.co", "trainerize.com"]))).toEqual([
      "qomodo.me", "blog.revoo-app.com", "gymkee.com",
    ]);
  });
  it("never returns a directory, a social site, the site itself or a rival already named", () => {
    const out = pickSerpRivals(pages, new Set(["fitsuite.co", "trainerize.com"]), 10);
    for (const host of ["capterra.it", "reddit.com", "youtube.com", "fitsuite.co", "trainerize.com"]) {
      expect(out).not.toContain(host);
    }
  });
  it("counts a host once per page", () => {
    expect(pickSerpRivals([["a.com", "a.com", "b.com"], ["b.com"]], new Set())).toEqual(["b.com", "a.com"]);
  });
});

describe("findSerpRivals", () => {
  it("reports a search that errored instead of reading it as an empty page", async () => {
    const out = await findSerpRivals(["crm palestra", "app personal trainer"], { languageCode: "it", locationCode: 2380 }, new Set(), {
      search: async (term) => { if (term === "crm palestra") throw new Error("503"); return ["www.qomodo.me"]; },
    });
    expect(out.failed).toEqual(["crm palestra"]);
    expect(out.rivals).toEqual(["qomodo.me"]);
  });
});
