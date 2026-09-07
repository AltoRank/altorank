import { describe, expect, it } from "vitest";
import { clientIp } from "../client-ip";

const h = (init: Record<string, string>) => new Headers(init);

describe("clientIp", () => {
  it("takes the address our own edge wrote, not the one the client sent", () => {
    expect(clientIp(h({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.9");
  });

  it("ignores a forged prefix on the forwarded chain", () => {
    // The attacker writes "9.9.9.9"; the proxy appends the real address.
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-vercel-forwarded-for": "9.9.9.9, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to one shared bucket rather than to no limit at all", () => {
    expect(clientIp(h({}))).toBe("unknown");
    expect(clientIp(h({ "x-forwarded-for": " , " }))).toBe("unknown");
  });
});
