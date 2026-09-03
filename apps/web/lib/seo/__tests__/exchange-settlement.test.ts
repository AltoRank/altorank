import { afterEach, describe, expect, it, vi } from "vitest";
import { settleExchangeForArticle } from "../exchange";

/**
 * Guards the direction of the money, which is the whole of migration 039 and
 * the one bug in this feature that would be worth real damage: crediting the
 * publisher for carrying a link is what made the citation a paid link.
 */
const EXCHANGE = {
  id: "ex1",
  status: "placed",
  provider_agency_id: "agency-publisher",
  requester_agency_id: "agency-writer",
  provider_workspace_id: "ws-publisher",
  target_url: "https://writer.example/guide",
};

type Insert = { agency_id: string; amount: number; reason: string; dr_at_time: number | null };

function mockAdmin(exchange: Record<string, unknown> | null = EXCHANGE) {
  const credits: Insert[] = [];
  const updates: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table === "backlink_exchanges") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: exchange }) }) }),
          update: (row: Record<string, unknown>) => {
            updates.push(row);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === "workspaces") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { dr: 72 } }) }) }) };
      }
      if (table === "articles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { published_url: "https://publisher.example/post" } }) }),
          }),
        };
      }
      if (table === "backlink_credits") {
        return {
          insert: async (row: Insert) => {
            credits.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { admin, credits, updates };
}

function mockPage(html: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe("settleExchangeForArticle", () => {
  it("debits the publisher and credits the writer", async () => {
    mockPage(`<a href="${EXCHANGE.target_url}">writer</a>`);
    const { admin, credits } = mockAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await settleExchangeForArticle(admin as any, "a1");

    expect(out).toMatchObject({ settled: true, credits: 1, citation: "kept" });
    const publisher = credits.find((c) => c.agency_id === "agency-publisher")!;
    const writer = credits.find((c) => c.agency_id === "agency-writer")!;
    // The sign is the feature. Publisher pays, writer is paid.
    expect(publisher.amount).toBeLessThan(0);
    expect(writer.amount).toBeGreaterThan(0);
    expect(publisher.reason).toBe("receive_article");
    expect(writer.reason).toBe("supply_article");
    expect(publisher.amount + writer.amount).toBe(0);
  });

  it("records no domain rating, because the price no longer depends on one", async () => {
    mockPage(`<a href="${EXCHANGE.target_url}">writer</a>`);
    const { admin, credits } = mockAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await settleExchangeForArticle(admin as any, "a1");
    expect(credits.every((c) => c.dr_at_time === null)).toBe(true);
  });

  it("settles even when the publisher cut the citation, and says so", async () => {
    // The compliance property, end to end: payment follows publication, not
    // the link. A publisher who removed the citation is still square.
    mockPage(`<p>an article with no link to the writer</p>`);
    const { admin, credits, updates } = mockAdmin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await settleExchangeForArticle(admin as any, "a1");
    expect(out).toMatchObject({ settled: true, citation: "removed" });
    expect(credits).toHaveLength(2);
    expect(updates[0]).toMatchObject({ status: "live" });
  });

  it("does nothing for an article that belongs to no exchange", async () => {
    const { admin, credits } = mockAdmin(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await settleExchangeForArticle(admin as any, "a1")).toBeNull();
    expect(credits).toHaveLength(0);
  });

  it("moves nothing for an exchange that is not placed", async () => {
    const { admin, credits } = mockAdmin({ ...EXCHANGE, status: "accepted" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await settleExchangeForArticle(admin as any, "a1");
    expect(out).toMatchObject({ settled: false });
    expect(credits).toHaveLength(0);
  });
});
