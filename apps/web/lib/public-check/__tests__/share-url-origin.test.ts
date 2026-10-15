// Share links and the badge point at this install, not at the hosted app.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public check share URL", () => {
  it("uses NEXT_PUBLIC_APP_URL when it is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://seo.example.org/");
    vi.resetModules();
    const { shareUrlFor, APP_URL } = await import("../shape");
    expect(APP_URL).toBe("https://seo.example.org");
    expect(shareUrlFor("acme.example")).toBe("https://seo.example.org/check/acme.example");
  });

  it("falls back to the hosted app when it is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.resetModules();
    const { shareUrlFor } = await import("../shape");
    expect(shareUrlFor("acme.example")).toBe("https://app.altorank.co/check/acme.example");
  });
});
