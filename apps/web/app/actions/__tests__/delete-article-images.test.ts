import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeStorage } from "@/lib/storage/__tests__/fake-storage";

// deleteArticle removes the images of a draft that never reached a reader,
// after the person's own delete succeeded; a published article's images stay,
// because the live post hotlinks them.

const WS = "11111111-1111-4111-8111-111111111111";
const ART = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let removedRows: { id: string }[] = [];
let files: ReturnType<typeof fakeStorage>;

vi.mock("@/lib/billing/overage", () => ({ removePendingOverage: vi.fn(async () => 1) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ accountId: "acc-1", role: "editor", user: { id: "u1" } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ delete: () => ({ eq: () => ({ select: async () => ({ data: removedRows, error: null }) }) }) }),
  }),
  createServiceClient: () => {
    throw new Error("not used: storageAdmin is mocked");
  },
}));
vi.mock("@/lib/storage/purge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/purge")>();
  return { ...real, storageAdmin: () => adminClient() };
});

/** The server's client: article facts from `facts`, storage from `files`. */
let facts: Record<string, unknown> | null = null;
function adminClient() {
  const storage = (files.client as unknown as { storage: unknown }).storage;
  return {
    storage,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: facts, error: null }) }) }),
    }),
  };
}

beforeEach(() => {
  removedRows = [];
  facts = null;
  files = fakeStorage({ "article-images": [`${WS}/${ART}.webp`, `${WS}/${ART}-1.webp`, `${WS}/${ART}/proposals/1.png`] });
});

describe("deleteArticle and its images", () => {
  it("removes a never-published draft's images and proposals", async () => {
    removedRows = [{ id: ART }];
    facts = { id: ART, workspace_id: WS, status: "review", published_url: null, external_id: null };
    const { deleteArticle } = await import("../articles");
    await deleteArticle(ART);
    expect(files.paths("article-images")).toEqual([]);
  });

  it("keeps the images of an article that was published", async () => {
    removedRows = [{ id: ART }];
    facts = { id: ART, workspace_id: WS, status: "live", published_url: "https://acme.co/post" };
    const { deleteArticle } = await import("../articles");
    await deleteArticle(ART);
    expect(files.removed).toHaveLength(0);
  });

  it("removes nothing when the delete removed no row", async () => {
    facts = { id: ART, workspace_id: WS, status: "review" };
    const { deleteArticle } = await import("../articles");
    await deleteArticle(ART);
    expect(files.removed).toHaveLength(0);
  });

  it("keeps the images when the article could not be read first", async () => {
    removedRows = [{ id: ART }];
    facts = null;
    const { deleteArticle } = await import("../articles");
    await deleteArticle(ART);
    expect(files.removed).toHaveLength(0);
  });
});
