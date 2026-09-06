import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getShareCardFactsByToken } from "@/lib/queries/share";
import { buildShareCard, CARD_WIDTH, CARD_HEIGHT } from "@/lib/share/card";
import { isShareToken, publicShareCard } from "@/lib/share/token";
import { MARKETING_URL } from "@/lib/constants";

/**
 * app.altorank.co/share/<token>: the share card as a page, so a posted link
 * unfurls (the image is /api/og/share/<token>) and opens to the same numbers
 * in text. Public by token; nothing here comes from a session. Not indexed:
 * one page per token is not a page anyone should search for.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

async function load(props: Props) {
  const { token } = await props.params;
  if (!isShareToken(token)) return null;
  const facts = await getShareCardFactsByToken(token);
  if (!facts) return null;
  return { token, card: publicShareCard(buildShareCard(facts)) };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const loaded = await load(props);
  if (!loaded) return { title: "Not found", robots: { index: false, follow: false } };
  const { token, card } = loaded;
  const title = `${card.domain}: content and search progress`;
  const description = card.stats.map((s) => `${s.value} ${s.label.toLowerCase()}`).join(" · ");
  const image = { url: `/api/og/share/${token}`, width: CARD_WIDTH, height: CARD_HEIGHT, alt: title };
  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default async function SharePage(props: Props) {
  const loaded = await load(props);
  if (!loaded) notFound();
  const { token, card } = loaded;

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-xl border border-line bg-bg">
        {/* The exact picture the link unfurls to; the list below is the same numbers as text. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/og/share/${token}`} alt="" width={CARD_WIDTH} height={CARD_HEIGHT} className="block h-auto w-full" />
      </div>

      <div>
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">{card.domain}</h1>
        <p className="mt-1 text-[13px] text-ink-3">Every number is measured. Nothing here is estimated.</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {card.stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-bg px-4 py-3">
            <dt className="text-[12px] text-ink-3">{s.label}</dt>
            <dd className="m-0 font-mono text-[24px] font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>

      {card.footer && (
        <p className="m-0 text-[12px] text-ink-3">
          {card.footer} ·{" "}
          <a href={MARKETING_URL} className="underline decoration-line underline-offset-[3px] hover:text-ink">
            Measure your own site
          </a>
        </p>
      )}
    </div>
  );
}
