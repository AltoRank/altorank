import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The webhook's hand-off (lib/plan/resume-dispatch.ts): out of Stripe's
 * request and into /api/internal/resume-drafting, or inline where the install
 * cannot call itself. It never throws, and a hand-off that failed is written
 * down where an operator looks.
 */

const { events } = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: async (e: Record<string, unknown>) => (events.push(e), true) }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({ service: true }) }));

import { dispatchResume } from "../resume-dispatch";

const req = { accountId: "acc1", key: "sub_1", draftWeek: true };

beforeEach(() => {
  events.length = 0;
});

describe("dispatchResume", () => {
  it("posts the checkout to the resume route with the cron secret", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await dispatchResume(req, { baseUrl: "https://app.example/", secret: "cron-secret", fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://app.example/api/internal/resume-drafting");
    expect(init.headers["x-cron-secret"]).toBe("cron-secret");
    expect(JSON.parse(init.body)).toEqual(req);
    expect(events).toHaveLength(0);
  });

  it("runs the resume inline when the install cannot call itself", async () => {
    const resume = vi.fn(async () => ({ accountId: "acc1", sites: [], settled: Promise.resolve() }));
    await dispatchResume(req, { secret: null, baseUrl: "https://app.example", resume: resume as never, supabase: { fake: true } as never });
    expect(resume).toHaveBeenCalledWith({ fake: true }, "acc1", { key: "sub_1", draftWeek: true });
  });

  it("records a hand-off that failed, and does not throw", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(dispatchResume(req, { baseUrl: "https://app.example", secret: "cron-secret", fetchImpl: fetchImpl as never, supabase: {} as never })).resolves.toBeUndefined();
    expect(events[0]).toMatchObject({ level: "warn", source: "plan.resume", accountId: "acc1" });
    expect(String(events[0].message)).toContain("answered 500");

    const rejecting = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await dispatchResume(req, { baseUrl: "https://app.example", secret: "cron-secret", fetchImpl: rejecting as never, supabase: {} as never });
    expect(String(events[1].message)).toContain("connection reset");
  });
});
