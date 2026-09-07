import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The event log reads across every tenant with the service client, which is
 * the whole point of it and also the whole risk: RLS is not protecting this
 * page, the gate is. So the gate gets a test of its own.
 *
 * Three properties, and they are the same three the costs and users panes
 * rely on (lib/auth/admin.ts):
 *
 *   * a signed-out visitor gets 404, not a login prompt — an operator page
 *     should not advertise that it exists,
 *   * an ordinary customer gets 404 even though they are perfectly well
 *     authenticated,
 *   * an operator who is currently *viewing as a customer* gets 404 too,
 *     because `getOperator` returns null for the whole of that session. A
 *     preview that still rendered this page would be a lie in exactly the
 *     place somebody would check it.
 *
 * `getOperator` is stubbed rather than reimplemented: this asserts that the
 * page asks it and honours the answer, which is the part a future edit could
 * quietly break. What `getOperator` itself decides is covered by
 * lib/auth/__tests__/operators.test.ts.
 */

const { getOperator, notFound, createServiceClient } = vi.hoisted(() => ({
  getOperator: vi.fn(),
  notFound: vi.fn(() => {
    // Next's own `notFound` throws; the page's code after it must not run.
    throw new Error("NEXT_NOT_FOUND");
  }),
  createServiceClient: vi.fn(),
}));

vi.mock("@/lib/auth/admin", () => ({ getOperator }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient }));
// The page's presentation layer is not what is under test, and importing it
// would drag client components into a node environment for nothing.
vi.mock("@/components/ui", () => ({
  PageHead: () => null,
  Card: () => null,
  StatStrip: () => null,
  Chip: () => null,
}));
vi.mock("next/link", () => ({ default: () => null }));
vi.mock("../../admin-tabs", () => ({ AdminTabs: () => null }));
vi.mock("../../table", () => ({ Table: () => null }));

import AdminEventsPage from "../page";

/** A client that answers every query with an empty, error-free result. */
function emptyDb() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self,
    eq: self,
    in: self,
    gte: self,
    order: self,
    limit: self,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  });
  return { from: () => chain };
}

const searchParams = Promise.resolve({});

beforeEach(() => {
  getOperator.mockReset();
  notFound.mockClear();
  createServiceClient.mockReset().mockReturnValue(emptyDb());
});

describe("the event log is operator-only", () => {
  it("404s when nobody is signed in", async () => {
    getOperator.mockResolvedValue(null);
    await expect(AdminEventsPage({ searchParams })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("404s for a signed-in customer who is not an operator", async () => {
    // `getOperator` already applied the ADMIN_EMAILS rule and said no; the
    // page must not second-guess it or fall back to any other check.
    getOperator.mockResolvedValue(null);
    await expect(AdminEventsPage({ searchParams })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("never touches the database for a visitor it turned away", async () => {
    getOperator.mockResolvedValue(null);
    await expect(AdminEventsPage({ searchParams })).rejects.toThrow();
    // The gate is before the service client is even created, so a bug in the
    // query cannot leak cross-tenant rows to somebody who never got past it.
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it("renders for an operator", async () => {
    getOperator.mockResolvedValue({ id: "u1", email: "ops@example.com" });
    await expect(AdminEventsPage({ searchParams })).resolves.toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
    expect(createServiceClient).toHaveBeenCalled();
  });

  it("reads the log with the service client, which is the only thing that can", async () => {
    // system_events has RLS on with no policies (migration 082), so a page
    // that switched to the user's client would silently show an empty table
    // rather than fail — the exact failure this asserts against.
    getOperator.mockResolvedValue({ id: "u1", email: "ops@example.com" });
    const tables: string[] = [];
    createServiceClient.mockReturnValue({
      from: (t: string) => {
        tables.push(t);
        return emptyDb().from();
      },
    });
    await AdminEventsPage({ searchParams });
    expect(tables).toContain("system_events");
  });
});
