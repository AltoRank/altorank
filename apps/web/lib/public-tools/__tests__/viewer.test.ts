import { describe, it, expect } from "vitest";
import { viewerFromUser } from "../viewer";

describe("viewerFromUser", () => {
  it("is null with no user, and for an anonymous session", () => {
    expect(viewerFromUser(null)).toBeNull();
    expect(viewerFromUser({ id: "u1", email_confirmed_at: "2026-09-28T00:00:00Z", is_anonymous: true })).toBeNull();
  });

  it("is verified once the email is confirmed", () => {
    expect(viewerFromUser({ id: "u1", email_confirmed_at: "2026-09-28T00:00:00Z" })).toEqual({ id: "u1", verified: true });
  });

  it("is signed in but unverified before that", () => {
    expect(viewerFromUser({ id: "u1", email_confirmed_at: undefined, identities: [{ provider: "email" }] })).toEqual({
      id: "u1",
      verified: false,
    });
  });

  it("counts an OAuth identity as verified", () => {
    expect(viewerFromUser({ id: "u1", email_confirmed_at: undefined, identities: [{ provider: "google" }] })).toEqual({
      id: "u1",
      verified: true,
    });
  });
});
