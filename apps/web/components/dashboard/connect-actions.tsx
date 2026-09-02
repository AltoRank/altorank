"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { connectIntegration, deriveBlogUrl } from "@/app/actions/integrations";
import type { Workspace, Integration, CMSConfig } from "@/lib/types";
import type { BlogUrlDerivation } from "@/lib/cms/blog-url";

type CMSType =
  | "wordpress"
  | "shopify"
  | "magento"
  | "webflow"
  | "ghost"
  | "framer"
  | "wix"
  | "notion"
  | "hubspot"
  | "woocommerce"
  | "webhook"
  | "git";

interface ConnectActionsProps {
  workspaces: Workspace[];
  integrations: Integration[];
}

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

function Field({
  name,
  label,
  type = "text",
  placeholder,
  required = true,
}: {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        className={inputClass}
      />
    </label>
  );
}

export function ConnectActions({ workspaces, integrations }: ConnectActionsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [cmsType, setCmsType] = useState<CMSType>("wordpress");
  const [detecting, setDetecting] = useState(false);
  const [derivation, setDerivation] = useState<BlogUrlDerivation | null>(null);
  const onboarding = useOnboarding();
  const router = useRouter();

  // Find the integration row matching the selected CMS type
  const cmsIntegrations = integrations.filter((i) => i.tag === "CMS");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      const workspaceId = fd.get("workspace_id") as string;

      /**
       * Find the integrations row for this platform.
       *
       * This used to fall back to cmsIntegrations[0] when nothing matched,
       * which does not fail - publishArticleCore resolves the adapter from
       * config.type, so it would publish correctly - it just files the
       * connection under the wrong platform and names that one back at you
       * forever. A missing row is a seeding bug, so say so instead.
       */
      const match = cmsIntegrations.find((i) =>
        i.id === cmsType || i.name.toLowerCase().includes(cmsType)
      );
      if (!match) {
        throw new Error(
          `No integration is registered for "${cmsType}". This is a setup problem, not something you did.`,
        );
      }
      const integrationId = match.id;

      const config = buildConfig(cmsType, fd);

      await connectIntegration(workspaceId, integrationId, config);
      setOpen(false);
      onboarding?.completeStep("connect-cms");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect CMS");
    } finally {
      setPending(false);
    }
  }

  const tabs: { value: CMSType; label: string }[] = [
    { value: "wordpress", label: "WordPress" },
    { value: "shopify", label: "Shopify" },
    { value: "magento", label: "Magento" },
    { value: "webflow", label: "Webflow" },
    { value: "ghost", label: "Ghost" },
    { value: "framer", label: "Framer" },
    { value: "wix", label: "Wix" },
    { value: "notion", label: "Notion" },
    { value: "hubspot", label: "HubSpot" },
    { value: "woocommerce", label: "WooCommerce" },
    { value: "webhook", label: "Webhook" },
    { value: "git", label: "Git / static site" },
  ];

  return (
    <>
      <Button
        variant="accent"
        data-onboarding="connect-cms"
        onClick={() => setOpen(true)}
      >
        <Icons.plus size={14} />
        New connection
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Connect CMS"
        description="Link a content management system to publish directly."
      >
        {/* CMS type tabs — scrollable */}
        <div className="flex gap-0 border-b border-line mb-4 -mx-5 px-5 overflow-x-auto scrollbar-none">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setCmsType(tab.value)}
              className={`px-3 py-2 text-[13px] border-b-2 -mb-px cursor-pointer transition-colors whitespace-nowrap ${
                cmsType === tab.value
                  ? "text-ink border-b-ink font-medium"
                  : "text-ink-3 border-transparent hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form id="cms-connect-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
            <select
              name="workspace_id"
              required
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>

          {cmsType === "wordpress" && (
            <>
              <Field name="siteUrl" label="Site URL" placeholder="https://example.com" />
              <Field name="username" label="Username" />
              <Field name="applicationPassword" label="Application password" type="password" />
            </>
          )}

          {cmsType === "shopify" && (
            <>
              <Field name="storeUrl" label="Store URL" placeholder="https://store.myshopify.com" />
              <Field name="accessToken" label="Access token" type="password" />
            </>
          )}

          {cmsType === "magento" && (
            <>
              <p className="text-[12px] text-ink-3 -mt-1 mb-1">
                Creates static CMS pages on your storefront (e.g. /your-slug), not blog posts.
              </p>
              <Field name="baseUrl" label="Base URL" placeholder="https://magento.example.com" />
              <Field name="adminToken" label="Admin token" type="password" />
            </>
          )}

          {cmsType === "webflow" && (
            <>
              <Field name="siteId" label="Site ID" placeholder="e.g. 6287ec36a..." />
              <Field name="collectionId" label="Collection ID" placeholder="e.g. 6287ec36b..." />
              <Field name="apiToken" label="API token" type="password" />
            </>
          )}

          {cmsType === "ghost" && (
            <>
              <Field name="apiUrl" label="Ghost URL" placeholder="https://your-blog.ghost.io" />
              <Field name="adminApiKey" label="Admin API key" type="password" placeholder="id:secret" />
            </>
          )}

          {cmsType === "framer" && (
            <>
              <Field name="siteId" label="Site ID" />
              <Field name="collectionId" label="Collection ID" />
              <Field name="apiToken" label="API token" type="password" />
            </>
          )}

          {cmsType === "wix" && (
            <>
              <Field name="accountId" label="Account ID" />
              <Field name="siteId" label="Site ID" />
              <Field name="apiKey" label="API key" type="password" />
            </>
          )}

          {cmsType === "notion" && (
            <>
              <Field name="databaseId" label="Database ID" placeholder="e.g. a1b2c3d4..." />
              <Field name="integrationToken" label="Integration token" type="password" placeholder="secret_..." />
            </>
          )}

          {cmsType === "hubspot" && (
            <>
              <Field name="accessToken" label="Access token" type="password" />
              <Field name="blogId" label="Blog ID (optional)" required={false} />
            </>
          )}

          {cmsType === "woocommerce" && (
            <>
              <p className="text-[12px] text-ink-3 -mt-1 mb-1">
                Uses the WordPress REST API — same as WordPress but for WooCommerce stores.
              </p>
              <Field name="siteUrl" label="Site URL" placeholder="https://shop.example.com" />
              <Field name="username" label="Username" />
              <Field name="applicationPassword" label="Application password" type="password" />
            </>
          )}

          {cmsType === "webhook" && (
            <>
              <p className="text-[12px] text-ink-3 -mt-1 mb-1">
                POST article data to any URL. Optionally sign payloads with HMAC-SHA256.
              </p>
              <Field name="url" label="Webhook URL" placeholder="https://your-api.com/publish" />
              <Field name="secret" label="Signing secret (optional)" type="password" required={false} />
            </>
          )}

          {cmsType === "git" && (
            <>
              <p className="text-[12px] text-ink-3 -mt-1 mb-1">
                For sites built from a repository (Astro, Next, Hugo, Jekyll,
                Eleventy). Articles are committed as Markdown; your host builds
                and deploys them.
              </p>
              <Field name="owner" label="Repo owner" placeholder="acme" />
              <Field name="repo" label="Repository" placeholder="website" />
              <Field name="branch" label="Branch" placeholder="main" />
              <Field
                name="contentPath"
                label="Content directory"
                placeholder="src/content/blog"
              />
              <Field
                name="token"
                label="GitHub token (contents:write)"
                type="password"
              />

              {/*
                The public URL is the half that used to be guessed. Detection
                reads it off the site's own sitemap, so what lands in the field
                is a prefix that real published posts already use - and the
                evidence line below says which ones.
              */}
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Field
                    name="publicBaseUrl"
                    label="Public URL of your blog"
                    placeholder="https://example.com/blog"
                    required={false}
                  />
                </div>
                <Button
                  type="button"
                  disabled={detecting}
                  onClick={async () => {
                    const form = document.getElementById(
                      "cms-connect-form",
                    ) as HTMLFormElement | null;
                    const field = form?.elements.namedItem(
                      "publicBaseUrl",
                    ) as HTMLInputElement | null;
                    const seed = field?.value?.trim();
                    if (!seed) {
                      toast.error("Enter your site URL first, e.g. https://example.com");
                      return;
                    }
                    setDetecting(true);
                    try {
                      const found = await deriveBlogUrl(seed);
                      if (!found) {
                        setDerivation(null);
                        toast.error(
                          "No posts found in that site's sitemap. Enter the blog URL by hand.",
                        );
                        return;
                      }
                      if (field) field.value = found.baseUrl;
                      setDerivation(found);
                    } catch {
                      toast.error("Could not read that site");
                    } finally {
                      setDetecting(false);
                    }
                  }}
                >
                  {detecting ? "Reading..." : "Detect"}
                </Button>
              </div>

              <input
                type="hidden"
                name="trailingSlash"
                value={String(derivation?.trailingSlash ?? false)}
              />

              {derivation && (
                <p
                  className={
                    derivation.confidence === "high"
                      ? "text-[12px] text-ink-3 -mt-1"
                      : "text-[12px] text-amber-600 -mt-1"
                  }
                >
                  {derivation.evidence}. Example: {derivation.samples[0]}
                </p>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Connecting..." : "Connect"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Config builder — extracts form data into typed CMSConfig
// ---------------------------------------------------------------------------

function buildConfig(type: CMSType, fd: FormData): CMSConfig {
  switch (type) {
    case "wordpress":
      return {
        type: "wordpress",
        siteUrl: fd.get("siteUrl") as string,
        username: fd.get("username") as string,
        applicationPassword: fd.get("applicationPassword") as string,
      };
    case "shopify":
      return {
        type: "shopify",
        storeUrl: fd.get("storeUrl") as string,
        accessToken: fd.get("accessToken") as string,
      };
    case "magento":
      return {
        type: "magento",
        baseUrl: fd.get("baseUrl") as string,
        adminToken: fd.get("adminToken") as string,
      };
    case "webflow":
      return {
        type: "webflow",
        siteId: fd.get("siteId") as string,
        collectionId: fd.get("collectionId") as string,
        apiToken: fd.get("apiToken") as string,
      };
    case "ghost":
      return {
        type: "ghost",
        apiUrl: fd.get("apiUrl") as string,
        adminApiKey: fd.get("adminApiKey") as string,
      };
    case "framer":
      return {
        type: "framer",
        siteId: fd.get("siteId") as string,
        collectionId: fd.get("collectionId") as string,
        apiToken: fd.get("apiToken") as string,
      };
    case "wix":
      return {
        type: "wix",
        accountId: fd.get("accountId") as string,
        siteId: fd.get("siteId") as string,
        apiKey: fd.get("apiKey") as string,
      };
    case "notion":
      return {
        type: "notion",
        databaseId: fd.get("databaseId") as string,
        integrationToken: fd.get("integrationToken") as string,
      };
    case "hubspot":
      return {
        type: "hubspot",
        accessToken: fd.get("accessToken") as string,
        ...(fd.get("blogId") ? { blogId: fd.get("blogId") as string } : {}),
      };
    case "woocommerce":
      return {
        type: "woocommerce",
        siteUrl: fd.get("siteUrl") as string,
        username: fd.get("username") as string,
        applicationPassword: fd.get("applicationPassword") as string,
      };
    case "webhook":
      return {
        type: "webhook",
        url: fd.get("url") as string,
        ...(fd.get("secret") ? { secret: fd.get("secret") as string } : {}),
      };
    case "git": {
      const base = (fd.get("publicBaseUrl") as string | null)?.trim();
      return {
        type: "git",
        provider: "github",
        token: fd.get("token") as string,
        owner: fd.get("owner") as string,
        repo: fd.get("repo") as string,
        branch: fd.get("branch") as string,
        contentPath: fd.get("contentPath") as string,
        ...(base
          ? {
              publicBaseUrl: base,
              // Carried from detection rather than inferred here: whether a
              // site's post URLs end in "/" is a fact about the site, read off
              // its sitemap, and guessing it is what this change removed.
              trailingSlash: (fd.get("trailingSlash") as string) === "true",
            }
          : {}),
      };
    }
  }
}
