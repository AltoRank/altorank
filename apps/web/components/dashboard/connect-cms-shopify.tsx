"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { listShopifyBlogsAction } from "@/app/actions/integrations";
import { SHOPIFY_REQUIRED_SCOPES, type ShopifyBlog } from "@/lib/cms/shopify";
import type { ShopifyCredentials } from "@/lib/types";

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

const DOCS = {
  customApps: "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
  installSetup: "https://help.shopify.com/en/manual/apps/install-setup-apps",
  scopes: "https://shopify.dev/docs/api/usage/access-scopes",
  clientCredentials:
    "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant",
};

/**
 * Which credential the form is collecting. `client` is the default because it
 * is the only kind a store created after 1 January 2026 can produce.
 */
export type ShopifyCredentialMode = "client" | "token";

/**
 * Reads the credential off the submitted form. Only the active mode's inputs
 * are rendered, so exactly one credential is present; the server checks that
 * again through `shopifyCredential` and the form need not repeat the rule.
 */
export function shopifyCredentialsFromForm(fd: FormData): ShopifyCredentials {
  const clientId = fd.get("clientId");
  const clientSecret = fd.get("clientSecret");
  if (typeof clientId === "string" && typeof clientSecret === "string") {
    return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  }
  return { accessToken: ((fd.get("accessToken") as string | null) ?? "").trim() };
}

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
 * A custom app is the only way into one store's Admin API, and making one
 * takes five screens of Shopify's admin. The steps are written out, numbered
 * and always visible, with the scopes read from the adapter so the list here
 * can never drift from the calls it makes. No screenshots: Shopify moves its
 * admin around, and a stale picture is worse than a sentence. Every step
 * links the page it paraphrases.
 *
 * Step 4 and 5 know two kinds of app. Apps created in the Dev Dashboard
 * (every new one since 1 January 2026) hand out a Client ID and secret, and
 * the connector exchanges those for a token itself; legacy custom apps show
 * an Admin API access token once. Both feed the same "Load blogs" and the
 * same server actions.
 *
 * Step 5 is the form. Once the store answers, its blogs are listed and one
 * can be chosen; leaving it unchosen keeps the adapter's default (the first
 * blog), which is what every connection did before.
 */
export function ShopifyGuide() {
  const [storeUrl, setStoreUrl] = useState("");
  const [mode, setMode] = useState<ShopifyCredentialMode>("client");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blogs, setBlogs] = useState<ShopifyBlog[] | null>(null);
  const [blogId, setBlogId] = useState("");

  const credentials: ShopifyCredentials =
    mode === "client"
      ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
      : { accessToken: accessToken.trim() };

  const credentialsComplete =
    mode === "client" ? clientId.trim().length > 0 && clientSecret.trim().length > 0 : accessToken.trim().length > 0;

  function switchMode(next: ShopifyCredentialMode) {
    setMode(next);
    setError(null);
    setBlogs(null);
    setBlogId("");
  }

  async function loadBlogs() {
    setError(null);
    setBlogs(null);
    setBlogId("");
    setLoading(true);
    const r = await listShopifyBlogsAction(storeUrl.trim(), credentials);
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

  const canLoad = storeUrl.trim().length > 0 && credentialsComplete && !loading;

  const step = "flex gap-3";
  const num =
    "shrink-0 w-[22px] h-[22px] rounded-full border border-line bg-panel text-[11.5px] font-medium text-ink-2 grid place-items-center";
  const body = "flex flex-col gap-1 text-[12.5px] text-ink-2 leading-[1.5]";
  const title = "font-medium text-ink";
  const modeOption = (active: boolean) =>
    `flex gap-2.5 items-start rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
      active ? "border-ink bg-panel" : "border-line hover:border-ink-4"
    }`;

  const loadButton = (
    <Button type="button" disabled={!canLoad} onClick={loadBlogs}>
      {loading ? "Loading…" : blogs ? "Reload" : "Load blogs"}
    </Button>
  );

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
            Since 1 January 2026 custom apps are created in Shopify&apos;s Dev Dashboard, in the same
            organisation as the store, and installed on it from there. Older stores may still have
            Settings → Apps and sales channels → Develop apps in the admin; that path works too. Any
            name will do, e.g. &ldquo;AltoRank&rdquo;.{" "}
            <Doc href={DOCS.installSetup}>Shopify: create and install a custom app</Doc>
          </span>
        </div>
      </li>

      <li className={step}>
        <span className={num}>3</span>
        <div className={body}>
          <span className={title}>Set the Admin API scopes</span>
          <span>Under the app&apos;s Admin API access scopes, enable exactly these:</span>
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
          <span className={title}>Install the app and copy its credentials</span>
          <span>
            Install the app on the store. A Dev Dashboard app shows a Client ID and a Client secret
            under its settings; paste both below. The connector exchanges them for an Admin API token
            through Shopify&apos;s client-credentials grant and refreshes it before each 24-hour expiry,
            so nothing needs re-entering. The secret is stored encrypted and never shown again.{" "}
            <Doc href={DOCS.clientCredentials}>Shopify: client credentials grant</Doc>
          </span>
          <span className="text-ink-3">
            A legacy custom app (created in the admin before 2026) shows an Admin API access token
            instead, once. Choose that mode below and paste the token; if it is lost, uninstall and
            reinstall the app to get a new one.
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

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[12.5px] font-medium text-ink-2 mb-1.5">Credentials</legend>
            <label className={modeOption(mode === "client")}>
              <input
                type="radio"
                name="shopifyCredentialMode"
                value="client"
                checked={mode === "client"}
                onChange={() => switchMode("client")}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-ink">
                  Client ID + secret{" "}
                  <span className="font-normal text-ink-3">— Dev Dashboard apps, all new stores</span>
                </span>
                <span className="text-[12px] text-ink-3 leading-[1.45]">
                  The connector fetches and refreshes the token itself.
                </span>
              </span>
            </label>
            <label className={modeOption(mode === "token")}>
              <input
                type="radio"
                name="shopifyCredentialMode"
                value="token"
                checked={mode === "token"}
                onChange={() => switchMode("token")}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-ink">
                  Admin API access token{" "}
                  <span className="font-normal text-ink-3">— legacy custom app</span>
                </span>
                <span className="text-[12px] text-ink-3 leading-[1.45]">
                  The shpat_… token the admin showed once when the app was installed.
                </span>
              </span>
            </label>
          </fieldset>

          {mode === "client" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-ink-2">Client ID</span>
                <input
                  name="clientId"
                  type="text"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-ink-2">Client secret</span>
                <div className="flex gap-2">
                  <input
                    name="clientSecret"
                    type="password"
                    required
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="shpss_…"
                    className={`${inputClass} flex-1`}
                  />
                  {loadButton}
                </div>
              </label>
            </>
          ) : (
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
                {loadButton}
              </div>
            </label>
          )}

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
