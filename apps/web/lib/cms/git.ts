// ---------------------------------------------------------------------------
// Git-backed publishing (GitHub Contents API)
// ---------------------------------------------------------------------------
//
// Publishes to sites that have no CMS: an article becomes a Markdown file
// committed to a repository, and the host's existing build pipeline deploys it.
// Astro, Next, Hugo, Eleventy, Jekyll and Gatsby all work this way, and none of
// the eleven CMS adapters can touch them.
//
// This is also the only way to publish to altorank.co, which is an Astro site
// built from this repository. Dogfooding our own publishing was impossible
// without it.
//
// SECURITY
//
// This holds a token that can write to a repository, and the filename is
// derived from an article slug that a language model produced. That is a direct
// path-traversal surface: a slug of "../../.github/workflows/deploy" would turn
// a blog publisher into arbitrary CI execution.
//
// So the path is not trusted anywhere. The slug is reduced to a single safe
// filename segment, the final path is required to sit inside the configured
// content directory, and the extension is fixed to .md or .mdx. Those three
// checks are independent, and `resolveContentPath` is exported so they are
// tested directly rather than only through a live publish.

import type { CMSAdapter, PublishPayload, PublishResult } from "./types";
import { htmlToMarkdown } from "@/lib/audit/markdown";
import { buildFrontmatter } from "./frontmatter";
import { urlIsLive } from "./blog-url";

export interface GitConfig {
  type: "git";
  /** Only GitHub today; the field exists so the check is explicit. */
  provider: "github";
  /** PAT or app token with contents:write on the repo. */
  token: string;
  owner: string;
  repo: string;
  /** Branch to commit to. */
  branch: string;
  /** Directory the posts live in, repo-relative, e.g. "src/content/blog". */
  contentPath: string;
  extension?: "md" | "mdx";
  /** Frontmatter values the target collection requires but an article has no opinion on. */
  frontmatterDefaults?: Record<string, string | boolean | string[]>;
  /** Public base URL for the published post, e.g. "https://altorank.co/blog". */
  publicBaseUrl?: string;
  /**
   * Whether this site's post URLs end in "/". Derived from the site's own
   * sitemap by lib/cms/blog-url.ts, not assumed: altorank.co, astro.build and
   * every other Astro-on-Cloudflare site say yes, and building the URL without
   * one stores a form that only works because a redirect rescues it.
   */
  trailingSlash?: boolean;
  /** Commit author, defaults to the token's identity when omitted. */
  committer?: { name: string; email: string };
}

const GITHUB_API = "https://api.github.com";

/** One path segment, lowercase, no traversal, no separators. */
function safeSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);

  if (!cleaned) throw new Error("Article slug is empty after sanitising");
  return cleaned;
}

/**
 * Build the repo-relative file path, refusing anything outside the content
 * directory. Exported for tests: this is the boundary that stops a hostile slug
 * from writing a workflow file.
 */
export function resolveContentPath(
  contentPath: string,
  slug: string,
  extension: "md" | "mdx" = "md",
): string {
  const dir = contentPath.replace(/^\/+|\/+$/g, "");
  if (!dir) throw new Error("contentPath is required");
  if (dir.split("/").includes("..")) {
    throw new Error("contentPath must not contain '..'");
  }

  const file = `${safeSlug(slug)}.${extension}`;
  const full = `${dir}/${file}`;

  // Belt and braces: even though safeSlug cannot produce a separator, assert the
  // final path still resolves inside the configured directory.
  const normalized = full
    .split("/")
    .reduce<string[]>((acc, part) => {
      if (part === "." || part === "") return acc;
      if (part === "..") {
        acc.pop();
        return acc;
      }
      acc.push(part);
      return acc;
    }, [])
    .join("/");

  if (normalized !== full || !normalized.startsWith(`${dir}/`)) {
    throw new Error(`Refusing to write outside ${dir}`);
  }

  return normalized;
}

// Front matter rendering moved to lib/cms/frontmatter.ts so the editor's
// "copy as Markdown" can render the same file without importing this adapter.
// Re-exported because the tests and the publish path import it from here.
export { buildFrontmatter };

/**
 * Render the exact file that would be committed.
 *
 * Separate from `publish` so the output can be checked against a real site's
 * content schema without a token and without a network call: write it into the
 * target repo, run that site's build, and the build either accepts the
 * frontmatter or it does not. Verifying a replica of this logic instead would
 * only prove the replica works.
 */
export function renderPost(
  article: PublishPayload,
  config: Pick<
    GitConfig,
    "contentPath" | "extension" | "frontmatterDefaults" | "publicBaseUrl"
  >,
): { path: string; contents: string } {
  const extension = config.extension ?? "md";
  const path = resolveContentPath(config.contentPath, article.slug, extension);

  const { markdown } = htmlToMarkdown(
    article.html,
    config.publicBaseUrl ?? "https://example.com",
  );

  const frontmatter = buildFrontmatter({
    ...config.frontmatterDefaults,
    title: article.title,
    description: article.metaDescription,
    publishDate: (article.publishedAt ?? new Date().toISOString()).slice(0, 10),
    tags: article.tags?.length ? article.tags : undefined,
    ogImage: article.featuredImageUrl,
    // After the defaults so a collection whose defaults say `draft: false`
    // still gets a draft when the connection asks for one. Only ever set for
    // a draft: a live publish leaves the field to the defaults, which is what
    // every commit before this did.
    ...(article.publishMode === "draft" ? { draft: true } : {}),
  });

  return { path, contents: `${frontmatter}\n${markdown}\n` };
}

export class GitAdapter implements CMSAdapter {
  constructor(private config: GitConfig) {
    if (config.provider !== "github") {
      throw new Error(`Unsupported git provider: ${config.provider}`);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "AltoRank",
    };
  }

  private contentsUrl(path: string): string {
    const { owner, repo } = this.config;
    return `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`;
  }

  /** Existing file sha, needed to update rather than fail with a 422. */
  private async existingSha(path: string): Promise<string | undefined> {
    const url = `${this.contentsUrl(path)}?ref=${encodeURIComponent(this.config.branch)}`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { sha?: string };
    return body.sha;
  }

  async publish(article: PublishPayload): Promise<PublishResult> {
    const { path, contents: fileContents } = renderPost(article, this.config);
    const sha = await this.existingSha(path);

    const res = await fetch(this.contentsUrl(path), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        message: sha
          ? `content: update "${article.title}"`
          : `content: publish "${article.title}"`,
        content: Buffer.from(fileContents, "utf8").toString("base64"),
        branch: this.config.branch,
        ...(sha ? { sha } : {}),
        ...(this.config.committer ? { committer: this.config.committer } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub publish failed (${res.status}): ${await res.text()}`);
    }

    const body = (await res.json()) as { content?: { sha?: string; path?: string } };

    const base = this.config.publicBaseUrl?.replace(/\/+$/, "");
    return {
      externalId: body.content?.path ?? path,
      // Still derived - the GitHub API cannot know the host's routing - but no
      // longer guessed: publicBaseUrl and trailingSlash are read off the site's
      // own sitemap at connect time and validated against a URL that already
      // resolves. Whether it is live *now* is a separate question, answered
      // after the build by the publish cron, because a commit is not a deploy.
      url: base
        ? `${base}/${safeSlug(article.slug)}${this.config.trailingSlash ? "/" : ""}`
        : path,
    };
  }

  /**
   * Rewrite the committed file at the path we published to.
   *
   * The external id IS the path, so this writes there rather than deriving a
   * path from the slug again: a slug that changed would otherwise create a
   * second file and leave the first one serving the old page.
   */
  async update(externalId: string, article: PublishPayload): Promise<PublishResult> {
    const dir = this.config.contentPath.replace(/^\/+|\/+$/g, "");
    if (!externalId.startsWith(`${dir}/`) || externalId.includes("..")) {
      throw new Error(`Refusing to write outside ${dir}`);
    }
    const { contents } = renderPost(article, this.config);
    const sha = await this.existingSha(externalId);
    if (!sha) throw new Error(`No file at ${externalId} to update`);

    const res = await fetch(this.contentsUrl(externalId), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        message: `content: refresh "${article.title}"`,
        content: Buffer.from(contents, "utf8").toString("base64"),
        branch: this.config.branch,
        sha,
        ...(this.config.committer ? { committer: this.config.committer } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub update failed (${res.status}): ${await res.text()}`);
    }
    const base = this.config.publicBaseUrl?.replace(/\/+$/, "");
    return {
      externalId,
      url: base
        ? `${base}/${safeSlug(article.slug)}${this.config.trailingSlash ? "/" : ""}`
        : externalId,
    };
  }

  /**
   * Deletes the committed file. The post disappears on the next build, which is
   * the closest a static site has to unpublishing.
   */
  async unpublish(externalId: string): Promise<void> {
    const dir = this.config.contentPath.replace(/^\/+|\/+$/g, "");
    if (!externalId.startsWith(`${dir}/`)) {
      throw new Error(`Refusing to delete outside ${dir}`);
    }

    const sha = await this.existingSha(externalId);
    if (!sha) return;

    const res = await fetch(this.contentsUrl(externalId), {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify({
        message: `content: unpublish ${externalId}`,
        sha,
        branch: this.config.branch,
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub delete failed (${res.status}): ${await res.text()}`);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { owner, repo, branch } = this.config;
      const res = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
        { headers: this.headers() },
      );
      if (res.status === 404) {
        return { ok: false, error: `Repo or branch not found: ${owner}/${repo}@${branch}` };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "Token rejected or missing contents:write" };
      }
      if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };

      /**
       * The repo is reachable. The other half of a git connection is where the
       * posts come out, and that is the half that used to be unchecked: a wrong
       * publicBaseUrl produced an article marked live pointing at a URL that
       * never existed, and submitted it to IndexNow.
       *
       * Checked against the base itself, which a site with a blog already
       * serves. Not against a future post URL - that cannot exist until a build
       * has run, so it would fail for everyone.
       */
      const base = this.config.publicBaseUrl?.replace(/\/+$/, "");
      if (base) {
        if (!(await urlIsLive(base))) {
          return {
            ok: false,
            error: `Repo is fine, but ${base} did not respond. Check the public URL your posts appear at.`,
          };
        }
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
    }
  }
}
