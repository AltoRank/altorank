// ---------------------------------------------------------------------------
// A GET must not unsubscribe anybody
// ---------------------------------------------------------------------------
//
// The footer link used to opt the address out on arrival. Microsoft Defender
// Safe Links, Proofpoint URL Defense, Mimecast and Barracuda fetch every link
// in an inbound message before the recipient sees it, so on a corporate tenant
// the recipient's own IT department unsubscribed them. It was reproduced by
// accident with a single `curl` of the link.
//
// The write moved to the POST - the server action behind the confirm button -
// and RFC 8058 one-click keeps its own POST endpoint, which is what that header
// promises a mail client. Both halves are asserted here.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const { unsubscribeAddress, resubscribeAddress, readUnsubscribed } = vi.hoisted(() => ({
  unsubscribeAddress: vi.fn(),
  resubscribeAddress: vi.fn(),
  readUnsubscribed: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));
vi.mock("@/lib/email/preferences", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email/preferences")>(
    "@/lib/email/preferences",
  );
  return { ...actual, unsubscribeAddress, resubscribeAddress, readUnsubscribed };
});

import UnsubscribePage from "../page";
import { POST } from "@/app/api/unsubscribe/route";
import { signUnsubscribe } from "@/lib/email/unsubscribe";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

const EMAIL = "reader@account.co";

function link(category: string) {
  const s = signUnsubscribe(EMAIL, category)!;
  return { e: EMAIL, c: category, s };
}

beforeEach(() => {
  unsubscribeAddress.mockReset().mockResolvedValue(undefined);
  resubscribeAddress.mockReset().mockResolvedValue(undefined);
  readUnsubscribed.mockReset().mockResolvedValue([]);
});

describe("GET /unsubscribe", () => {
  it("writes nothing - a link scanner fetching it changes no preference", async () => {
    await UnsubscribePage({ searchParams: Promise.resolve(link("drafts")) });
    expect(unsubscribeAddress).not.toHaveBeenCalled();
    expect(resubscribeAddress).not.toHaveBeenCalled();
  });

  it("writes nothing for an all-optional link either", async () => {
    await UnsubscribePage({ searchParams: Promise.resolve(link("all")) });
    expect(unsubscribeAddress).not.toHaveBeenCalled();
  });

  it("writes nothing when the signature is wrong", async () => {
    await UnsubscribePage({
      searchParams: Promise.resolve({ e: EMAIL, c: "drafts", s: "0".repeat(32) }),
    });
    expect(unsubscribeAddress).not.toHaveBeenCalled();
    expect(readUnsubscribed).not.toHaveBeenCalled();
  });

  it("reads the current preferences so it can show them", async () => {
    await UnsubscribePage({ searchParams: Promise.resolve(link("reports")) });
    expect(readUnsubscribed).toHaveBeenCalledWith(expect.anything(), EMAIL);
  });
});

/**
 * RFC 8058: the `List-Unsubscribe-Post` header promises a mail client that this
 * POST alone is enough, with no page in between. Fixing the GET must not break
 * it - the two are different URLs on purpose.
 */
describe("POST /api/unsubscribe (one-click)", () => {
  it("still opts the address out on the POST", async () => {
    const { e, c, s } = link("publishing");
    const res = await POST(
      new Request(`https://app.altorank.co/api/unsubscribe?e=${encodeURIComponent(e)}&c=${c}&s=${s}`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, email: EMAIL, category: "publishing" });
    expect(unsubscribeAddress).toHaveBeenCalledWith(expect.anything(), EMAIL, "publishing");
  });

  it("refuses an unsigned or wrongly signed request", async () => {
    const res = await POST(
      new Request(`https://app.altorank.co/api/unsubscribe?e=${encodeURIComponent(EMAIL)}&c=drafts&s=nope`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    expect(unsubscribeAddress).not.toHaveBeenCalled();
  });
});
