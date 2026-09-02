import { describe, expect, it } from "vitest";
import { PLATFORM_CONNECT_TYPE, PLATFORM_LABEL, platformState } from "../detect";

describe("platformState", () => {
  it("is unchecked when the analysis has never run", () => {
    expect(platformState({ detected_platform: null, detected_platform_at: null })).toEqual({ state: "unchecked" });
  });

  it("is checked when the analysis ran and matched nothing", () => {
    // The state that used to be indistinguishable from unchecked: a
    // hand-built site, fetched, with no CMS we can post to.
    expect(platformState({ detected_platform: null, detected_platform_at: "2026-09-02T13:23:50Z" })).toEqual({
      state: "checked",
      checkedAt: "2026-09-02T13:23:50Z",
    });
  });

  it("is matched when a platform was recognised", () => {
    expect(platformState({ detected_platform: "webflow", detected_platform_at: "2026-09-02T13:23:50Z" })).toEqual({
      state: "matched",
      platform: "webflow",
      checkedAt: "2026-09-02T13:23:50Z",
    });
  });

  it("does not trust an unknown platform value", () => {
    // A stored value the current rule set does not know is not a match the
    // editor can act on; treat the run as checked-nothing.
    expect(platformState({ detected_platform: "drupal", detected_platform_at: "2026-09-02T13:23:50Z" }).state).toBe("checked");
  });
});

describe("PLATFORM_CONNECT_TYPE", () => {
  it("has an answer for every platform the detector can return", () => {
    for (const platform of Object.keys(PLATFORM_LABEL)) {
      expect(platform in PLATFORM_CONNECT_TYPE).toBe(true);
    }
  });

  it("sends repository-built sites to the git tab and Squarespace nowhere", () => {
    expect(PLATFORM_CONNECT_TYPE.nextjs).toBe("git");
    expect(PLATFORM_CONNECT_TYPE.astro).toBe("git");
    expect(PLATFORM_CONNECT_TYPE.squarespace).toBeNull();
    expect(PLATFORM_CONNECT_TYPE.wordpress).toBe("wordpress");
  });
});
