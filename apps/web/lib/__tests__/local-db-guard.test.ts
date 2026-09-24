// The guard in front of every test that touches a database. It is the only
// thing standing between `npm run test:db` in the main checkout (whose
// .env.local is the production project) and a suite that creates and deletes
// users with the service role, so it gets tested in the unit tier, where it
// runs on every push with no database at all.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnv } from "@next/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalEnv, assertLoopback, connectLocalStack, localStackFrom } from "./support/local-db";

const KEYS = { NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };

describe("assertLoopback", () => {
  it("refuses a production-shaped Supabase URL, naming the host", () => {
    expect(() => assertLoopback("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co")).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL points at abc\.supabase\.co.*refusing/,
    );
  });

  it.each([
    "http://127.0.0.1:54331",
    "http://localhost:54331",
    "http://[::1]:54331",
    "http://0.0.0.0:54331",
    "postgresql://postgres:postgres@127.0.0.1:54332/postgres",
  ])("lets %s through", (url) => {
    expect(assertLoopback("URL", url)).toBe(url);
  });

  // Hosts that read as local to a person skimming a log line and are not.
  it.each([
    "http://127.0.0.1.nip.io:54331",
    "http://localhost@abc.supabase.co",
    "https://localhost.abc.supabase.co",
    "postgres://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres",
  ])("refuses %s", (url) => {
    expect(() => assertLoopback("URL", url)).toThrow(/refusing/);
  });

  it("refuses something that is not a URL at all rather than guessing", () => {
    expect(() => assertLoopback("DATABASE_URL", "host=db.example.com dbname=postgres")).toThrow(/not a URL/);
  });
});

describe("assertLocalEnv", () => {
  it("refuses a production DATABASE_URL even when the Supabase URL is local", () => {
    expect(() =>
      assertLocalEnv({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54331",
        DATABASE_URL: "postgres://postgres:pw@db.abc.supabase.co:5432/postgres",
      }),
    ).toThrow(/DATABASE_URL points at db\.abc\.supabase\.co/);
  });

  it("is satisfied by an environment with no database in it", () => {
    expect(() => assertLocalEnv({})).not.toThrow();
  });
});

describe("localStackFrom", () => {
  it("returns the local stack when all three values are there", () => {
    expect(localStackFrom({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54331", ...KEYS })).toEqual({
      url: "http://127.0.0.1:54331",
      anon: "anon",
      service: "service",
    });
  });

  it("returns null (the suite may skip) when no stack is configured", () => {
    expect(localStackFrom({})).toBeNull();
    expect(localStackFrom({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54331" })).toBeNull();
  });

  it("throws, not skips, on a production URL even when the keys are missing", () => {
    expect(() => localStackFrom({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).toThrow(/abc\.supabase\.co/);
  });
});

// End to end through the loader: a production URL sitting in an env file, read
// under NODE_ENV=test (which vitest sets and which, left alone, would make
// @next/env skip .env.development.local and quietly find nothing).
describe("connectLocalStack", () => {
  let dir: string | undefined;

  afterEach(() => {
    resetEnv();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("refuses a production URL from .env.development.local before making any request", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "local-db-guard-"));
    writeFileSync(
      path.join(dir, ".env.development.local"),
      "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon\nSUPABASE_SERVICE_ROLE_KEY=service\n",
    );
    // Nothing already in the environment may win over the file.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(connectLocalStack(dir)).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL points at abc\.supabase\.co/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(process.env.NODE_ENV).toBe("test");
  });
});
