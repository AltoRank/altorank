/**
 * The pre-trial draft preview is gone. A real signup (2026-09-22) copied the
 * whole first draft off it and published it on their own site within the
 * hour. The route stays only as a redirect, for links still open in a tab,
 * and it must not read an article on the way.
 */
import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to), notFound: vi.fn() }));
const createClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

describe("/onboarding/draft/[id]", () => {
  it("redirects to the setup screen without reading anything", async () => {
    const { default: Page } = await import("../draft/[id]/page");
    expect(() => Page()).toThrow("NEXT_REDIRECT:/onboarding");
    expect(createClient).not.toHaveBeenCalled();
  });
});
