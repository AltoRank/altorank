import { afterEach, describe, expect, it, vi } from "vitest";
import { hasModelCredentials, modelHint, modelUnavailableNote, providerHint, providerUnavailableNote, PROVIDER_UNAVAILABLE } from "../availability";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("research availability copy", () => {
  it("never names a server variable outside development", () => {
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(providerHint()).toBeNull();
      expect(modelHint()).toBeNull();
      expect(providerUnavailableNote()).toBe(PROVIDER_UNAVAILABLE);
      expect(modelUnavailableNote("Chat", "The other tabs work without it.")).toBe("Chat isn't available yet. The other tabs work without it.");
      expect(`${providerUnavailableNote()} ${modelUnavailableNote("Chat")}`).not.toMatch(/API_KEY|DATAFORSEO|ANTHROPIC|server/);
    }
  });
  it("appends the variable name in development, where the reader can act on it", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(providerUnavailableNote()).toMatch(/^Keyword volumes aren't available on this account yet\. Set DATAFORSEO_API_KEY/);
    expect(modelUnavailableNote("Audience research")).toMatch(/^Audience research isn't available yet\. Set ANTHROPIC_API_KEY/);
  });
  it("reads the model credential from the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(hasModelCredentials()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(hasModelCredentials()).toBe(true);
  });
});
