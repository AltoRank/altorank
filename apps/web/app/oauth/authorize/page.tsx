import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { loadClient, redirectAllowed } from "@/lib/oauth/clients";
import { parseScopes } from "@/lib/oauth/codes";
import { SCOPE_LABELS, type ApiKeyScope } from "@/lib/agent/api-keys";
import { APP_NAME } from "@/lib/constants";
import { SubmitButton } from "@/components/auth/submit-button";
import { decideAuthorization } from "./actions";

export const metadata: Metadata = { title: "Connect an app" };
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * /oauth/authorize — the consent screen behind the hosted MCP endpoint.
 *
 * A connector (ChatGPT, Claude, Cursor...) sends the person here. They sign
 * in if they have not, see which app is asking and for which account, choose
 * whether it may also write, and approve or deny. Approval mints a
 * ten-minute code the app trades for a token at /api/oauth/token.
 *
 * Errors in the request itself (unknown client, redirect_uri not registered)
 * are shown here and never bounced to the redirect_uri: an unverified
 * redirect target is exactly what must not receive anything.
 */
export default async function AuthorizePage(props: { searchParams: Promise<Params> }) {
  const sp = await props.searchParams;
  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const state = one(sp.state);
  const codeChallenge = one(sp.code_challenge);
  const method = one(sp.code_challenge_method) || "S256";
  const responseType = one(sp.response_type) || "code";
  const scopeRaw = one(sp.scope);

  if (one(sp.error) === "bad_client") return <Problem title="That app is not registered">{"The connector sent an invalid client id or redirect address. Remove the connector in the app and add it again."}</Problem>;

  const service = createServiceClient();
  const client = clientId ? await loadClient(service, clientId) : null;
  if (!client) return <Problem title="Unknown app">{"No app is registered with that client id. Remove the connector in the app and add it again; registration happens automatically."}</Problem>;
  if (!redirectUri || !redirectAllowed(client, redirectUri)) {
    return <Problem title="Redirect address not registered">{`${client.client_name} asked to send you to an address it did not register. Nothing was sent there.`}</Problem>;
  }

  const bounce = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    redirect(url.toString());
  };
  if (responseType !== "code") bounce("unsupported_response_type", "Only response_type=code is supported.");
  if (method !== "S256" || !/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) bounce("invalid_request", "PKCE with S256 is required.");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const here = new URL("/oauth/authorize", "http://x");
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string") here.searchParams.set(k, v);
    redirect(`/signin?next=${encodeURIComponent(here.pathname + here.search)}`);
  }

  let agencyName = "";
  let canDecide = true;
  try {
    const { agencyId } = await requireAuth(["owner", "admin"]);
    const { data: agency } = await supabase.from("agencies").select("name").eq("id", agencyId).single();
    agencyName = agency?.name ?? "your account";
  } catch {
    canDecide = false;
  }

  const { scopes: requested, unknown } = parseScopes(scopeRaw);
  // Deny is a plain link: no action needed to send nothing.
  const denyUrl = (() => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (state) url.searchParams.set("state", state);
    return url.toString();
  })();
  const wantsWrite = requested.includes("write");
  const fixed: ApiKeyScope[] = requested.filter((s) => s !== "write");

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Connect {client.client_name}</h1>
        <p className="mt-2 text-sm text-ink-3">
          {client.client_name} wants to use {APP_NAME}
          {agencyName ? ` for ${agencyName}` : ""} on your behalf.
        </p>
      </div>

      {!canDecide ? (
        <Problem title="An owner or admin has to approve this">
          {"You are signed in, but only an owner or admin of the account can connect an app. Ask one of them to open this same link."}
        </Problem>
      ) : (
        <form action={decideAuthorization} className="space-y-4">
          <input type="hidden" name="client_id" value={client.id} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="code_challenge" value={codeChallenge} />
          <input type="hidden" name="scope" value={requested.join(" ")} />

          <div className="rounded-lg border border-line bg-bg p-3 text-[13px] space-y-2">
            <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">It will be able to</p>
            <ul className="space-y-1">
              {fixed.map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-accent" />
                  {SCOPE_LABELS[s]}
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2 pt-1">
              <input type="checkbox" name="allow_write" defaultChecked={wantsWrite} className="mt-0.5" />
              <span>
                {SCOPE_LABELS.write}
                <span className="block text-ink-3">
                  Move planned keywords, find-and-replace in drafts, retry a failed publish, pause or resume a site.
                  {wantsWrite ? " The app asked for this." : " The app did not ask for this."}
                </span>
              </span>
            </label>
            <p className="text-ink-3 pt-1">
              It can never publish, approve or delete anything: the API has no such call. Drafts it generates wait in
              your review queue.
            </p>
            {unknown.length > 0 && (
              <p className="text-ink-3">Ignored unknown scopes: {unknown.join(", ")}.</p>
            )}
          </div>

          <p className="text-[12px] text-ink-3">
            This creates an API key named &ldquo;{`${client.client_name} (connector)`}&rdquo; that expires in 90 days.
            Revoke it any time under Settings → API keys, which disconnects the app.
          </p>

          <input type="hidden" name="decision" value="approve" />
          <div className="flex gap-2">
            <a
              href={denyUrl}
              className="flex-1 px-3 py-2 rounded-[7px] border border-line text-[13px] text-center hover:bg-bg-2"
            >
              Deny
            </a>
            <SubmitButton
              pendingLabel="Connecting…"
              className="flex-1 py-2 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors cursor-pointer disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              Approve
            </SubmitButton>
          </div>
        </form>
      )}

      <p className="text-center text-[12px] text-ink-3">
        Not you? <Link href="/signin" className="text-accent">Sign in as someone else</Link>
      </p>
    </div>
  );
}

function Problem({ title, children }: { title: string; children: string }) {
  return (
    <div className="space-y-3 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-ink-3">{children}</p>
      <Link href="/dashboard" className="inline-block text-sm text-accent">
        Back to {APP_NAME}
      </Link>
    </div>
  );
}
