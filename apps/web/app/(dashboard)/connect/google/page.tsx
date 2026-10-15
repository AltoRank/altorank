import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { listDetectedProperties } from "@/app/actions/google-properties";
import { PropertyPicker } from "./property-picker";
import { GoogleDisconnectButton } from "@/components/dashboard/google-disconnect-button";

export const metadata: Metadata = { title: "Choose your sites" };

/**
 * An account-level Search Console connect. A plain link, not next/link: the
 * route answers with a redirect to Google's screen and sets the OAuth nonce,
 * which a prefetch should not do.
 */
const CONNECT_HREF = "/api/auth/google?integrationId=gsc";

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
              <a href={CONNECT_HREF} className="text-accent-ink underline decoration-line underline-offset-[3px]">
                Connect one
              </a>{" "}
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
        {/* Once a consent is stored, this page stops offering Google's
            screen, and the account chosen first is often not the one that
            owns the site. The way back in, whatever the page shows. */}
        {connected && (
          <p className="mt-4 text-center text-[12.5px] text-ink-3">
            Not the Google account that owns your site?{" "}
            <a href={CONNECT_HREF} className="text-accent-ink underline decoration-line underline-offset-[3px]">
              Use a different Google account
            </a>
          </p>
        )}
        {connected && (
          <div className="mt-2 flex justify-center">
            <GoogleDisconnectButton className="justify-center" />
          </div>
        )}
      </div>
    </>
  );
}
