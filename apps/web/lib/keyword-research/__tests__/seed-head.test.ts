import { describe, it, expect } from "vitest";
import { resolveSeedHead } from "../category";

/**
 * qasimcode.com, priced live 2026-09-10. The description's biggest phrase,
 * "online booking", composes with every audience into a seed nobody searches;
 * the old head "website" composes into seeds people do. Only pricing the
 * pair can tell, so the head is chosen by its composed seeds.
 */
const QASIM = {
  description: "Qasimcode builds appointment-based websites for clinics, salons and studios, with online booking wired to existing calendars. Fixed price agreed upfront.",
  audiences: ["Speech therapy practices", "Medical and dental clinics", "Salon and beauty studios"],
  competitors: ["wix.com"],
};
const PROFILE = { topTerms: ["qasimcode", "websites", "studios", "clinics", "salons", "appointment", "booking"] };
const PRICES = new Map<string, { volume: number | null }>([
  ["therapy practice website", { volume: 10 }],
  ["dental clinic website", { volume: 30 }],
  ["beauty studio website", { volume: 10 }],
  ["therapy practice online booking", { volume: null }],
  ["dental clinic online booking", { volume: null }],
  ["beauty studio online booking", { volume: null }],
]);

describe("resolveSeedHead", () => {
  it("chooses the head whose composed seeds people search, not the phrase with the most volume alone", async () => {
    let priced: string[] = [];
    const r = await resolveSeedHead(QASIM, PROFILE, "qasimcode.com", { price: async (t) => { priced = t; return PRICES; } });
    expect(r.head).toBe("website");
    expect(r.priced).toBe(true);
    expect(r.seedVolume).toBe(50);
    expect(priced).toContain("dental clinic online booking"); // it did consider the loser
  });

  it("prices every head's seeds in one call", async () => {
    let calls = 0;
    await resolveSeedHead(QASIM, PROFILE, "qasimcode.com", { price: async () => { calls += 1; return PRICES; } });
    expect(calls).toBe(1);
  });

  it("falls back to the old head when nothing composes into volume", async () => {
    const r = await resolveSeedHead(QASIM, PROFILE, "qasimcode.com", { price: async () => new Map() });
    expect(r.head).toBe("website");
    expect(r.priced).toBe(false);
  });

  it("falls back the same way when the provider is down", async () => {
    const r = await resolveSeedHead(QASIM, PROFILE, "qasimcode.com", { price: async () => { throw new Error("down"); } });
    expect(r.head).toBe("website");
    expect(r.priced).toBe(false);
  });

  it("does nothing without audiences: there is nothing to compose", async () => {
    const r = await resolveSeedHead({ ...QASIM, audiences: [] }, PROFILE, "qasimcode.com", { price: async () => PRICES });
    expect(r.head).toBeNull();
  });

  it("reports what it tried, best first", async () => {
    const r = await resolveSeedHead(QASIM, PROFILE, "qasimcode.com", { price: async () => PRICES });
    expect(r.tried[0]).toEqual({ head: "website", seedVolume: 50 });
    expect(r.tried.some((t) => t.head === "online booking" && t.seedVolume === 0)).toBe(true);
  });
});
