import { describe, it, expect } from "vitest";
import { matchGSCSite } from "../gsc";

const site = (siteUrl: string, permissionLevel = "siteOwner") => ({ siteUrl, permissionLevel });

describe("matchGSCSite", () => {
  it("prefers the domain property, then https, then www", () => {
    expect(matchGSCSite([site("https://altorank.co/"), site("sc-domain:altorank.co")], "www.altorank.co")!.siteUrl).toBe("sc-domain:altorank.co");
    expect(matchGSCSite([site("https://www.acme.com/"), site("https://acme.com/")], "acme.com")!.siteUrl).toBe("https://acme.com/");
  });
  it("ignores properties the account can only read metadata for", () => {
    expect(matchGSCSite([site("sc-domain:acme.com", "siteUnverifiedUser")], "acme.com")).toBeNull();
  });
  it("returns null when the account owns nothing for the domain", () => {
    expect(matchGSCSite([site("sc-domain:other.com")], "acme.com")).toBeNull();
  });
});
