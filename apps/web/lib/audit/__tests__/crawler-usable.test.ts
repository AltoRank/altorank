import { describe, it, expect } from "vitest";
import { usablePages, describeFetchError } from "../crawler";
import { profileIsUsable } from "@/lib/seo/topical-profile";

describe("usablePages", () => {
  it("drops failed fetches and error statuses", () => {
    const pages = [{ status: 0 }, { status: 200 }, { status: 301 }, { status: 403 }, { status: 500 }];
    expect(usablePages(pages).map((p: { status: number }) => p.status)).toEqual([200, 301]);
  });
});

describe("describeFetchError", () => {
  it("names a broken TLS chain and a timeout", () => {
    expect(describeFetchError({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } })).toContain("TLS certificate");
    expect(describeFetchError({ name: "AbortError" })).toContain("timed out");
    expect(describeFetchError({ cause: { code: "ENOTFOUND" } })).toBe("host not found");
  });
});

describe("profileIsUsable", () => {
  it("rejects a profile that is only the domain's own tokens", () => {
    expect(profileIsUsable({ terms: { www: 3 } } as never, "www.lully.ai")).toBe(false);
    expect(profileIsUsable({ terms: { lully: 3, www: 3 } } as never, "www.lully.ai")).toBe(false);
    expect(profileIsUsable(null)).toBe(false);
  });
  it("accepts a profile with real vocabulary", () => {
    expect(profileIsUsable({ terms: { warehouse: 4, orchestration: 3, automation: 2, lully: 3 } } as never, "www.lully.ai")).toBe(true);
  });
});
