import { describe, it, expect } from "vitest";
import { authErrorMessage } from "../errors";

describe("authErrorMessage", () => {
  it("explains a transport failure instead of showing 'fetch failed'", () => {
    // Reported from a real sign-up while the Supabase container was stopped.
    // The raw string reads as a bug in the form, so the user tries a different
    // email, which can never help.
    const msg = authErrorMessage("fetch failed");
    expect(msg).not.toBe("fetch failed");
    expect(msg).toContain("Cannot reach the authentication service");
    expect(msg).toContain("Supabase is started");
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:54321",
    "getaddrinfo ENOTFOUND db.example.supabase.co",
    "socket hang up",
    "ETIMEDOUT",
  ])("treats %s as unreachable", (raw) => {
    expect(authErrorMessage(raw)).toContain("Cannot reach the authentication service");
  });

  it("passes through Supabase's own user-facing messages unchanged", () => {
    expect(authErrorMessage("Invalid login credentials")).toBe("Invalid login credentials");
    expect(authErrorMessage("User already registered")).toBe("User already registered");
  });

  it("falls back to something actionable when there is no message", () => {
    expect(authErrorMessage("")).toContain("Something went wrong");
    expect(authErrorMessage(undefined)).toContain("Something went wrong");
    expect(authErrorMessage(null)).toContain("Something went wrong");
  });

  it("matches case-insensitively", () => {
    expect(authErrorMessage("Fetch Failed")).toContain("Cannot reach");
  });
});
