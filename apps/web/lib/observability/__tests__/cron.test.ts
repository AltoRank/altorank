import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The wrapper's contract is that it changes nothing. It observes a cron run
 * and hands back the route's own response, byte for byte, whatever it had to
 * do to read it — because the alternative is that adding a log to eleven
 * scheduled routes is how the scheduled routes broke.
 */

const { recordEvent } = vi.hoisted(() => ({ recordEvent: vi.fn(async () => true) }));
vi.mock("../record", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../record")>()),
  recordEvent,
}));

import { observedCron } from "../cron";

const request = () => new Request("http://localhost/api/cron/publish");

type WrittenEvent = {
  level: string;
  source: string;
  message: string;
  context: Record<string, unknown>;
};

/** The one event the wrapper wrote. */
const written = (): WrittenEvent => (recordEvent.mock.calls as unknown as WrittenEvent[][])[0][0];

beforeEach(() => {
  recordEvent.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("what the wrapper records", () => {
  it("writes one info row for a clean run, with its counts", async () => {
    const handler = observedCron("cron.publish", async () =>
      Response.json({ success: true, published: 3, errors: 0, results: [{ status: "success" }] }),
    );
    await handler(request());
    expect(recordEvent).toHaveBeenCalledOnce();
    expect(written().level).toBe("info");
    expect(written().source).toBe("cron.publish");
    expect(written().context.published).toBe(3);
    // `results` is per-item detail and would be the whole run in one column.
    expect(written().context.results).toBeUndefined();
    expect(written().context.results_count).toBe(1);
  });

  it("writes a warning when items failed, and names a few of them", async () => {
    const handler = observedCron("cron.publish", async () =>
      Response.json({
        published: 1,
        errors: 2,
        results: [
          { status: "success" },
          { status: "error", workspaceId: "ws-1", error: "401 from WordPress" },
          { status: "error", workspaceId: "ws-2", error: "connection refused" },
        ],
      }),
    );
    await handler(request());
    expect(written().level).toBe("warn");
    expect(written().message).toContain("2 failed item(s)");
    expect(written().context.failures).toEqual([
      "ws-1: 401 from WordPress",
      "ws-2: connection refused",
    ]);
  });

  it("writes an error when the whole run failed", async () => {
    const handler = observedCron("cron.geo", async () =>
      Response.json({ error: "column does not exist" }, { status: 500 }),
    );
    await handler(request());
    expect(written().level).toBe("error");
    expect(written().message).toContain("column does not exist");
  });

  it("records a throw and lets it through unchanged", async () => {
    const boom = new Error("the pipeline exploded");
    const handler = observedCron("cron.analyze", async () => {
      throw boom;
    });
    await expect(handler(request())).rejects.toBe(boom);
    expect(written().level).toBe("error");
    expect(written().message).toContain("the pipeline exploded");
  });

  it("says nothing about a 401", async () => {
    // These URLs are public and get probed. A log full of that is a log
    // nobody reads, which is the problem this file exists to fix.
    const handler = observedCron("cron.publish", async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    await handler(request());
    expect(recordEvent).not.toHaveBeenCalled();
  });
});

describe("what the wrapper does not change", () => {
  it("returns the route's own response, with its body still readable", async () => {
    const original = Response.json({ success: true, published: 2 });
    const handler = observedCron("cron.publish", async () => original);
    const returned = await handler(request());
    expect(returned).toBe(original);
    // The wrapper read the body from a clone, so the caller's is untouched.
    await expect(returned.json()).resolves.toEqual({ success: true, published: 2 });
  });

  it("keeps the status and headers", async () => {
    const handler = observedCron("cron.reports", async () =>
      Response.json({ generated: 0 }, { status: 200, headers: { "X-Test": "kept" } }),
    );
    const returned = await handler(request());
    expect(returned.status).toBe(200);
    expect(returned.headers.get("X-Test")).toBe("kept");
  });

  it("survives a body that is not JSON", async () => {
    const handler = observedCron("cron.reports", async () => new Response("not json"));
    const returned = await handler(request());
    expect(returned.status).toBe(200);
    expect(written().level).toBe("info");
  });

  it("does not fail the run when recording itself fails", async () => {
    recordEvent.mockRejectedValueOnce(new Error("database is on fire"));
    const handler = observedCron("cron.publish", async () => Response.json({ published: 1 }));
    const returned = await handler(request());
    expect(returned.status).toBe(200);
  });
});
