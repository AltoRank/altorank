import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The search-data balance: read with one free call, and said to the
// operators while it is low. From 2026-11-10 it sat at zero for five days
// and the only trace was the sentence on the setup screen.

const { get, hasCredentials, recordEvent, notify } = vi.hoisted(() => ({
  get: vi.fn(),
  hasCredentials: vi.fn(() => true),
  recordEvent: vi.fn(async (..._a: unknown[]) => true),
  notify: vi.fn(async (..._a: unknown[]) => ({ sent: 1, skipped: 0, failed: 0 })),
}));
vi.mock("../client", () => ({ get: (...a: unknown[]) => get(...a), hasDataForSEOCredentials: () => hasCredentials() }));
vi.mock("@/lib/observability/record", () => ({ recordEvent: (...a: unknown[]) => recordEvent(...a) }));
vi.mock("@/lib/email/lifecycle", () => ({ notifyOperatorsProviderBalance: (...a: unknown[]) => notify(...a) }));

import { checkProviderBalance, dataforseoBalance, LOW_BALANCE_USD } from "../balance";

const answer = (balance: unknown) => ({ tasks: [{ result: [{ money: { total: 151, balance } }] }] });
const db = {} as never;

beforeEach(() => {
  get.mockReset();
  hasCredentials.mockReset().mockReturnValue(true);
  recordEvent.mockClear();
  notify.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("dataforseoBalance", () => {
  it("reads what is left, and says when it is low or gone", async () => {
    get.mockResolvedValue(answer(49.96));
    expect(await dataforseoBalance()).toEqual({ balance: 49.96, low: false, empty: false });
    get.mockResolvedValue(answer(LOW_BALANCE_USD - 0.01));
    expect(await dataforseoBalance()).toMatchObject({ low: true, empty: false });
    // What the account actually read on 2026-11-15: overdrawn by the last call.
    get.mockResolvedValue(answer(-0.0398));
    expect(await dataforseoBalance()).toMatchObject({ low: true, empty: true });
    expect(get).toHaveBeenCalledWith("/appendix/user_data");
  });

  it("is unknown, not empty, when it cannot be read", async () => {
    get.mockRejectedValue(new Error("timed out"));
    expect(await dataforseoBalance()).toBeNull();
    get.mockResolvedValue({ tasks: [{ result: null }] });
    expect(await dataforseoBalance()).toBeNull();
    hasCredentials.mockReturnValue(false);
    expect(await dataforseoBalance()).toBeNull();
  });
});

describe("checkProviderBalance", () => {
  it("says nothing while there is enough", async () => {
    expect(await checkProviderBalance(db, { balance: async () => ({ balance: 50, low: false, empty: false }) })).toMatchObject({ balance: 50 });
    expect(recordEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("warns the log and the operators when it is low", async () => {
    await checkProviderBalance(db, { balance: async () => ({ balance: 6.5, low: true, empty: false }) });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", source: "provider.balance", message: expect.stringContaining("$6.50") }), db);
    expect(notify).toHaveBeenCalledWith(db, { balance: 6.5, empty: false, threshold: LOW_BALANCE_USD }, undefined);
  });

  it("calls an empty balance an error, and hands it back for the retry to wait on", async () => {
    const found = await checkProviderBalance(db, { balance: async () => ({ balance: -0.04, low: true, empty: true }) });
    expect(found?.empty).toBe(true);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", message: expect.stringContaining("cannot plan") }), db);
  });

  it("never throws: an unknown balance, or an alert that failed, is not the caller's problem", async () => {
    expect(await checkProviderBalance(db, { balance: async () => { throw new Error("down"); } })).toBeNull();
    notify.mockRejectedValueOnce(new Error("resend is down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await checkProviderBalance(db, { balance: async () => ({ balance: 1, low: true, empty: false }) })).toMatchObject({ balance: 1 });
  });
});
