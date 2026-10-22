import { describe, it, expect, vi, beforeEach } from "vitest";

const regen = vi.fn();
vi.mock("next/server", async () => {
  const real = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...real, after: (fn: () => Promise<void>) => void fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: async () => true }));
vi.mock("@/lib/content/regenerate-draft", () => ({ regenerateDraft: (...a: unknown[]) => regen(...a) }));
vi.mock("@/lib/auth/operators", () => ({ isAdminEmail: (e: string) => e === "ops@example.com" }));

import { POST } from "../route";

const req = (body: unknown, secret = "s3cret") =>
  new Request("https://app.example/api/internal/regenerate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": secret },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  regen.mockReset();
  process.env.CRON_SECRET = "s3cret";
});

describe("POST /api/internal/regenerate", () => {
  it("refuses without the cron secret", async () => {
    expect((await POST(req({ articleId: "a1", operatorEmail: "ops@example.com" }, "wrong"))).status).toBe(401);
    expect(regen).not.toHaveBeenCalled();
  });

  it("refuses an email that is not an operator's", async () => {
    expect((await POST(req({ articleId: "a1", operatorEmail: "someone@example.com" }))).status).toBe(403);
    expect(regen).not.toHaveBeenCalled();
  });

  it("accepts, and regenerates as the operator", async () => {
    const res = await POST(req({ articleId: "a1", operatorEmail: "ops@example.com" }));
    expect(res.status).toBe(202);
    expect(regen).toHaveBeenCalledWith(expect.anything(), "a1", "ops@example.com");
  });
});
