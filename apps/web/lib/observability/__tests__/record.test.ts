import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The recorder's whole value is that it is safe to call from an error branch.
 * If it can throw, every call site has to wrap it, and a call site that
 * forgets turns one broken publish into a broken cron run.
 *
 * So the tests here are almost all about what it refuses to do: throw, leak a
 * credential, write a byte Postgres will reject, or grow without a bound.
 */

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient }));

import { recordEvent } from "../record";
import {
  buildEventRow,
  redactSecrets,
  sanitizeContext,
  stripControlBytes,
  MAX_MESSAGE,
  MAX_CONTEXT_BYTES,
} from "../event";

/** A client that captures the row, or fails in whichever way the test wants. */
function db(behaviour: "ok" | "error" | "throws" | "no-table" = "ok") {
  const rows: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (behaviour === "no-table") return {} as never;
      return {
        insert: async (row: Record<string, unknown>) => {
          if (behaviour === "throws") throw new Error("connection refused");
          if (behaviour === "error") return { error: { message: `relation "${table}" does not exist` } };
          rows.push(row);
          return { error: null };
        },
      };
    },
  };
  return { client: client as never, rows };
}

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  createServiceClient.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordEvent never throws", () => {
  it("writes the row when the database is willing", async () => {
    const { client, rows } = db("ok");
    await expect(
      recordEvent({ level: "error", source: "cron.publish", message: "boom" }, client),
    ).resolves.toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: "error", source: "cron.publish", message: "boom" });
  });

  it("resolves false when the table is not there, rather than raising", async () => {
    // The realistic case: the code is deployed and migration 082 is not
    // applied yet. Every cron in the product runs through this path.
    const { client } = db("error");
    await expect(recordEvent({ level: "error", source: "cron.geo", message: "x" }, client)).resolves.toBe(
      false,
    );
    expect(String(logged[0]?.[0])).toContain("could not record the event");
  });

  it("resolves false when the insert itself throws", async () => {
    const { client } = db("throws");
    await expect(recordEvent({ level: "warn", source: "s", message: "m" }, client)).resolves.toBe(false);
  });

  it("resolves false when the client is not a client at all", async () => {
    const { client } = db("no-table");
    await expect(recordEvent({ level: "warn", source: "s", message: "m" }, client)).resolves.toBe(false);
  });

  it("resolves false when there is no client and none can be made", async () => {
    createServiceClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    await expect(recordEvent({ level: "error", source: "s", message: "m" })).resolves.toBe(false);
  });

  it("survives an argument that cannot be serialised", async () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const { client, rows } = db("ok");
    await expect(
      recordEvent({ level: "error", source: "s", message: "m", context: cyclic }, client),
    ).resolves.toBe(true);
    expect(rows[0].context).toBeTruthy();
  });

  it("survives a context value whose toJSON throws", async () => {
    const hostile = {
      bad: {
        toJSON() {
          throw new Error("no");
        },
      },
    };
    const { client } = db("ok");
    await expect(
      recordEvent({ level: "error", source: "s", message: "m", context: hostile }, client),
    ).resolves.toBe(true);
  });
});

describe("truncation", () => {
  it("caps the message and marks that it was cut", () => {
    const row = buildEventRow({ level: "error", source: "s", message: "x".repeat(MAX_MESSAGE + 500) });
    expect(String(row.message)).toHaveLength(MAX_MESSAGE);
    expect(String(row.message).endsWith("…")).toBe(true);
  });

  it("caps the source, which the column's own check constraint also does", () => {
    const row = buildEventRow({ level: "info", source: "s".repeat(400), message: "m" });
    expect(String(row.source).length).toBeLessThanOrEqual(120);
  });

  it("replaces an oversized context with a note rather than dropping the event", () => {
    const row = buildEventRow({
      level: "error",
      source: "s",
      message: "m",
      context: { blob: Array.from({ length: 200 }, () => "x".repeat(400)) },
    });
    expect(JSON.stringify(row.context).length).toBeLessThan(MAX_CONTEXT_BYTES);
    expect(JSON.stringify(row.context)).toContain("context omitted");
  });

  it("bounds an array and an object rather than walking all of it", () => {
    const long = sanitizeContext(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(long).toHaveLength(50);
    const wide = sanitizeContext(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])));
    expect(Object.keys(wide as object)).toHaveLength(50);
  });

  it("stops descending rather than following a deep or cyclic shape forever", () => {
    const deep = { a: { b: { c: { d: { e: "buried" } } } } };
    expect(JSON.stringify(sanitizeContext(deep))).toContain("[redacted]");
  });
});

describe("redaction", () => {
  it("removes this product's own API keys wherever they appear", () => {
    expect(redactSecrets("bad key altorank_live_9fA3xQ2p not recognised")).toBe(
      "bad key [redacted] not recognised",
    );
  });

  it("removes Stripe secret and webhook keys, and keeps the publishable one", () => {
    expect(redactSecrets("using sk_live_51ABCdefGHIjkl")).toContain("[redacted]");
    expect(redactSecrets("whsec_abc123DEF456ghi")).toBe("[redacted]");
    // pk_ is on every checkout page in plain sight; redacting it would only
    // make the log harder to read.
    expect(redactSecrets("pk_live_51ABCdefGHIjkl")).toBe("pk_live_51ABCdefGHIjkl");
  });

  it("removes a JWT, which is what a service key and a session token both are", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJyb2xlIjoic2VydmljZV9yb2xl.dBjftJeZ4CVPmB92K27u";
    expect(redactSecrets(`sent ${jwt} upstream`)).toBe("sent [redacted] upstream");
  });

  it("removes whatever followed an Authorization scheme", () => {
    expect(redactSecrets("header was Bearer abcdefghijklmnop.qrst")).toBe("header was [redacted]");
  });

  it("drops the value of any context key whose name looks like a credential", () => {
    const out = sanitizeContext({
      apiKey: "whatever",
      Authorization: "Bearer x",
      refresh_token: "y",
      password: "hunter2",
      // Not a credential, and the reason the agent API passes `label`.
      label: "Mike's laptop",
      status: 500,
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.Authorization).toBe("[redacted]");
    expect(out.refresh_token).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.label).toBe("Mike's laptop");
    expect(out.status).toBe(500);
  });

  it("redacts inside a nested object too", () => {
    const out = sanitizeContext({ request: { headers: { authorization: "Bearer abcdefghijklmnop" } } });
    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnop");
  });

  it("redacts a key that appears in the message, not only in the context", () => {
    const row = buildEventRow({
      level: "error",
      source: "agent.api",
      message: "key altorank_live_deadbeef01 was rejected",
    });
    expect(row.message).toBe("key [redacted] was rejected");
  });
});

describe("control bytes", () => {
  // Two files in this repo use raw NUL, \x01 and \x02 as string sentinels
  // (lib/ai/fact-check.ts, lib/keywords/yields.ts). Postgres `text` cannot
  // store U+0000 at all, so one of those reaching a message here would make
  // the insert fail - losing the record of a failure to protect a log.
  //
  // Every control byte below is written as an escape, never as the byte, so
  // this file stays text to git, grep and every editor.
  const NUL = "\u0000";

  it("strips the bytes Postgres will not accept", () => {
    const sentinel = `before${NUL}BLOCK${NUL}after`;
    expect(stripControlBytes(sentinel)).toBe("beforeBLOCKafter");
    expect(stripControlBytes(sentinel)).not.toContain(NUL);
  });

  it("strips the other C0 controls too", () => {
    expect(stripControlBytes("a\u0001b\u0002c\u001bd\u007f")).toBe("abcd");
  });

  it("folds a multi-line stack trace into one readable line", () => {
    expect(stripControlBytes("failed\n  at foo()\n  at bar()")).toBe("failed at foo() at bar()");
  });

  it("strips them out of context values and keys as well", () => {
    const out = sanitizeContext({ [`a${NUL}b`]: `x${NUL}y` }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["ab"]);
    expect(out.ab).toBe("xy");
  });

  it("strips them out of a message on its way to the row", () => {
    const row = buildEventRow({ level: "error", source: "s", message: `a${NUL}b` });
    expect(row.message).toBe("ab");
  });
});

describe("the row itself", () => {
  it("refuses a level it does not know rather than failing the check constraint", () => {
    const row = buildEventRow({ level: "critical" as never, source: "s", message: "m" });
    expect(row.level).toBe("info");
  });

  it("nulls an id that is not a UUID, because both columns are foreign keys", () => {
    const row = buildEventRow({
      level: "error",
      source: "s",
      message: "m",
      agencyId: "unknown",
      workspaceId: "",
    });
    expect(row.agency_id).toBeNull();
    expect(row.workspace_id).toBeNull();
  });

  it("keeps a real UUID", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const row = buildEventRow({ level: "error", source: "s", message: "m", agencyId: id });
    expect(row.agency_id).toBe(id);
  });

  it("says so rather than writing an empty message", () => {
    expect(buildEventRow({ level: "error", source: "s", message: "   " }).message).toBe("(no message)");
    expect(buildEventRow({ level: "error", source: "  ", message: "m" }).source).toBe("unknown");
  });
});
