import Image from "next/image";
import { APP_NAME, MARKETING_URL } from "@/lib/constants";

/**
 * Public shell for /share/*. No sidebar, no session: the reader followed a
 * link somebody posted about their site. The chrome names the product that
 * measured the numbers and nothing more.
 */
export default function ShareLayout({ children }: { children: React.ReactNode }) {
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
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-10">{children}</main>
    </div>
  );
}
