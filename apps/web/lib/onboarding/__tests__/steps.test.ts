import { describe, it, expect } from "vitest";
import { SITE_STEPS, stepFromParam, stepIndex } from "../steps";

describe("stepFromParam", () => {
  it("is 1-based in the address bar and 0-based in the wizard", () => {
    expect(stepFromParam("1", 6)).toBe(0);
    expect(stepFromParam("5", 6)).toBe(stepIndex("Integration"));
  });

  it("clamps to the screens that exist, so a hand-edited URL cannot render a blank wizard", () => {
    expect(stepFromParam("99", 6)).toBe(5);
    expect(stepFromParam("0", 6)).toBe(0);
    expect(stepFromParam("-3", 6)).toBe(0);
  });

  it("treats absent or unparseable as the first screen", () => {
    expect(stepFromParam(null, 6)).toBe(0);
    expect(stepFromParam(undefined, 6)).toBe(0);
    expect(stepFromParam("", 6)).toBe(0);
    expect(stepFromParam("two", 6)).toBe(0);
    expect(stepFromParam("2.5", 6)).toBe(0);
  });

  it("the follow-up email's link lands on the CMS step", () => {
    expect(SITE_STEPS[stepFromParam("5", SITE_STEPS.length + 1)]).toBe("Integration");
  });
});
