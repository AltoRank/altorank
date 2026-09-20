import { describe, expect, it } from "vitest";
import { contextKey } from "../opportunity";

describe("contextKey", () => {
  const base = { domain: "fitsuite.co", languageCode: "it", locationCode: 2380, business: { description: "Coaching software", offerings: ["crm"] } };
  it("does not change when the kept search rivals are written, so saved verdicts survive", () => {
    expect(contextKey({ ...base, business: { ...base.business, searchRivals: ["revoo-app.com"] } })).toBe(contextKey(base));
  });
  it("still changes when the business itself changes", () => {
    expect(contextKey({ ...base, business: { ...base.business, offerings: ["crm", "nutrition"] } })).not.toBe(contextKey(base));
  });
});
