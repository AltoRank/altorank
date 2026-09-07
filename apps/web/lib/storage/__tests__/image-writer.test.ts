import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const service = { tag: "service" };
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => service }));

import { imageWriter } from "../images";

const env = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54331";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
});
afterEach(() => {
  process.env = { ...env };
});

describe("imageWriter", () => {
  it("writes with the service role when the environment has it", () => {
    // The article-images bucket has no insert policy for a session: the
    // caller's client (Write now, the modal, the agent API) was refused.
    const caller = { tag: "session" } as never;
    expect(imageWriter(caller)).toBe(service);
  });

  it("falls back to the caller's client on an install without the key", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const caller = { tag: "session" } as never;
    expect(imageWriter(caller)).toBe(caller);
  });
});
