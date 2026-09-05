import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { WebflowConfig, WebflowFieldMap } from "@/lib/types";
import { DEFAULT_WEBFLOW_FIELD_MAP } from "./webflow-fields";

const WEBFLOW_API = "https://api.webflow.com/v2";

function headers(apiToken: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiToken}`,
  };
}

/**
 * One GET against the Data API, with the error text Webflow returned kept
 * whole. The adapter's test and the connect dialog's pickers both go through
 * here, so a token that fails in the picker fails with the same words later.
 */
async function webflowGet<T>(apiToken: string, path: string): Promise<T> {
  const res = await fetch(`${WEBFLOW_API}${path}`, { headers: headers(apiToken) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webflow ${res.status}${err ? `: ${err}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Discovery: what a token can see. The connect dialog uses these so the person
// picks a site and a collection instead of pasting ids.
//   GET /v2/sites                        scope sites:read
//   GET /v2/sites/{site_id}/collections  scope cms:read
//   GET /v2/collections/{collection_id}  scope cms:read (fields come back here)
// https://developers.webflow.com/data/reference/sites/list
// https://developers.webflow.com/data/reference/cms/collections/list
// https://developers.webflow.com/data/reference/cms/collections/get
// ---------------------------------------------------------------------------

export interface WebflowSite {
  id: string;
  displayName: string;
  shortName: string;
  customDomains: string[];
}

export interface WebflowCollection {
  id: string;
  displayName: string;
  singularName: string;
  slug: string;
}

export interface WebflowField {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  isEditable: boolean;
}

export async function listWebflowSites(apiToken: string): Promise<WebflowSite[]> {
  const data = await webflowGet<{
    sites?: Array<{
      id: string;
      displayName?: string;
      shortName?: string;
      customDomains?: Array<{ url?: string }>;
    }>;
  }>(apiToken, "/sites");
  return (data.sites ?? []).map((s) => ({
    id: s.id,
    displayName: s.displayName ?? s.shortName ?? s.id,
    shortName: s.shortName ?? "",
    customDomains: (s.customDomains ?? []).map((d) => d.url).filter((u): u is string => !!u),
  }));
}

export async function listWebflowCollections(
  apiToken: string,
  siteId: string,
): Promise<WebflowCollection[]> {
  const data = await webflowGet<{
    collections?: Array<{ id: string; displayName?: string; singularName?: string; slug?: string }>;
  }>(apiToken, `/sites/${encodeURIComponent(siteId)}/collections`);
  return (data.collections ?? []).map((c) => ({
    id: c.id,
    displayName: c.displayName ?? c.slug ?? c.id,
    singularName: c.singularName ?? "",
    slug: c.slug ?? "",
  }));
}

export async function listWebflowFields(
  apiToken: string,
  collectionId: string,
): Promise<WebflowField[]> {
  const data = await webflowGet<{
    fields?: Array<{
      id: string;
      slug?: string;
      displayName?: string;
      type?: string;
      isRequired?: boolean;
      isEditable?: boolean;
    }>;
  }>(apiToken, `/collections/${encodeURIComponent(collectionId)}`);
  return (data.fields ?? []).map((f) => ({
    id: f.id,
    slug: f.slug ?? "",
    displayName: f.displayName ?? f.slug ?? f.id,
    type: f.type ?? "",
    // Webflow marks its two built-ins (name, slug) required; the rest default
    // to optional. isEditable is absent on most fields and absent means true.
    isRequired: f.isRequired ?? false,
    isEditable: f.isEditable ?? true,
  }));
}

/**
 * The item body for a collection, from the connection's field map.
 *
 * Exported so the shape is tested once: a wrong slug here is an item Webflow
 * rejects with a 400 on every publish, which is the bug the picker exists to
 * prevent. Fields the map leaves out are not sent; an image is sent as
 * `{ url }`, the form the Data API takes for Image fields.
 */
export function webflowFieldData(
  map: WebflowFieldMap,
  article: PublishPayload,
  opts: { includeSlug: boolean },
): Record<string, unknown> {
  const fieldData: Record<string, unknown> = {
    [map.title]: article.title,
    [map.body]: article.html,
  };
  if (opts.includeSlug) fieldData[map.slug] = article.slug;
  if (map.summary) fieldData[map.summary] = article.metaDescription ?? "";
  if (map.image && article.featuredImageUrl) {
    fieldData[map.image] = { url: article.featuredImageUrl };
  }
  return fieldData;
}

export class WebflowAdapter implements CMSAdapter {
  private siteId: string;
  private collectionId: string;
  private apiToken: string;
  private fieldMap: WebflowFieldMap;

  constructor(config: WebflowConfig) {
    this.siteId = config.siteId;
    this.collectionId = config.collectionId;
    this.apiToken = config.apiToken;
    // Connections saved before the picker existed carry no map and keep the
    // slugs the adapter always used.
    this.fieldMap = config.fieldMap ?? DEFAULT_WEBFLOW_FIELD_MAP;
  }

  private headers() {
    return headers(this.apiToken);
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const draft = article.publishMode === "draft";
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          // A draft item is staged in the collection and never pushed to the
          // live site; the publish call below is what would make it public.
          isDraft: draft,
          fieldData: webflowFieldData(this.fieldMap, article, { includeSlug: true }),
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Webflow publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const itemId = data.id ?? data._id;

    // Publish the item live - unless the connection asked for a draft, in
    // which case staging it is the whole job.
    if (!draft) {
      await fetch(
        `${WEBFLOW_API}/collections/${this.collectionId}/items/${itemId}/publish`,
        { method: "POST", headers: this.headers() },
      );
    }

    return {
      externalId: String(itemId),
      url: `https://${this.siteId}.webflow.io/${article.slug}`,
    };
  }

  /** Edit the item in place, then publish it so the change goes live. */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({
          fieldData: webflowFieldData(this.fieldMap, article, { includeSlug: false }),
        }),
      },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Webflow update failed (${res.status}): ${err}`);
    }
    await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}/publish`,
      { method: "POST", headers: this.headers() },
    );
    return {
      externalId,
      url: `https://${this.siteId}.webflow.io/${article.slug}`,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(
      `${WEBFLOW_API}/collections/${this.collectionId}/items/${externalId}`,
      {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ fieldData: { _archived: true } }),
      },
    );

    if (!res.ok) throw new Error(`Webflow unpublish failed (${res.status})`);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${WEBFLOW_API}/collections/${this.collectionId}`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
