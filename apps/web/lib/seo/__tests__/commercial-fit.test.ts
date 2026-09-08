import { describe, it, expect } from "vitest";
import { commercialFit } from "../commercial-fit";

// qasimcode.com: builds appointment websites for clinics and salons, at a
// fixed price, with ongoing monthly care.
const SUBJECT = new Set([
  "appointment", "websites", "website", "booking", "clinics", "salons",
  "studios", "trades", "calendars", "business",
]);
const PAID = "Builds appointment-based websites for clinics, salons, studios and trades. Fixed price agreed upfront, with ongoing monthly care.";
const FREE_PRODUCT = "An open-source page builder anyone can self-host. No accounts, no billing.";

describe("commercialFit — the query is about not buying", () => {
  it("refuses the article we actually wrote: running a business without websites", () => {
    const v = commercialFit("business without websites", SUBJECT, PAID);
    expect(v.fit).toBe("absence");
    expect(v.fit === "absence" && v.reason).toContain("decided not to buy");
  });

  it("catches the other phrasings of the same idea", () => {
    for (const t of ["no website business", "instead of a website", "avoid websites", "running a salon without a website"]) {
      expect(commercialFit(t, SUBJECT, PAID).fit, t).toBe("absence");
    }
  });

  it("needs both halves: an absence word alone is not misalignment", () => {
    // A perfectly good article for this business.
    expect(commercialFit("booking without double bookings", SUBJECT, PAID).fit).toBe("ok");
    expect(commercialFit("holidays without stress", SUBJECT, PAID).fit).toBe("ok");
  });
});

describe("commercialFit — the query wants it without paying", () => {
  it("penalises free and DIY when the business charges", () => {
    expect(commercialFit("free websites small business", SUBJECT, PAID).fit).toBe("substitute");
    expect(commercialFit("website builder diy", SUBJECT, PAID).fit).toBe("substitute");
  });

  it("leaves them alone when the product itself is free", () => {
    expect(commercialFit("free websites small business", SUBJECT, FREE_PRODUCT).fit).toBe("ok");
  });
});

describe("commercialFit — it never guesses", () => {
  it("says ok when the business is unknown", () => {
    expect(commercialFit("business without websites", null, null).fit).toBe("ok");
    expect(commercialFit("business without websites", new Set(), PAID).fit).toBe("ok");
  });

  it("leaves the terms this business should be writing", () => {
    for (const t of ["best dental clinic website", "salon appointment website", "dental clinic website design"]) {
      expect(commercialFit(t, SUBJECT, PAID).fit, t).toBe("ok");
    }
  });
});
