// The env half of the guard in front of every test that touches a database:
// the loader that decides which Supabase `npm run test:db` means in the main
// checkout (whose .env.local is the production project), and the check that
// refuses it before a suite creates and deletes users with the service role.
// The other half, the network guard, has its own file (network-guard.test.ts).
// Both are tested in the unit tier, where they run on every push with no
// database at all.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLocalEnv,
  assertLoopback,
  connectLocalStack,
  loadLocalEnv,
  LOCAL_STACK_VARS,
  localEnvFrom,
  localStackFrom,
} from "./support/local-db";

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

// The loader: which files, in which order, and which variables it will take
// from them. The main checkout's .env.local is production and also holds live
// provider keys, so both "a production URL there is refused" and "nothing but
// the three local-stack values is imported" matter.
describe("localEnvFrom", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "local-db-guard-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, lines: string[]) => writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);

  it("takes .env.development.local over .env.local, as next dev does", () => {
    write(".env.development.local", [
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331",
      "SUPABASE_SERVICE_ROLE_KEY=local-service",
    ]);
    write(".env.local", [
      "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
      "SUPABASE_SERVICE_ROLE_KEY=prod-service",
    ]);
    expect(localEnvFrom(dir, {})).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54331",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "local-service",
    });
  });

  it("imports none of the provider keys or other secrets sitting beside them", () => {
    write(".env.development.local", [
      "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
      "SUPABASE_SERVICE_ROLE_KEY=service",
    ]);
    write(".env.local", [
      "RESEND_API_KEY=re_FAKE_LIVE",
      "STRIPE_SECRET_KEY=sk_live_FAKE",
      "ANTHROPIC_API_KEY=sk-ant-FAKE",
      "DATAFORSEO_PASSWORD=FAKE",
      "DATABASE_URL=postgres://postgres:pw@db.abc.supabase.co:5432/postgres",
      "NEXT_PUBLIC_APP_URL=https://app.example.com",
    ]);
    const env = localEnvFrom(dir, {});
    expect(Object.keys(env).sort()).toEqual([...LOCAL_STACK_VARS].sort());
    expect(JSON.stringify(env)).not.toMatch(/FAKE|abc\.supabase\.co|example\.com/);
  });

  it("finds a production URL in .env.local when nothing overrides it, and the guard refuses it", () => {
    write(".env.local", [
      "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=anon",
      "SUPABASE_SERVICE_ROLE_KEY=service",
    ]);
    expect(() => localStackFrom(localEnvFrom(dir, {}))).toThrow(/NEXT_PUBLIC_SUPABASE_URL points at abc\.supabase\.co/);
  });

  it("lets a value already in the environment win over every file", () => {
    write(".env.development.local", ["NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331"]);
    expect(localEnvFrom(dir, { NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" }).NEXT_PUBLIC_SUPABASE_URL).toBe(
      "https://abc.supabase.co",
    );
  });

  it("reads nothing next dev would not: .env.test* is ignored", () => {
    write(".env.test.local", ["NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1"]);
    expect(localEnvFrom(dir, {}).NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
  });
});

describe("loadLocalEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds nothing to process.env but the local-stack values, whatever apps/web's env files hold", () => {
    for (const name of LOCAL_STACK_VARS) vi.stubEnv(name, undefined);
    const before = new Set(Object.keys(process.env));
    loadLocalEnv();
    const added = Object.keys(process.env).filter((name) => !before.has(name));
    expect(added.filter((name) => !(LOCAL_STACK_VARS as readonly string[]).includes(name))).toEqual([]);
  });
});

// End to end through connectLocalStack: the refusal comes before the health
// check, so a production URL never receives even that one request.
describe("connectLocalStack", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses a production URL before making any request", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(connectLocalStack()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL points at abc\.supabase\.co/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
