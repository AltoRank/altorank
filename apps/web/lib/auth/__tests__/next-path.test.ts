import { describe, expect, it } from "vitest";
import { safeNextPath } from "../next-path";

describe("safeNextPath", () => {
  it("keeps same-site paths and drops anything that could leave the site", () => {
    expect(safeNextPath("/oauth/authorize?client_id=a&state=b")).toBe("/oauth/authorize?client_id=a&state=b");
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("dashboard")).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("/" + "a".repeat(3000))).toBeNull();
  });
});
