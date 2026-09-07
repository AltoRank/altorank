import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { readUnsubscribeParams } from "@/lib/email/unsubscribe";
import { ALL_OPTIONAL, EMAIL_CATEGORIES, isEmailCategory, type EmailCategory } from "@/lib/email/categories";
import {
  optionalCategories,
  readUnsubscribed,
  resubscribeAddress,
  unsubscribeAddress,
} from "@/lib/email/preferences";

/**
 * The page the "Stop these emails" link in a footer opens.
 *
 * Public and sessionless on purpose: somebody who wants the mail to stop
 * should not have to remember a password first, and the whole point of an
 * unsubscribe link is that it works from the inbox. What makes that safe is
 * the signature in the URL (lib/email/unsubscribe.ts) - it binds the address
 * and the category to a server secret, so this cannot be used to silence
 * somebody else's mail.
 *
 * The GET only asks. It used to be the unsubscribe itself, on the reasoning
 * that somebody who pressed "stop" has already decided and a second button is a
 * dark pattern with an apology attached. That reasoning holds for a person and
 * fails for the inbox they are in: Microsoft Defender Safe Links, Proofpoint URL
 * Defense, Mimecast and Barracuda all fetch every link in an inbound message
 * before the recipient sees it, so on a corporate tenant the opt-out fired
 * before anybody read the mail. The auditor reproduced it by accident with one
 * `curl` while checking the link resolved. For a product selling to agencies on
 * Microsoft 365 that is not theoretical, and a scanner deciding what mail
 * somebody receives is worse than one extra press.
 *
 * So the write lives on the POST - the server action behind these buttons - and
 * the confirm is one press on a page that names the category and the address.
 * Gmail's one-click button is unaffected: RFC 8058 sends that to
 * POST /api/unsubscribe, which is where the RFC puts it and where it stays.
 *
 * It is a preferences page, not a dead end: everything optional is listed with
 * a switch, so a change is one press from undone.
 *
 * The required categories are named at the bottom, with the reason they have
 * no switch. Leaving them off the page entirely would make the list read as a
 * lie the first time a failed-payment notice arrived.
 */

export const metadata: Metadata = { title: "Email preferences", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ e?: string; c?: string; s?: string; done?: string }>;
};

export default async function UnsubscribePage(props: Props) {
  const sp = await props.searchParams;
  const params = new URLSearchParams({ e: sp.e ?? "", c: sp.c ?? "", s: sp.s ?? "" });
  const parsed = readUnsubscribeParams(params);

  if (!parsed.ok) {
    return (
      <Shell title="That link did not work">
        <p className="text-[14px] leading-relaxed text-ink-2">{parsed.reason}</p>
        <p className="text-[13px] leading-relaxed text-ink-3">
          Every email we send carries a fresh one in its footer. If none of them work, reply to any
          email from us and we will switch it off by hand.
        </p>
      </Shell>
    );
  }

  const { email, category } = parsed;
  const supabase = createServiceClient();

  // Nothing is written here. A GET is a read, and this URL is fetched by link
  // scanners before the recipient has seen the message.
  const off = new Set(await readUnsubscribed(supabase, email).catch(() => []));
  const allOff = off.has(ALL_OPTIONAL);
  // `done` marks the render after a switch was toggled, so the page says
  // "Saved" rather than asking again for something already decided.
  const alreadyOff = allOff || off.has(category);

  async function toggle(formData: FormData) {
    "use server";
    const target = String(formData.get("category") ?? "");
    const wanted = formData.get("wanted") === "1";
    const address = String(formData.get("email") ?? "");
    const sig = String(formData.get("s") ?? "");
    const linkCategory = String(formData.get("c") ?? "");

    // Re-verify the signature on the write path. The hidden fields come from
    // the browser, so the form is exactly as forgeable as the URL was, and
    // only the HMAC makes either one authorisation.
    const check = readUnsubscribeParams(new URLSearchParams({ e: address, c: linkCategory, s: sig }));
    if (!check.ok) return;
    if (target !== ALL_OPTIONAL && !isEmailCategory(target)) return;

    const client = createServiceClient();
    const t = target as EmailCategory | typeof ALL_OPTIONAL;
    if (wanted) await resubscribeAddress(client, check.email, t);
    else await unsubscribeAddress(client, check.email, t);

    redirect(`/unsubscribe?e=${encodeURIComponent(address)}&c=${encodeURIComponent(linkCategory)}&s=${sig}&done=1`);
  }

  const hidden = (
    <>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="c" value={category} />
      <input type="hidden" name="s" value={params.get("s") ?? ""} />
    </>
  );

  const label =
    category === ALL_OPTIONAL
      ? "every optional email"
      : `${EMAIL_CATEGORIES[category as EmailCategory].label} emails`;

  return (
    <Shell title={sp.done || alreadyOff ? "Email preferences" : `Stop ${label}?`}>
      {sp.done || alreadyOff ? (
        <p className="text-[14px] leading-relaxed text-ink-2">
          {sp.done ? "Saved." : `${label[0]!.toUpperCase()}${label.slice(1)} are already off.`} Nothing
          else changed for <strong>{email}</strong>.
        </p>
      ) : (
        <>
          <p className="text-[14px] leading-relaxed text-ink-2">
            Press the button and we stop sending {label} to <strong>{email}</strong>. Nothing has
            changed yet.
          </p>
          <form action={toggle}>
            {hidden}
            <input type="hidden" name="category" value={category} />
            <input type="hidden" name="wanted" value="0" />
            <button
              type="submit"
              className="w-full rounded-[8px] bg-ink px-4 py-2.5 text-[13px] font-medium text-bg hover:opacity-90 cursor-pointer"
            >
              Stop {label}
            </button>
          </form>
        </>
      )}

      <div className="rounded-[10px] border border-line divide-y divide-line">
        {optionalCategories().map((c) => {
          const on = !allOff && !off.has(c);
          return (
            <form action={toggle} key={c} className="flex items-center justify-between gap-4 px-4 py-3">
              {hidden}
              <input type="hidden" name="category" value={c} />
              <input type="hidden" name="wanted" value={on ? "0" : "1"} />
              <div>
                <div className="text-[13px] font-medium text-ink">{EMAIL_CATEGORIES[c].label}</div>
                <div className="text-[12px] text-ink-3">{CATEGORY_HELP[c]}</div>
              </div>
              <button
                type="submit"
                className="shrink-0 rounded-[7px] border border-line px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-bg-2 cursor-pointer"
              >
                {on ? "Turn off" : "Turn back on"}
              </button>
            </form>
          );
        })}
      </div>

      {!allOff && (
        <form action={toggle}>
          {hidden}
          <input type="hidden" name="category" value={ALL_OPTIONAL} />
          <input type="hidden" name="wanted" value="0" />
          <button type="submit" className="text-[13px] text-ink-3 underline cursor-pointer">
            Stop all optional emails
          </button>
        </form>
      )}
      {allOff && (
        <form action={toggle}>
          {hidden}
          <input type="hidden" name="category" value={ALL_OPTIONAL} />
          <input type="hidden" name="wanted" value="1" />
          <button type="submit" className="text-[13px] text-ink-3 underline cursor-pointer">
            Turn everything back on
          </button>
        </form>
      )}

      <div className="rounded-[10px] bg-bg-2 px-4 py-3">
        <div className="text-[12px] font-medium text-ink">These keep coming, and here is why</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
          Sign-in and password links, invitations, a failed payment, a plan ending, a password change,
          a new API key. Each one is either the thing you asked for or the only warning before
          something you own stops working. There is no version of &ldquo;we could not reach you about
          your failed payment because you asked us not to&rdquo; that would be fair to you. Closing the
          account stops them.
        </p>
      </div>
    </Shell>
  );
}

const CATEGORY_HELP: Record<EmailCategory, string> = {
  auth: "Sign-in and password links.",
  account: "Password changes and new API keys.",
  billing: "Payments, plan changes, pauses.",
  drafts: "A draft was written, or approved.",
  publishing: "An article went live, or a publish failed.",
  improvements: "A rewrite of an existing page is waiting for review.",
  reports: "The monthly PDF.",
  product: "Nothing is being written for a workspace, and why.",
};

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[520px] flex-1 flex-col justify-center gap-5 px-5 py-16">
      <h1 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
      {children}
      <p className="text-[12px] text-ink-3">
        <a href="https://altorank.co" className="underline">
          altorank.co
        </a>
      </p>
    </main>
  );
}
