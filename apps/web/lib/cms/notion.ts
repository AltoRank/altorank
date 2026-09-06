import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { NotionConfig } from "@/lib/types";
import { htmlToNotionBlocks, pageChildren, richText, type NotionBlock } from "./notion-blocks";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** The property names this adapter writes, read off the database's own schema. */
export interface NotionSchema {
  /** The database's title property. Every database has exactly one. */
  titleProperty: string;
  /** A rich-text property called Slug, when the database has one. */
  slugProperty: string | null;
  /** type of each property, by name, for the status write. */
  types: Record<string, string>;
}

/**
 * Read the property names out of a Notion database schema.
 *
 * Exported so the shape is tested once. The adapter used to hardcode `Name`
 * and `Slug`: a database whose title property is called anything else - which
 * is most of them, since Notion renames it with the first column - passed the
 * connection test (a plain GET) and then 400'd on the first publish with a
 * raw Notion validation error and nothing to act on.
 */
export function readNotionSchema(properties: Record<string, { type?: string }>): NotionSchema {
  const types: Record<string, string> = {};
  for (const [name, prop] of Object.entries(properties ?? {})) types[name] = prop?.type ?? "";

  const titleProperty = Object.keys(types).find((name) => types[name] === "title");
  if (!titleProperty) {
    throw new Error(
      "This Notion database has no title property, so an article has nowhere to put its title. Point the connection at a database, not a page.",
    );
  }
  const slugProperty =
    Object.keys(types).find((name) => types[name] === "rich_text" && /^slug$/i.test(name)) ?? null;

  return { titleProperty, slugProperty, types };
}

export class NotionAdapter implements CMSAdapter {
  private databaseId: string;
  private token: string;
  private statusProperty: string | undefined;
  private draftStatus: string;
  private publishedStatus: string;
  private schema: NotionSchema | null = null;

  constructor(config: NotionConfig) {
    this.databaseId = config.databaseId;
    this.token = config.integrationToken;
    this.statusProperty = config.statusProperty?.trim() || undefined;
    this.draftStatus = config.draftStatus?.trim() || "Draft";
    this.publishedStatus = config.publishedStatus?.trim() || "Published";
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_VERSION,
    };
  }

  /** The database's schema, fetched once per adapter. */
  private async loadSchema(): Promise<NotionSchema> {
    if (this.schema) return this.schema;
    const res = await fetch(`${NOTION_API}/databases/${this.databaseId}`, { headers: this.headers() });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion database read failed (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { properties?: Record<string, { type?: string }> };
    this.schema = readNotionSchema(data.properties ?? {});
    return this.schema;
  }

  /**
   * A Notion page has no publish state, so draft-vs-live only exists when the
   * database has a Status property and the connection named it. Without one
   * nothing is written and lib/cms/publish-mode.ts has already refused to
   * connect in draft mode - this must not silently pretend.
   *
   * The property's own type decides the shape: a `status` property takes
   * `{ status: { name } }`, a `select` takes `{ select: { name } }`. Writing
   * the wrong one is a 400, which is what naming a select property used to do.
   */
  private statusProperties(
    mode: PublishPayload["publishMode"],
    schema: NotionSchema,
  ): Record<string, unknown> {
    if (!this.statusProperty) return {};
    const type = schema.types[this.statusProperty];
    if (!type) {
      throw new Error(
        `This Notion database has no "${this.statusProperty}" property. Rename it in Notion, or change it on the connection.`,
      );
    }
    const name = mode === "draft" ? this.draftStatus : this.publishedStatus;
    if (type === "select") return { [this.statusProperty]: { select: { name } } };
    if (type === "status") return { [this.statusProperty]: { status: { name } } };
    throw new Error(
      `The Notion property "${this.statusProperty}" is a ${type}, and only a status or select property can say whether a page is a draft.`,
    );
  }

  private async properties(
    article: PublishPayload,
    schema: NotionSchema,
  ): Promise<Record<string, unknown>> {
    return {
      [schema.titleProperty]: { title: richText([{ text: article.title }]) },
      ...(schema.slugProperty
        ? { [schema.slugProperty]: { rich_text: richText([{ text: article.slug }]) } }
        : {}),
      ...this.statusProperties(article.publishMode, schema),
    };
  }

  /**
   * Append the blocks past Notion's hundred-per-request cap.
   *
   * The old code sliced them off. Truncating the back half of an article and
   * reporting a successful publish is the same class of bug as publishing an
   * empty body, so the remainder is appended - and when an append fails the
   * error names the page, because a partial article now exists there.
   */
  private async appendBlocks(pageId: string, batches: NotionBlock[][], url: string): Promise<void> {
    for (const [i, children] of batches.entries()) {
      const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ children }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(
          `Notion took the page but rejected block batch ${i + 2} of ${batches.length + 1} (${res.status}): ${err}. The page at ${url || pageId} is incomplete.`,
        );
      }
    }
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const schema = await this.loadSchema();
    const blocks = htmlToNotionBlocks(article.html);
    if (blocks.length === 0) {
      throw new Error(
        "Notion refused: the article body converted to no blocks, so the page would have arrived empty. Nothing was sent.",
      );
    }
    const { first, rest } = pageChildren(blocks);

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        parent: { database_id: this.databaseId },
        properties: await this.properties(article, schema),
        children: first,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    const url = typeof data.url === "string" ? data.url : "";
    if (rest.length > 0) await this.appendBlocks(data.id, rest, url);

    return {
      externalId: data.id,
      url,
    };
  }

  async unpublish(externalId: string): Promise<void> {
    const res = await fetch(`${NOTION_API}/pages/${externalId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ archived: true }),
    });

    if (!res.ok) throw new Error(`Notion unpublish failed (${res.status})`);
  }

  /**
   * The database has to answer, and it has to have somewhere to put a title.
   *
   * A plain GET used to be the whole test, so a database with no title
   * property, or a connection naming a Status property that does not exist,
   * passed the test, saved, and failed on the first publish.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const schema = await this.loadSchema();
      if (this.statusProperty) {
        const type = schema.types[this.statusProperty];
        if (!type) {
          return {
            ok: false,
            error: `The database answered, but it has no "${this.statusProperty}" property to mark drafts with.`,
          };
        }
        if (type !== "status" && type !== "select") {
          return {
            ok: false,
            error: `"${this.statusProperty}" is a ${type} property; a draft needs a status or select property.`,
          };
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
