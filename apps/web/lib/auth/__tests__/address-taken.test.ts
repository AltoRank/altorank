import { describe, expect, it } from "vitest";
import { AddressTakenError, isAddressTaken, isAddressTakenRefusal } from "../address-taken";

describe("isAddressTakenRefusal", () => {
  it("knows Supabase's refusal for a confirmed address, by code or by its sentence", () => {
    expect(isAddressTakenRefusal({ code: "email_exists", message: "A user with this email address has already been registered" })).toBe(true);
    expect(isAddressTakenRefusal({ code: "user_already_exists", message: "User already registered" })).toBe(true);
    expect(isAddressTakenRefusal({ message: "A user with this email address has already been registered" })).toBe(true);
  });

  it("is not any other refusal", () => {
    expect(isAddressTakenRefusal({ code: "over_email_send_rate_limit", message: "Email rate limit exceeded" })).toBe(false);
    expect(isAddressTakenRefusal({ message: "fetch failed" })).toBe(false);
    expect(isAddressTakenRefusal({})).toBe(false);
  });
});

describe("isAddressTaken", () => {
  it("is the error sendSignupConfirmation throws for a taken address, and no other", () => {
    expect(isAddressTaken(new AddressTakenError("A user with this email address has already been registered"))).toBe(true);
    expect(isAddressTaken(new Error("A user with this email address has already been registered"))).toBe(false);
    expect(isAddressTaken("taken")).toBe(false);
  });

  it("keeps Supabase's sentence as its message, for callers that read it", () => {
    expect(new AddressTakenError("A user with this email address has already been registered").message).toContain("already been registered");
  });
});
