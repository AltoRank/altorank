import { describe, it, expect } from "vitest";
import { corsHeaders, json } from "../http";
import { rateLimitHeaders } from "@/lib/tools/rate-limit";

// The marketing widgets call these routes from altorank.co, another origin.
// A browser hides every response header that is not CORS-safelisted unless
// Access-Control-Expose-Headers names it.
describe("growth-plan/http CORS", () => {
  it("exposes every rate-limit header the routes send, Retry-After included", () => {
    const exposed = corsHeaders("https://altorank.co")["Access-Control-Expose-Headers"].split(/,\s*/).map((h) => h.toLowerCase());
    const sent = Object.keys(rateLimitHeaders({ allowed: false, limit: 5, remaining: 0, resetAt: Date.now() + 60_000 }));
    expect(sent).toContain("Retry-After");
    for (const h of sent) expect(exposed, h).toContain(h.toLowerCase());
  });

  it("puts the exposed list on a real 429 response next to Retry-After", () => {
    const res = json({ ok: false }, 429, "https://www.altorank.co", { "Retry-After": "3000" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://www.altorank.co");
    expect(res.headers.get("Retry-After")).toBe("3000");
    expect(res.headers.get("Access-Control-Expose-Headers")).toMatch(/Retry-After/);
  });

  it("falls back to the marketing origin for an unknown caller", () => {
    expect(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"]).toBe("https://altorank.co");
  });
});
