import Link from "next/link";
import { Button } from "./button";
import { Icons } from "./icons";

type IconName = keyof typeof Icons;

type ConnectPromptProps = {
  /** Icon from the existing set. No third-party marks: we do not ship other
   *  companies' logos, and an approximated one is worse than none. */
  icon?: IconName;
  /** What is missing, in the user's terms. */
  title: string;
  /** Why it is missing and what filling it in buys. One or two sentences. */
  body: string;
  /** Where the user goes to fix it. */
  href: string;
  cta: string;
  /** The service being connected, named in text beside the icon. */
  service?: string;
  /** Compact variant for a stat tile or a table cell. */
  dense?: boolean;
};

/**
 * The prompt shown where a panel has nothing to display *because something is
 * not connected yet*.
 *
 * Every empty surface in the app used to be a sentence in grey text. That is
 * honest but inert: it explains the hole without offering the one action that
 * fills it, and the user has to work out for themselves that "connect
 * analytics" means the Integrations page.
 *
 * Deliberately not used for surfaces that are empty because the user has not
 * done the work yet ("No articles yet"). Those need a different verb, and
 * pointing them at Integrations would be wrong.
 */
export function ConnectPrompt({
  icon = "integrations",
  title,
  body,
  href,
  cta,
  service,
  dense = false,
}: ConnectPromptProps) {
  const IconFn = Icons[icon];

  if (dense) {
    return (
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink-2 transition-colors"
      >
        <IconFn size={12} />
        <span className="underline decoration-line underline-offset-2">{cta}</span>
      </Link>
    );
  }

  return (
    <div className="grid place-items-center text-center px-6 py-8">
      <div className="max-w-[42ch]">
        <div className="inline-flex items-center gap-2 mb-3 px-2.5 py-1 rounded-full border border-line text-ink-2">
          <IconFn size={13} />
          {service && (
            <span className="font-mono text-[11px] tracking-[0.02em]">{service}</span>
          )}
        </div>
        <div className="text-[13px] text-ink-2 font-medium mb-1.5">{title}</div>
        <p className="text-[12.5px] text-ink-3 leading-[1.6] mb-4">{body}</p>
        <Link href={href}>
          <Button size="sm" variant="default">
            {cta}
          </Button>
        </Link>
      </div>
    </div>
  );
}
