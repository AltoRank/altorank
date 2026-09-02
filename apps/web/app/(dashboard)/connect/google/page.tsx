import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { listDetectedProperties } from "@/app/actions/google-properties";
import { PropertyPicker } from "./property-picker";

export const metadata: Metadata = { title: "Choose your sites" };

/**
 * What Google says this account can see, and which of it to work on.
 *
 * Connecting used to link whatever matched an existing workspace and silently
 * ignore the rest, so an account owning eight properties never learned that
 * (2026-09-02). Choosing here is what creates the workspaces.
 */
export default async function GooglePropertiesPage() {
  const { connected, properties, error } = await listDetectedProperties();

  return (
    <>
      <PageHead
        title="Choose your sites"
        backHref="/connect"
        backLabel="Back to integrations"
        subtitle={<span>Search Console properties this Google account can see</span>}
      />
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {!connected ? (
          <Card>
            <div className="px-6 py-12 text-center text-[13.5px] text-ink-3">
              No Google account is connected yet.{" "}
              <Link href="/api/auth/google?integrationId=gsc" className="text-accent-ink underline decoration-line underline-offset-[3px]">
                Connect one
              </Link>{" "}
              and this page lists what it can see.
            </div>
          </Card>
        ) : error ? (
          <Card>
            <div className="px-6 py-10 text-center text-[13.5px] text-err-ink">{error}</div>
          </Card>
        ) : properties.length === 0 ? (
          <Card>
            <div className="mx-auto max-w-[52ch] px-6 py-10 text-center text-[13.5px] leading-relaxed text-ink-3">
              This Google account has no Search Console properties. Add your site in Search
              Console and verify it, then come back. Verifying is what makes you the owner;
              being able to sign in to the site is not the same thing to Google.
            </div>
          </Card>
        ) : (
          <PropertyPicker properties={properties} />
        )}
      </div>
    </>
  );
}
