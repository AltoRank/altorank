import { describe, expect, it } from "vitest";
import { normalizeCode } from "../pending-signup";

describe("normalizeCode", () => {
  it("keeps the digits of a code typed with spaces or pasted with a dash", () => {
    expect(normalizeCode("123 456")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
  });
  it("refuses anything too short or too long to be a Supabase code", () => {
    expect(normalizeCode("12345")).toBeNull();
    expect(normalizeCode("12345678901")).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
});
