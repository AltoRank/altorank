import { describe, expect, it } from "vitest";
import { pickCompetitorDomain, resolveCompetitorDomains } from "../competitor-domains";

describe("pickCompetitorDomain", () => {
  it("takes the host that is the name, not a directory that ranks for it", () => {
    expect(pickCompetitorDomain("trainerize", ["www.g2.com", "www.trainerize.com", "reddit.com"])).toBe("trainerize.com");
  });
  it("squashes a spaced name", () => {
    expect(pickCompetitorDomain("pt distinction", ["www.ptdistinction.com"])).toBe("ptdistinction.com");
  });
  it("drops an app subdomain", () => {
    expect(pickCompetitorDomain("truecoach", ["app.truecoach.co"])).toBe("truecoach.co");
  });
  it("needs equality, not containment", () => {
    expect(pickCompetitorDomain("coach", ["truecoach.co"])).toBeNull();
  });
});

describe("resolveCompetitorDomains", () => {
  const deps = {
    searchHosts: async (name: string) => (name === "trainerize" ? ["www.capterra.it", "www.trainerize.com"] : []),
    reachable: async (domain: string) => domain === "ptdistinction.com",
  };
  it("keeps domains, resolves names by search then DNS, and reports the rest", async () => {
    const out = await resolveCompetitorDomains(
      ["https://www.truecoach.co/pricing", "trainerize", "pt distinction", "some unknown brand"],
      deps,
    );
    expect(out.domains).toEqual(["truecoach.co", "trainerize.com", "ptdistinction.com"]);
    expect(out.unresolved).toEqual(["some unknown brand"]);
  });
  it("survives a search that throws", async () => {
    const out = await resolveCompetitorDomains(["trainerize"], {
      searchHosts: async () => { throw new Error("no creds"); },
      reachable: async () => true,
    });
    expect(out.domains).toEqual(["trainerize.com"]);
  });
});
