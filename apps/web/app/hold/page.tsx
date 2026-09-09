import type { Metadata } from "next";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { readHoldParams } from "@/lib/publishing/hold-link";
import { appLink } from "@/lib/app-url";

/**
 * The page the "Hold this one" link in a drafted email opens.
 *
 * Public and sessionless on purpose, like /unsubscribe: the draft ships after
 * the hold window unless somebody stops it, and "somebody" is reading the mail
 * on a phone. What makes that safe is the signature in the URL
 * (lib/publishing/hold-link.ts), which binds the article id to the address the
 * mail was sent to, so it cannot hold a draft on an account the holder is not
 * on - and the address is then checked against the article's account before
 * anything is written.
 *
 * The hold is recorded against the person: `held_by` is the member whose
 * address was in the link. A draft held here stays in review until someone
 * approves or archives it in the dashboard; the automatic rule skips it.
 */

export const metadata: Metadata = { title: "Hold this draft", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ a?: string; e?: string; s?: string }> };

export default async function HoldPage(props: Props) {
  const sp = await props.searchParams;
  const parsed = readHoldParams(new URLSearchParams({ a: sp.a ?? "", e: sp.e ?? "", s: sp.s ?? "" }));

  if (!parsed.ok) {
    return (
      <Shell title="That link did not work">
        <p className="text-[14px] leading-relaxed text-ink-2">{parsed.reason}</p>
        <p className="text-[13px] leading-relaxed text-ink-3">
          You can still hold the draft from the dashboard: open it and press Hold.
        </p>
      </Shell>
    );
  }

  const supabase = createServiceClient();
  const { data: article } = await supabase
    .from("articles")
    .select("id, title, status, held_by, workspace_id, workspaces(account_id, domain)")
    .eq("id", parsed.articleId)
    .maybeSingle();

  if (!article) {
    return (
      <Shell title="That draft no longer exists">
        <p className="text-[14px] leading-relaxed text-ink-2">Nothing was changed.</p>
      </Shell>
    );
  }

  const ws = (Array.isArray(article.workspaces) ? article.workspaces[0] : article.workspaces) as
    | { account_id: string; domain: string | null }
    | null;

  // The link's address must belong to a member of the article's account. The
  // addresses live in auth.users, which PostgREST does not expose, so this is
  // the same walk accountRecipients makes, in reverse: one lookup per member
  // until the address matches.
  let holder: string | null = null;
  if (ws) {
    const { data: members } = await supabase.from("account_members").select("user_id").eq("account_id", ws.account_id);
    for (const m of members ?? []) {
      const { data } = await supabase.auth.admin.getUserById(m.user_id as string);
      if (data?.user?.email?.trim().toLowerCase() === parsed.email) {
        holder = m.user_id as string;
        break;
      }
    }
  }
  if (!holder) {
    return (
      <Shell title="This link is not yours to use">
        <p className="text-[14px] leading-relaxed text-ink-2">
          The address in the link is no longer on this account, so nothing was changed.
        </p>
      </Shell>
    );
  }

  const draftHref = appLink(`/content/${article.id}`);
  const title = (article.title as string) || "this draft";

  if (article.status !== "review") {
    return (
      <Shell title="Too late to hold it">
        <p className="text-[14px] leading-relaxed text-ink-2">
          &ldquo;{title}&rdquo; is no longer in review (it is {String(article.status)}), so a hold would change nothing.
        </p>
        <Link href={draftHref} className="text-[13px] text-accent-ink underline decoration-line underline-offset-[3px]">
          Open the article
        </Link>
      </Shell>
    );
  }

  if (!article.held_by) {
    const { error } = await supabase
      .from("articles")
      .update({
        held_by: holder,
        held_at: new Date().toISOString(),
        auto_approve_hold_reason: "held by a person",
        updated_at: new Date().toISOString(),
      })
      .eq("id", article.id)
      .eq("status", "review")
      .is("held_by", null);
    if (error) {
      return (
        <Shell title="Could not record the hold">
          <p className="text-[14px] leading-relaxed text-ink-2">{error.message}</p>
        </Shell>
      );
    }
  }

  return (
    <Shell title="Held">
      <p className="text-[14px] leading-relaxed text-ink-2">
        &ldquo;{title}&rdquo;{ws?.domain ? ` for ${ws.domain}` : ""} will not publish on its own. It stays in review
        until someone approves it or archives it.
      </p>
      <Link href={draftHref} className="text-[13px] text-accent-ink underline decoration-line underline-offset-[3px]">
        Read the draft
      </Link>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
      {children}
    </main>
  );
}
