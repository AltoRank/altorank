import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WixConfig } from "@/lib/types";

const WIX_API = "https://www.wixapis.com";

// ---------------------------------------------------------------------------
// Discovery: the sites an account-level API key can see.
//   POST /site-list/v2/sites/query   scope SCOPE.ACC-DC-OS.READ-SITE
// Account-level, so the request carries `wix-account-id` and no site id.
// https://dev.wix.com/docs/api-reference/account-level/sites/sites/query-sites
// https://dev.wix.com/docs/go-headless/authentication/admin/make-rest-api-calls-with-an-api-key
// ---------------------------------------------------------------------------

export interface WixSite {
  id: string;
  displayName: string;
  viewUrl: string;
  published: boolean;
}

export async function listWixSites(apiKey: string, accountId: string): Promise<WixSite[]> {
  const res = await fetch(`${WIX_API}/site-list/v2/sites/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
      "wix-account-id": accountId,
    },
    body: JSON.stringify({
      query: {
        cursorPaging: { limit: 100 },
        sort: [{ fieldName: "displayName", order: "ASC" }],
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Wix ${res.status}${err ? `: ${err}` : ""}`);
  }
  const data = (await res.json()) as {
    sites?: Array<{ id: string; displayName?: string; name?: string; viewUrl?: string; published?: boolean }>;
  };
  return (data.sites ?? []).map((s) => ({
    id: s.id,
    displayName: s.displayName ?? s.name ?? s.id,
    viewUrl: s.viewUrl ?? "",
    published: s.published ?? false,
  }));
}

export class WixAdapter implements CMSAdapter {
  private accountId: string;
  private siteId: string;
  private apiKey: string;

  constructor(config: WixConfig) {
    this.accountId = config.accountId;
    this.siteId = config.siteId;
    this.apiKey = config.apiKey;
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: this.apiKey,
      "wix-account-id": this.accountId,
      "wix-site-id": this.siteId,
    };
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    // Step 1: Create draft post
    const createRes = await fetch(
      `${WIX_API}/blog/v3/draft-posts`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          draftPost: {
            title: article.title,
            richContent: {
              nodes: [
                {
                  type: "PARAGRAPH",
                  paragraphData: {},
                  nodes: [
                    {
                      type: "TEXT",
                      textData: { text: "" },
                    },
                  ],
                },
              ],
            },
            excerpt: article.metaDescription ?? "",
          },
        }),
      },
    );

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Wix create draft failed (${createRes.status}): ${err}`);
    }

    const createData = await createRes.json();
    const draftId = createData.draftPost?.id;
    if (!draftId) throw new Error("Wix returned no draft post ID");

    // A draft connection stops here: Wix's own model is draft-then-publish,
    // so "save as draft" is simply not taking the second step. No public URL
    // exists yet, and none is claimed.
    if (article.publishMode === "draft") {
      return { externalId: draftId, url: "" };
    }

    // Step 2: Publish the draft
    const publishRes = await fetch(
      `${WIX_API}/blog/v3/draft-posts/${draftId}/publish`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );

    if (!publishRes.ok) {
      const err = await publishRes.text();
      throw new Error(`Wix publish failed (${publishRes.status}): ${err}`);
    }

    const publishData = await publishRes.json();
    const post = publishData.post ?? {};

    return {
      externalId: post.id ?? draftId,
      url: post.url ?? `https://${this.siteId}.wixsite.com/blog/${article.slug}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${WIX_API}/blog/v3/posts/${externalId}/unpublish`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );

    if (!res.ok) throw new Error(`Wix unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${WIX_API}/blog/v3/posts?paging.limit=1`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
