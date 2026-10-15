import { describe, expect, it } from "vitest";
import { deleteConfirmationText, deleteWorkspaceForAccount } from "@/lib/workspaces/delete";
import { fakeStorage } from "@/lib/storage/__tests__/fake-storage";

type Row = { id: string; account_id: string; name: string; domain: string | null };

/** A client over one workspaces table that records deletes; `refuse` mimics RLS turning a delete into zero rows. */
function fakeClient(rows: Row[], opts: { refuse?: boolean; deleteError?: { code: string; message: string } } = {}) {
  const deleted: string[] = [];
  const client = {
    from: () => {
      const filters: Record<string, unknown> = {};
      let deleting = false;
      const match = () => rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k as keyof Row] === v));
      const b: Record<string, unknown> = {
        select: () => b,
        delete: () => {
          deleting = true;
          return b;
        },
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return b;
        },
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (!deleting) return resolve({ data: match(), error: null });
          if (opts.deleteError) return resolve({ data: null, error: opts.deleteError });
          if (opts.refuse) return resolve({ data: [], error: null });
          const gone = match();
          deleted.push(...gone.map((r) => r.id));
          return resolve({ data: gone.map((r) => ({ id: r.id })), error: null });
        },
      };
      return b;
    },
  };
  return { client: client as never, deleted };
}

const SITE: Row = { id: "ws-1", account_id: "acc-1", name: "Acme", domain: "acme.com" };

describe("deleteWorkspaceForAccount", () => {
  it("deletes once the domain is typed, however it is written", async () => {
    const db = fakeClient([SITE]);
    expect(await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", " https://www.ACME.com/ ")).toEqual({ ok: true });
    expect(db.deleted).toEqual(["ws-1"]);
  });

  it("refuses without the typed domain and deletes nothing", async () => {
    const db = fakeClient([SITE]);
    expect(await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme")).toEqual({ ok: false, message: "Type acme.com to confirm." });
    expect(db.deleted).toEqual([]);
  });

  it("refuses a site on another account", async () => {
    const db = fakeClient([SITE]);
    const result = await deleteWorkspaceForAccount(db.client, "acc-2", "ws-1", "acme.com");
    expect(result.ok).toBe(false);
    expect(db.deleted).toEqual([]);
  });

  it("reports a delete RLS refused instead of claiming success", async () => {
    const db = fakeClient([SITE], { refuse: true });
    expect(await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme.com")).toEqual({
      ok: false,
      message: "Only owners and admins can delete a workspace.",
    });
  });

  it("explains a row that still points at the site", async () => {
    const db = fakeClient([SITE], { deleteError: { code: "23503", message: "fk" } });
    const result = await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme.com");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/link exchange/);
  });

  it("asks for the name when a site has no domain", () => {
    expect(deleteConfirmationText({ domain: null, name: "Draft site" })).toBe("Draft site");
    expect(deleteConfirmationText({ domain: "acme.com", name: "Acme" })).toBe("acme.com");
  });
});

describe("deleteWorkspaceForAccount and the files a cascade does not reach", () => {
  const DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const LIVE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function storage() {
    return fakeStorage(
      {
        reports: ["reports/ws-1/2026-09-01_2026-09-30.pdf", "reports/ws-2/2026-09-01_2026-09-30.pdf"],
        "article-images": [
          `ws-1/${DRAFT}.webp`,
          `ws-1/${DRAFT}/proposals/1.png`,
          `ws-1/${LIVE}.webp`,
          `ws-2/${DRAFT}.webp`,
        ],
      },
      [
        { id: DRAFT, workspace_id: "ws-1", status: "review" },
        { id: LIVE, workspace_id: "ws-1", status: "live", published_url: "https://acme.com/post" },
      ],
    );
  }

  it("removes the site's report PDFs and its draft-only images, and keeps a published article's", async () => {
    const db = fakeClient([SITE]);
    const files = storage();
    expect(await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme.com", files.client)).toEqual({ ok: true });
    expect(files.paths("reports")).toEqual(["reports/ws-2/2026-09-01_2026-09-30.pdf"]);
    expect(files.paths("article-images")).toEqual([`ws-1/${LIVE}.webp`, `ws-2/${DRAFT}.webp`]);
  });

  it("removes nothing when the delete itself was refused", async () => {
    const db = fakeClient([SITE], { refuse: true });
    const files = storage();
    await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme.com", files.client);
    expect(files.removed).toHaveLength(0);
  });

  it("removes nothing without the confirmation", async () => {
    const db = fakeClient([SITE]);
    const files = storage();
    await deleteWorkspaceForAccount(db.client, "acc-1", "ws-1", "acme", files.client);
    expect(files.removed).toHaveLength(0);
  });
});
