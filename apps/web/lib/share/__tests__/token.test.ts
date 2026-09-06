import { describe, expect, it, vi } from "vitest";
import { buildShareCard, type ShareCardFacts } from "../card";
import { generateShareToken, isShareToken, publicShareCard, resolveShareToken, shareUrl } from "../token";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

const WS = "11111111-1111-4111-8111-111111111111";
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("share tokens", () => {
  it("are 128 bits of lowercase hex and do not repeat", () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(isShareToken(a)).toBe(true);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });
  it("reject anything that is not a token before touching the database", async () => {
    for (const bad of [WS, "", "0123456789ABCDEF0123456789abcdef", TOKEN.slice(1), `${TOKEN}0`, null, 42, "'; drop table--"]) {
      expect(isShareToken(bad)).toBe(false);
    }
    const db = fakeSupabase({ workspaces: [{ id: WS, share_token: TOKEN }] });
    const from = vi.spyOn(db, "from");
    expect(await resolveShareToken(db as never, WS)).toBeNull();
    expect(await resolveShareToken(db as never, TOKEN.toUpperCase())).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
  it("resolve to the one workspace holding the token, and to nothing for an unknown or revoked one", async () => {
    const db = fakeSupabase({
      workspaces: [
        { id: WS, share_token: TOKEN },
        { id: "other", share_token: null },
      ],
    });
    expect(await resolveShareToken(db as never, TOKEN)).toBe(WS);
    expect(await resolveShareToken(db as never, "ffffffffffffffffffffffffffffffff")).toBeNull();
    db.tables.workspaces[0].share_token = null;
    expect(await resolveShareToken(db as never, TOKEN)).toBeNull();
  });
  it("build the link under /share", () => {
    expect(shareUrl("https://app.altorank.co/", TOKEN)).toBe(`https://app.altorank.co/share/${TOKEN}`);
  });
});

describe("publicShareCard", () => {
  const facts: ShareCardFacts = {
    domain: "acme.com",
    dr: null,
    published: 3,
    planned: 4,
    gscConnected: false,
    clicks28d: null,
    removeBranding: false,
  };
  it("exposes only what is drawn on the card: domain, the measured stats, the footer", () => {
    const pub = publicShareCard(buildShareCard(facts));
    expect(Object.keys(pub).sort()).toEqual(["domain", "footer", "stats"]);
    expect(pub.stats.every((s) => Object.keys(s).sort().join() === "label,value")).toBe(true);
  });
  it("carries no unmeasured figure and none of the reasons it was left off", () => {
    const pub = publicShareCard(buildShareCard(facts));
    const text = JSON.stringify(pub);
    expect(pub.stats.map((s) => s.label)).toEqual(["Articles published", "Articles planned"]);
    expect(text).not.toMatch(/authority/i);
    expect(text).not.toMatch(/not connected|not measured|nothing synced|omitted/i);
    expect(text).not.toMatch(/gsc|clicks/i);
  });
  it("keeps a measured zero, since a count of zero is a measurement", () => {
    const pub = publicShareCard(buildShareCard({ ...facts, gscConnected: true, clicks28d: 0, published: 0 }));
    expect(pub.stats.find((s) => s.label === "Search clicks, 28 days")?.value).toBe("0");
    expect(pub.stats.find((s) => s.label === "Articles published")?.value).toBe("0");
  });
});
