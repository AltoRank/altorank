// PostHog is optional. Without its two variables, `npm run dev` used to throw
// from instrumentation-client.ts and take down every page; it now warns once
// and leaves analytics off.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
vi.mock("posthog-js", () => ({ default: { init } }));

describe("instrumentation-client without PostHog", () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockClear();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_E2E_STUBS", "");
    // Whatever PostHog settings this shell has, the install under test has none.
    for (const name of Object.keys(process.env)) {
      if (name.includes("POSTHOG")) vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not throw in development, warns once, and does not start PostHog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(import("../../instrumentation-client")).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PostHog analytics are off");
    expect(init).not.toHaveBeenCalled();
  });

  it("stays quiet for the e2e runner", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_STUBS", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../../instrumentation-client");
    expect(warn).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });
});
