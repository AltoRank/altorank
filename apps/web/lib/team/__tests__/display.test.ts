import { describe, it, expect } from "vitest";
import { memberDisplayName, memberInitials, UNKNOWN_MEMBER } from "../display";

const user = (email: string, meta: Record<string, unknown> = {}) => ({ email, raw_user_meta_data: meta });

describe("member display", () => {
  it("prefers a name from metadata, under either key", () => {
    expect(memberDisplayName(user("m@x.io", { full_name: "Mike Cecconello" }))).toBe("Mike Cecconello");
    expect(memberDisplayName(user("m@x.io", { name: "Mike" }))).toBe("Mike");
  });
  it("falls back to the email, never to a role word", () => {
    expect(memberDisplayName(user("mike@acmeventures.example"))).toBe("mike@acmeventures.example");
    expect(memberDisplayName(user("mike@acmeventures.example", { full_name: "  " }))).toBe("mike@acmeventures.example");
  });
  it("says so when the user could not be resolved", () => {
    expect(memberDisplayName(null)).toBe(UNKNOWN_MEMBER);
    expect(memberInitials(null)).toBe("?");
  });
  it("makes initials from a name or an email's local part", () => {
    expect(memberInitials(user("m@x.io", { full_name: "Mike Cecconello" }))).toBe("MC");
    expect(memberInitials(user("mike@acmeventures.example"))).toBe("MI");
    expect(memberInitials(user("jane.doe@x.io"))).toBe("JD");
  });
});
