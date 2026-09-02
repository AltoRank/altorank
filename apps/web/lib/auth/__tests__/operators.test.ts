import { afterEach, describe, expect, it, vi } from "vitest";

// The list is read once at import, so each case gets a fresh module.
async function load(env: string | undefined) {
  vi.resetModules();
  if (env === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = env;
  return import("../operators");
}

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
});

describe("operators", () => {
  it("defaults to the AltoRank address when ADMIN_EMAILS is unset", async () => {
    const { ADMIN_EMAILS, isAdminEmail } = await load(undefined);
    expect(ADMIN_EMAILS).toEqual(["helloaltorank@gmail.com"]);
    expect(isAdminEmail("helloaltorank@gmail.com")).toBe(true);
    expect(isAdminEmail("HelloAltoRank@Gmail.com ")).toBe(true);
    expect(isAdminEmail("someone@example.com")).toBe(false);
  });

  it("is nobody when ADMIN_EMAILS is set but empty", async () => {
    // A self-hoster who does not want operator pages gets exactly that; the
    // default address is not an operator on somebody else's install.
    const { ADMIN_EMAILS, isAdminEmail } = await load("");
    expect(ADMIN_EMAILS).toEqual([]);
    expect(isAdminEmail("helloaltorank@gmail.com")).toBe(false);
  });

  it("takes a comma-separated list, trimmed and lower-cased", async () => {
    const { ADMIN_EMAILS, isAdminEmail } = await load(" Ops@Example.com, second@example.com ,, ");
    expect(ADMIN_EMAILS).toEqual(["ops@example.com", "second@example.com"]);
    expect(isAdminEmail("ops@example.com")).toBe(true);
    expect(isAdminEmail("helloaltorank@gmail.com")).toBe(false);
  });

  it("never treats a missing address as an operator", async () => {
    const { isAdminEmail } = await load(undefined);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});
