import { describe, expect, it } from "vitest";
import { customerLastSeen, VIEW_SIGN_IN_WINDOW_MS } from "../last-seen";

// "View as" signs in as the customer, which stamps their last sign-in. The
// Users page shows the customer's own, from the view's log row.

const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs).toISOString();

describe("customerLastSeen", () => {
  it("keeps a sign-in no view made", () => {
    expect(customerLastSeen("2026-10-10T09:00:00.000Z", [{ startedAt: "2026-10-12T09:00:00.000Z", priorSignInAt: null }])).toEqual({
      at: "2026-10-10T09:00:00.000Z",
      unknown: false,
    });
  });

  it("shows the customer's own sign-in from before a view, not the view's", () => {
    const view = { startedAt: "2026-10-15T14:00:00.000Z", priorSignInAt: "2026-10-01T08:00:00.000Z" };
    expect(customerLastSeen(at(view.startedAt, 3_000), [view])).toEqual({ at: "2026-10-01T08:00:00.000Z", unknown: false });
  });

  it("walks back through several views in a row", () => {
    const first = { startedAt: "2026-10-14T10:00:00.000Z", priorSignInAt: "2026-09-30T08:00:00.000Z" };
    const second = { startedAt: "2026-10-15T10:00:00.000Z", priorSignInAt: at(first.startedAt, 2_000) };
    expect(customerLastSeen(at(second.startedAt, 1_000), [second, first])).toEqual({ at: "2026-09-30T08:00:00.000Z", unknown: false });
  });

  it("a customer who never signed in before the view has no last seen", () => {
    const view = { startedAt: "2026-10-15T14:00:00.000Z", priorSignInAt: null };
    expect(customerLastSeen(at(view.startedAt, 1_000), [view])).toEqual({ at: null, unknown: false });
  });

  it("says unknown for a view logged before the prior sign-in was kept", () => {
    const view = { startedAt: "2026-10-15T14:00:00.000Z" };
    expect(customerLastSeen(at(view.startedAt, 1_000), [view])).toEqual({ at: null, unknown: true });
  });

  it("does not take a sign-in long after a view for the view's", () => {
    const view = { startedAt: "2026-10-15T14:00:00.000Z", priorSignInAt: null };
    const later = at(view.startedAt, VIEW_SIGN_IN_WINDOW_MS + 60_000);
    expect(customerLastSeen(later, [view])).toEqual({ at: later, unknown: false });
  });

  it("handles no sign-in at all", () => {
    expect(customerLastSeen(null, [])).toEqual({ at: null, unknown: false });
  });
});
