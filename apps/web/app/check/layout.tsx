import Image from "next/image";
import { APP_NAME, MARKETING_URL } from "@/lib/constants";

/**
 * Public shell for /check/*. No sidebar, no session: the reader followed a
 * link about somebody's site and may never have heard of the product. The
 * chrome says who ran the check and where to run another, nothing more.
 */
export default function CheckLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg-2 text-ink">
      <header className="border-b border-line bg-bg">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-5">
          <a href={MARKETING_URL} className="flex items-center gap-2.5">
            <span className="relative grid h-[26px] w-[26px] place-items-center rounded-[7px] bg-ink">
              <Image src="/brand/altorank-mark-white.svg" alt="" width={15} height={15} priority />
            </span>
            <span className="text-[16px] font-semibold tracking-[-0.01em]">{APP_NAME}</span>
          </a>
          <a
            href={`${MARKETING_URL}/check`}
            className="text-[13px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
          >
            Check another site
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">{children}</main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 text-[12px] text-ink-3">
        The check reads the homepage, /robots.txt, /sitemap.xml and /llms.txt of the site named
        and nothing else. Results are kept for six hours so a shared link does not re-crawl the site.
      </footer>
    </div>
  );
}
