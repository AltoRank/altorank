import { describe, expect, it } from "vitest";
import { accountNameFromDomain } from "@/lib/domain/account-name";

describe("accountNameFromDomain", () => {
  it("takes the label before the suffix", () => {
    expect(accountNameFromDomain("qasimcode.com")).toBe("Qasimcode");
    expect(accountNameFromDomain("packiyo.com")).toBe("Packiyo");
  });

  it("treats hyphens as the word breaks they are in a domain", () => {
    expect(accountNameFromDomain("my-shop.de")).toBe("My Shop");
    expect(accountNameFromDomain("the_good_bakery.it")).toBe("The Good Bakery");
  });

  it("keeps the name out of a multi-part suffix", () => {
    expect(accountNameFromDomain("my-shop.co.uk")).toBe("My Shop");
    expect(accountNameFromDomain("brand.com.au")).toBe("Brand");
  });

  it("ignores scheme, www and anything after the host", () => {
    expect(accountNameFromDomain("https://www.acme.com/pricing?x=1")).toBe("Acme");
    expect(accountNameFromDomain("  ACME.com  ")).toBe("Acme");
  });

  it("keeps subdomain owners recognisable", () => {
    expect(accountNameFromDomain("shop.acme.com")).toBe("Acme");
  });

  it("gives back something rather than nothing for junk", () => {
    expect(accountNameFromDomain("")).toBe("");
    expect(accountNameFromDomain("localhost")).toBe("Localhost");
  });
});
