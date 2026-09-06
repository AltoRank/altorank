import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import type { NotionConfig } from "@/lib/types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class NotionAdapter implements CMSAdapter {
  private databaseId: string;
  private token: string;
  private statusProperty: string | undefined;
  private draftStatus: string;
  private publishedStatus: string;

  constructor(config: NotionConfig) {
    this.databaseId = config.databaseId;
    this.token = config.integrationToken;
    this.statusProperty = config.statusProperty?.trim() || undefined;
    this.draftStatus = config.draftStatus?.trim() || "Draft";
    this.publishedStatus = config.publishedStatus?.trim() || "Published";
  }

  /**
   * A Notion page has no publish state, so draft-vs-live only exists when the
   * database has a Status property and the connection named it. Without one
   * nothing is written and lib/cms/publish-mode.ts has already refused to
   * connect in draft mode - this must not silently pretend.
   */
  private statusProperties(mode: PublishPayload["publishMode"]): Record<string, unknown> {
    if (!this.statusProperty) return {};
    return {
      [this.statusProperty]: {
        status: { name: mode === "draft" ? this.draftStatus : this.publishedStatus },
      },
    };
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "Notion-Version": NOTION_VERSION,
    };
  }

  /**
   * Convert simple HTML into Notion block children.
   * Handles paragraphs, headings (h1-h3), and lists.
   */
  private htmlToBlocks(html: string): Record<string, unknown>[] {
    const blocks: Record<string, unknown>[] = [];
    const tagPattern = /<(h[1-3]|p|li)(?:\s[^>]*)?>([^<]*)<\/\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = tagPattern.exec(html)) !== null) {
      const tag = match[1].toLowerCase();
      const text = match[2].trim();
      if (!text) continue;

      if (tag === "h1") {
        blocks.push({
          object: "block",
          type: "heading_1",
          heading_1: { rich_text: [{ type: "text", text: { content: text } }] },
        });
      } else if (tag === "h2") {
        blocks.push({
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: text } }] },
        });
      } else if (tag === "h3") {
        blocks.push({
          object: "block",
          type: "heading_3",
          heading_3: { rich_text: [{ type: "text", text: { content: text } }] },
        });
      } else {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
        });
      }
    }

    // Notion limits 100 blocks per request
    return blocks.slice(0, 100);
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        parent: { database_id: this.databaseId },
        properties: {
          Name: {
            title: [{ text: { content: article.title } }],
          },
          Slug: {
            rich_text: [{ text: { content: article.slug } }],
          },
          ...this.statusProperties(article.publishMode),
        },
        children: this.htmlToBlocks(article.html),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion publish failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    return {
      externalId: data.id,
      url: data.url,
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

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(
        `${NOTION_API}/databases/${this.databaseId}`,
        { headers: this.headers() },
      );
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
