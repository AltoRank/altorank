// ---------------------------------------------------------------------------
// The account's name, from the domain it signed up with
// ---------------------------------------------------------------------------
//
// Signup used to ask for a company name next to the website, which is the same
// question twice: nobody signs up as "Acme" from vitaminshop.de. The field is
// gone and the name is derived here, then the wizard overwrites the BUSINESS
// name from what it reads on the site - so this only has to be a reasonable
// label for the sidebar between signup and the end of the first run.
//
// It is not clever on purpose. A name that guesses wrong is worse than a name
// that is obviously mechanical, because the first looks like we know something
// about the customer and the second looks like a placeholder they can edit.

const MULTI_PART_TLD = /\.(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/i;

/**
 * "qasimcode.com" -> "Qasimcode". "my-shop.co.uk" -> "My Shop".
 * Anything unreadable falls back to the host as typed.
 */
export function accountNameFromDomain(domain: string): string {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  if (!host) return "";

  // Drop the public suffix, keeping the label before it: two parts for
  // "co.uk" and friends, one otherwise.
  const label = MULTI_PART_TLD.test(host)
    ? host.split(".").slice(0, -2).pop()
    : host.split(".").slice(0, -1).pop();
  const base = (label ?? host).trim();
  if (!base) return host;

  // Hyphens and underscores are word breaks in a domain and nowhere else.
  const words = base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ") : host;
}
