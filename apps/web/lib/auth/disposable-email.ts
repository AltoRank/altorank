// ---------------------------------------------------------------------------
// Throwaway inboxes, refused at signup
// ---------------------------------------------------------------------------
//
// The trial asks for no card (lib/billing/cardless-trial.ts), so the address
// is one of the few things that still costs a signup something. A disposable
// inbox costs nothing and is gone in an hour. This is the providers people
// actually reach for, not an exhaustive list: one trial per site
// (domainAlreadyTrialed) is the rule that holds when this misses one.

const DISPOSABLE = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "fakeinbox.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "inboxkitten.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

/** Whether the address is at a known throwaway-inbox provider. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  const at = (email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return false;
  const domain = (email ?? "").trim().toLowerCase().slice(at + 1);
  return DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith(`.${d}`));
}

export const DISPOSABLE_EMAIL_MESSAGE = "Use an address you keep: the trial and your articles are sent there. Throwaway inboxes are not accepted.";
