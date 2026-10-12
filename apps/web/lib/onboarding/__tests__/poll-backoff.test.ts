import { describe, expect, it } from "vitest";
import { MAX_BACKOFF_MS, nextPollDelay, POLL_BACKOFF_AFTER_MS, POLL_MS, POLL_SLOW_MS, reconnecting, RECONNECTING_AFTER, pollRefusal, REFUSALS_TO_STOP } from "../poll-backoff";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A bad connection on the setup screen (UX audit 2026-10-12, #14): it
// backs off and says it is reconnecting, and it never ends the run.

describe("watching a run through a bad connection", () => {
  it("keeps the usual cadence while answers come back", () => {
    expect(nextPollDelay(0, 10_000)).toBe(POLL_MS);
    expect(nextPollDelay(0, POLL_BACKOFF_AFTER_MS + 1)).toBe(POLL_SLOW_MS);
  });

  it("doubles the wait after each miss, up to a ceiling, and keeps asking", () => {
    const waits = [1, 2, 3, 4, 5, 6, 10, 50].map((f) => nextPollDelay(f, 10_000));
    expect(waits.slice(0, 4)).toEqual([POLL_MS, POLL_MS * 2, POLL_MS * 4, POLL_MS * 8]);
    for (let i = 1; i < waits.length; i++) expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1]);
    expect(Math.max(...waits)).toBe(MAX_BACKOFF_MS);
    expect(Number.isFinite(nextPollDelay(1_000, 0))).toBe(true);
  });

  it("says it is reconnecting after a couple of misses, not after one", () => {
    expect(reconnecting(1)).toBe(false);
    expect(reconnecting(RECONNECTING_AFTER)).toBe(true);
  });

  it("the screen never turns a failed poll into the run's error", () => {
    // Read from the source: the poller is an effect, and this repo renders
    // components without a DOM. What matters is that nothing on the poll's
    // failure path writes the run's error state.
    const src = readFileSync(join(__dirname, "../../../components/onboarding/onboarding-progress.tsx"), "utf8");
    const poll = src.slice(src.indexOf("const poll = async"), src.indexOf("const start = async"));
    expect(poll).not.toContain("fail(");
    expect(poll).toContain("missed()");
    expect(src).not.toContain("POLL_LOST_ERROR");
    expect(src).toContain('addEventListener("visibilitychange"');
  });
});

describe("the server's own refusal", () => {
  it("is an answer, not a blip: signed out on 401, no access on 403 or 404, anything else is tried again", () => {
    expect(pollRefusal(401)).toBe("signed-out");
    expect(pollRefusal(403)).toBe("no-access");
    expect(pollRefusal(404)).toBe("no-access");
    for (const status of [400, 429, 500, 502, 503]) expect(pollRefusal(status)).toBeNull();
    // One may be a hiccup in the auth check; two in a row is the answer.
    expect(REFUSALS_TO_STOP).toBe(2);
  });
});
