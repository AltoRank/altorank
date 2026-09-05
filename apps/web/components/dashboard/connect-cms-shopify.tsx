"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { listShopifyBlogsAction } from "@/app/actions/integrations";
import { SHOPIFY_REQUIRED_SCOPES, type ShopifyBlog } from "@/lib/cms/shopify";

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

const DOCS = {
  customApps: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
  installSetup: "https://help.shopify.com/en/manual/apps/install-setup-apps",
  scopes: "https://shopify.dev/docs/api/usage/access-scopes",
  clientCredentials:
    "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant",
};

function Doc({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-ink underline decoration-line underline-offset-[3px]"
    >
      {children}
    </a>
  );
}

/**
 * Shopify, step by step.
 *
 * A custom app is the only way to get an Admin API token for one store, and
 * making one takes five screens of Shopify's admin. The steps are written
 * out, numbered and always visible, with the scopes read from the adapter so
 * the list here can never drift from the calls it makes. No screenshots:
 * Shopify moves its admin around, and a stale picture is worse than a
 * sentence. Every step links the page it paraphrases.
 *
 * Step 5 is the form. Once the store answers, its blogs are listed and one
 * can be chosen; leaving it unchosen keeps the adapter's default (the first
 * blog), which is what every connection did before.
 */
export function ShopifyGuide() {
  const [storeUrl, setStoreUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blogs, setBlogs] = useState<ShopifyBlog[] | null>(null);
  const [blogId, setBlogId] = useState("");

  async function loadBlogs() {
    setError(null);
    setBlogs(null);
    setBlogId("");
    setLoading(true);
    const r = await listShopifyBlogsAction(storeUrl.trim(), accessToken.trim());
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setBlogs(r.data);
    if (r.data.length === 0) {
      setError("This store has no blog yet. Create one under Online Store → Blog posts, then reload.");
    }
    if (r.data.length === 1) setBlogId(r.data[0].id);
  }

  const canLoad = storeUrl.trim().length > 0 && accessToken.trim().length > 0 && !loading;

  const step = "flex gap-3";
  const num =
    "shrink-0 w-[22px] h-[22px] rounded-full border border-line bg-panel text-[11.5px] font-medium text-ink-2 grid place-items-center";
  const body = "flex flex-col gap-1 text-[12.5px] text-ink-2 leading-[1.5]";
  const title = "font-medium text-ink";

  return (
    <ol className="flex flex-col gap-3.5">
      <li className={step}>
        <span className={num}>1</span>
        <div className={body}>
          <span className={title}>Before you start</span>
          <span>
            You need to be the store owner, or a staff member with the &ldquo;App development&rdquo;
            permission; collaborator accounts cannot create custom apps. The store needs at least one
            blog (Online Store → Blog posts). <Doc href={DOCS.customApps}>Shopify: custom apps</Doc>
          </span>
        </div>
      </li>

      <li className={step}>
        <span className={num}>2</span>
        <div className={body}>
          <span className={title}>Create a custom app</span>
          <span>
            In the Shopify admin go to Settings → Apps and sales channels → Develop apps, and create an
            app (any name, e.g. &ldquo;AltoRank&rdquo;). Stores that only offer the Dev Dashboard: see step 4
            before continuing. <Doc href={DOCS.installSetup}>Shopify: create and install a custom app</Doc>
          </span>
        </div>
      </li>

      <li className={step}>
        <span className={num}>3</span>
        <div className={body}>
          <span className={title}>Set the Admin API scopes</span>
          <span>Under Configuration → Admin API integration, enable exactly these:</span>
          <ul className="flex flex-wrap gap-1.5 mt-0.5">
            {SHOPIFY_REQUIRED_SCOPES.map((scope) => (
              <li key={scope} className="font-mono text-[12px] px-2 py-0.5 rounded border border-line bg-panel text-ink">
                {scope}
              </li>
            ))}
          </ul>
          <span>
            They cover blogs and articles and nothing else. Changing scopes later means releasing a new
            version and reinstalling the app. <Doc href={DOCS.scopes}>Shopify: access scopes</Doc>
          </span>
        </div>
      </li>

      <li className={step}>
        <span className={num}>4</span>
        <div className={body}>
          <span className={title}>Install the app and copy the token</span>
          <span>
            Install the app on the store, then under API credentials reveal the Admin API access token.
            Shopify shows it once; if it is lost, uninstall and reinstall to get a new one.
          </span>
          <span className="text-ink-3">
            Apps created in the Dev Dashboard (all new custom apps since 1 January 2026) show a Client ID
            and Client secret instead of a token. Their tokens come from a client-credentials exchange
            and expire every 24 hours; this connector does not perform that exchange yet, so it needs a
            legacy custom app&apos;s token. <Doc href={DOCS.clientCredentials}>Shopify: client credentials grant</Doc>
          </span>
        </div>
      </li>

      <li className={step}>
        <span className={num}>5</span>
        <div className={`${body} flex-1`}>
          <span className={title}>Connect the store</span>
          <label className="flex flex-col gap-1.5 mt-1">
            <span className="text-[12.5px] font-medium text-ink-2">Store URL</span>
            <input
              name="storeUrl"
              type="url"
              required
              value={storeUrl}
              onChange={(e) => setStoreUrl(e.target.value)}
              placeholder="https://your-store.myshopify.com"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Admin API access token</span>
            <div className="flex gap-2">
              <input
                name="accessToken"
                type="password"
                required
                autoComplete="off"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="shpat_…"
                className={`${inputClass} flex-1`}
              />
              <Button type="button" disabled={!canLoad} onClick={loadBlogs}>
                {loading ? "Loading…" : blogs ? "Reload" : "Load blogs"}
              </Button>
            </div>
          </label>

          {error && (
            <p role="alert" className="text-[12px] text-[var(--err)] leading-[1.45] whitespace-pre-wrap break-words">
              {error}
            </p>
          )}

          {blogs && blogs.length > 0 ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Blog</span>
              <select
                name="blogId"
                value={blogId}
                onChange={(e) => setBlogId(e.target.value)}
                className={`${inputClass} w-full`}
              >
                <option value="">First blog ({blogs[0].title})</option>
                {blogs.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                    {b.handle ? ` (/blogs/${b.handle})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="text-[11.5px] text-ink-3">
              Articles go to the store&apos;s first blog unless you load the list and choose one.
            </span>
          )}
        </div>
      </li>
    </ol>
  );
}
