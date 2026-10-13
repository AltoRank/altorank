// The network guard is the actual boundary between a test and a database that
// is not on this machine (lib/__tests__/support/network-guard.ts). Two things
// are pinned here: the policy, as a pure function, and the patch itself, live,
// in this process, where unit-setup.ts installed it in "own-servers" mode
// before this file loaded.
//
// Every refused host below ends in `.invalid`, a name that never resolves, so
// that even a broken guard cannot send these probes anywhere. Each live test
// drains the refusals it caused on purpose; anything left over would fail this
// file in the setup's afterAll, which is the point of the guard.

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoRefusals, drainRefusals, refusalReason } from "./support/network-guard";

const NONE: ReadonlySet<number> = new Set();

describe("refusalReason", () => {
  describe('"loopback" (the db tier)', () => {
    it.each([
      ["abc.supabase.co", 443],
      ["db.abcdefghijklmnop.supabase.co", 5432],
      ["api.anthropic.com", 443],
      ["127.0.0.1.nip.io", 54331],
      ["localhost.abc.supabase.co", 443],
    ])("refuses %s:%s", (host, port) => {
      expect(refusalReason("loopback", host, port, NONE)).toMatch(/is not on this machine/);
    });

    it.each([
      ["127.0.0.1", 57331],
      ["localhost", 54321],
      ["::1", 5432],
      ["[::1]", 5432],
    ])("lets %s:%s through", (host, port) => {
      expect(refusalReason("loopback", host, port, NONE)).toBeNull();
    });
  });

  describe('"own-servers" (the unit tier)', () => {
    it("refuses the local Supabase: a unit test that needs it is a db test with the wrong name", () => {
      expect(refusalReason("own-servers", "127.0.0.1", 57331, NONE)).toMatch(/\*\.db\.test\.ts/);
    });

    it("lets a test reach a server it started itself", () => {
      expect(refusalReason("own-servers", "127.0.0.1", 40123, new Set([40123]))).toBeNull();
    });

    it("still refuses a host that is not on this machine, whatever port it uses", () => {
      expect(refusalReason("own-servers", "db.example.invalid", 40123, new Set([40123]))).toMatch(
        /not on this machine/,
      );
    });
  });
});

describe("the guard installed for this file", () => {
  afterEach(() => {
    // Nothing a test here refuses on purpose may reach the file's afterAll.
    drainRefusals();
  });

  it("rejects a fetch to a host that is not on this machine, and records it", async () => {
    await expect(fetch("https://db.example.invalid/rest/v1/accounts")).rejects.toMatchObject({
      code: "ERR_TEST_NETWORK_GUARD",
    });
    expect(drainRefusals()).toEqual([expect.objectContaining({ via: "fetch", host: "db.example.invalid", port: 443 })]);
  });

  // The shape the two old isolation suites had: a URL read from somewhere
  // other than the env guard, handed straight to createClient. supabase-js
  // looks fetch up when it sends, so the guard sees the request whoever built
  // the client, and the refusal is recorded even though supabase-js turns it
  // into an `error` field instead of a throw.
  it("stops a Supabase client built straight from a hosted URL", async () => {
    const client = createClient("https://project.example.invalid", "service-role-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // An insert, as recordEvent does; postgrest-js retries a failed read with
    // backoff, which would only make this test slow.
    const { error } = await client.from("system_events").insert({ source: "network-guard-test" });
    expect(error).not.toBeNull();
    expect(drainRefusals()).toEqual([expect.objectContaining({ via: "fetch", host: "project.example.invalid" })]);
  });

  // Below fetch: a Postgres driver, http.request or undici's own client all
  // open a socket, and a TLS socket is a net.Socket underneath.
  it.each([
    ["a TCP socket", () => net.connect({ host: "db.example.invalid", port: 5432 })],
    ["a TLS socket", () => tls.connect({ host: "db.example.invalid", port: 443 })],
    ["a TCP socket opened as (port, host)", () => net.connect(5432, "db.example.invalid")],
  ])("refuses %s to a host that is not on this machine", async (_label, open) => {
    const socket = open();
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => socket.once("error", resolve));
    expect(err.code).toBe("ERR_TEST_NETWORK_GUARD");
    expect(drainRefusals()).toEqual([expect.objectContaining({ via: "socket", host: "db.example.invalid" })]);
  });

  it("lets a test talk to a server it started, and stops once that server is closed", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("ok");
    expect(drainRefusals()).toEqual([]);

    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "ERR_TEST_NETWORK_GUARD" });
    expect(drainRefusals()).toEqual([expect.objectContaining({ host: "127.0.0.1", port })]);
  });

  it("fails the file when a refusal was swallowed, naming the host", async () => {
    // What recordEvent and every fire-and-forget write do with a failure.
    await fetch("https://swallowed.example.invalid/rest/v1/system_events", { method: "POST" }).catch(() => {});
    expect(() => assertNoRefusals()).toThrow(/swallowed\.example\.invalid:443 via fetch/);
    // assertNoRefusals drained what it reported.
    expect(drainRefusals()).toEqual([]);
  });
});
