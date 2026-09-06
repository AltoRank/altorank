import Link from "next/link";
import { APP_NAME } from "@/lib/constants";

type FAQItem = {
  question: string;
  answer: string;
};

type ToolPageLayoutProps = {
  name: string;
  headline: string;
  subheadline: string;
  faqItems: FAQItem[];
  children: React.ReactNode;
};

function buildJsonLd(name: string, description: string, faqItems: FAQItem[]) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebApplication",
        name,
        description,
        applicationCategory: "SEO Tool",
        operatingSystem: "All",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      ...(faqItems.length > 0
        ? [
            {
              "@type": "FAQPage",
              mainEntity: faqItems.map((item) => ({
                "@type": "Question",
                name: item.question,
                acceptedAnswer: {
                  "@type": "Answer",
                  text: item.answer,
                },
              })),
            },
          ]
        : []),
    ],
  };
}

export function ToolPageLayout({
  name,
  headline,
  subheadline,
  faqItems,
  children,
}: ToolPageLayoutProps) {
  // JSON-LD is built from static props we control — no user input, safe to inline
  const jsonLd = buildJsonLd(name, subheadline, faqItems);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="border-b border-line bg-[radial-gradient(600px_300px_at_50%_-10%,var(--accent-soft),transparent_70%)] py-16 pb-12">
        <div className="mx-auto max-w-[800px] px-8 text-center">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-bg px-2.5 py-[5px] text-xs text-ink-2">
            <span className="rounded-full bg-accent-soft px-[7px] py-[2px] font-mono text-[10.5px] font-medium tracking-[0.02em] text-accent-ink">
              FREE
            </span>
            No signup required
          </div>
          <h1 className="mb-4 text-[clamp(32px,4.5vw,48px)] font-semibold leading-[1.08] tracking-[-0.025em] text-ink [text-wrap:balance]">
            {headline}
          </h1>
          <p className="mx-auto mb-8 max-w-[560px] text-base leading-relaxed text-ink-2">
            {subheadline}
          </p>
          {children}
        </div>
      </section>

      {/* FAQ + CTA */}
      {faqItems.length > 0 && (
        <section className="border-b border-line py-16">
          <div className="mx-auto grid max-w-[800px] gap-12 px-8 md:grid-cols-2">
            {faqItems.map((item) => (
              <div key={item.question}>
                <h2 className="mb-3 text-xl font-semibold tracking-[-0.015em]">
                  {item.question}
                </h2>
                <p className="text-sm leading-relaxed text-ink-2">
                  {item.answer}
                </p>
              </div>
            ))}
            <div>
              <h2 className="mb-3 text-xl font-semibold tracking-[-0.015em]">
                Want the full pipeline?
              </h2>
              <p className="text-sm leading-relaxed text-ink-2">
                {APP_NAME} doesn&apos;t just run free tools — it automates your
                entire SEO content workflow. Research, write, optimize, and
                publish — all in one platform.
              </p>
              <Link
                href="/signup"
                className="mt-3 inline-flex items-center gap-1.5 font-mono text-[12px] text-accent-ink transition-colors hover:text-accent"
              >
                Try {APP_NAME} free
                <svg
                  className="h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </Link>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
