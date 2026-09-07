import { describe, it, expect, afterEach, vi } from "vitest";

/** The module memoises its one warning, so each case needs a fresh import. */
async function fresh() {
  vi.resetModules();
  return import("../app-url");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appUrl", () => {
  it("uses the configured value, without a trailing slash", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.altorank.co/");
    const { appUrl, appLink } = await fresh();
    expect(appUrl()).toBe("https://app.altorank.co");
    expect(appLink("/content/abc")).toBe("https://app.altorank.co/content/abc");
  });

  /**
   * The defect this exists for: unset on Vercel, every mailed link silently
   * became http://localhost:3100/... - a link that looks fine in the inbox and
   * cannot possibly work. A send that fails loudly is recoverable; a wrong
   * link is not.
   */
  it("throws in production when it is not set", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const { appUrl } = await fresh();
    expect(() => appUrl()).toThrow(/NEXT_PUBLIC_APP_URL is not set/);
  });

  it("falls back to the dev port outside production, once, with a warning", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { appUrl } = await fresh();
    expect(appUrl()).toBe("http://localhost:3100");
    expect(appUrl()).toBe("http://localhost:3100");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ignores a whitespace-only value the same as an unset one", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "   ");
    vi.stubEnv("NODE_ENV", "production");
    const { appUrl } = await fresh();
    expect(() => appUrl()).toThrow();
  });
});
