import type { Metadata } from "next";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { readHoldParams } from "@/lib/publishing/hold-link";
import { resolveEmailHold } from "@/lib/publishing/hold-from-email";
import { appLink } from "@/lib/app-url";
import { holdFromEmail } from "./actions";

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
 * The GET only asks. It used to write the hold while rendering, and mail
 * security scanners fetch every link in an inbound message before anyone reads
 * it, so on a corporate tenant every auto-approve draft was held by a robot
 * (lib/publishing/hold-from-email.ts). The write is the "Hold it" button's
 * POST (./actions.ts), which checks the signature and the draft again.
 *
 * The hold is recorded against the person: `held_by` is the member whose
 * address was in the link. A draft held here stays in review until someone
 * approves or archives it in the dashboard; the automatic rule skips it.
 */

export const metadata: Metadata = { title: "Hold this draft", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ a?: string; e?: string; s?: string; failed?: string }> };

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

  // Nothing is written here: a GET is a read, and link scanners make them.
  const hold = await resolveEmailHold(createServiceClient(), parsed.articleId, parsed.email);
  const draftHref = appLink(`/content/${parsed.articleId}`);

  if (hold.kind === "missing") {
    return (
      <Shell title="That draft no longer exists">
        <p className="text-[14px] leading-relaxed text-ink-2">Nothing was changed.</p>
      </Shell>
    );
  }

  if (hold.kind === "not-member") {
    return (
      <Shell title="This link is not yours to use">
        <p className="text-[14px] leading-relaxed text-ink-2">
          The address in the link is no longer on this account, so nothing was changed.
        </p>
      </Shell>
    );
  }

  if (hold.kind === "not-review") {
    return (
      <Shell title="Too late to hold it">
        <p className="text-[14px] leading-relaxed text-ink-2">
          &ldquo;{hold.title}&rdquo; is no longer in review (it is {hold.status}), so a hold would change nothing.
        </p>
        <Link href={draftHref} className="text-[13px] text-accent-ink underline decoration-line underline-offset-[3px]">
          Open the article
        </Link>
      </Shell>
    );
  }

  if (hold.kind === "held") {
    return (
      <Shell title="Held">
        <p className="text-[14px] leading-relaxed text-ink-2">
          &ldquo;{hold.title}&rdquo;{hold.domain ? ` for ${hold.domain}` : ""} will not publish on its own. It stays in
          review until someone approves it or archives it.
        </p>
        <Link href={draftHref} className="text-[13px] text-accent-ink underline decoration-line underline-offset-[3px]">
          Read the draft
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="Hold this draft?">
      <p className="text-[14px] leading-relaxed text-ink-2">
        Press the button and &ldquo;{hold.title}&rdquo;{hold.domain ? ` for ${hold.domain}` : ""} will not publish on
        its own. It stays in review until someone approves it or archives it. Nothing has changed yet.
      </p>
      {sp.failed && (
        <p className="text-[13px] leading-relaxed text-[var(--err)]">
          The hold could not be recorded. Try again, or hold it from the dashboard.
        </p>
      )}
      <form action={holdFromEmail}>
        <input type="hidden" name="a" value={parsed.articleId} />
        <input type="hidden" name="e" value={parsed.email} />
        <input type="hidden" name="s" value={sp.s ?? ""} />
        <button
          type="submit"
          className="w-full rounded-[8px] bg-ink px-4 py-2.5 text-[13px] font-medium text-bg hover:opacity-90 cursor-pointer"
        >
          Hold it
        </button>
      </form>
      <Link href={draftHref} className="text-[13px] text-accent-ink underline decoration-line underline-offset-[3px]">
        Read the draft first
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
