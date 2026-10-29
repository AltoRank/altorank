import { describe, expect, it } from "vitest";
import { nextArticles } from "../next-articles";

describe("nextArticles", () => {
  const planned = [
    { term: "acme kits", date: "2026-10-12" },
    { term: "acme kit sizes", date: "2026-10-16" },
    { term: "best acme kits", date: "2026-10-14" },
  ];

  it("names the scheduled topics after the first article, by date, then the held ones, up to three", () => {
    expect(nextArticles(planned, ["acme kit care", "acme vs rivals"], "acme kits")).toEqual(["best acme kits", "acme kit sizes", "acme kit care"]);
  });

  it("never names the first article's search or a search twice", () => {
    expect(nextArticles([{ term: "Acme Kits ", date: "2026-10-12" }], ["acme kits", "acme kit care", "Acme kit care"], "acme kits")).toEqual(["acme kit care"]);
  });

  it("makes nothing up: fewer saved topics, fewer names", () => {
    expect(nextArticles([], null, "acme kits")).toEqual([]);
    expect(nextArticles([], ["acme kit care"], null)).toEqual(["acme kit care"]);
  });
});
