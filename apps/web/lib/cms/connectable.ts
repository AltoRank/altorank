// ---------------------------------------------------------------------------
// Which integrations have a working connect flow, and which take a request
// ---------------------------------------------------------------------------
//
// Every tile on /connect used to end in one of two buttons: "Connect", or a
// disabled "Connect" for the ones with no flow behind them (Ahrefs, Slack,
// Zapier). The disabled button is honest but it is a dead end - it tells
// someone we do not support their stack and gives them nowhere to go, and it
// tells us nothing about what they wanted.
//
// So the second state is now "Request integration", which emails us. That
// makes the tile useful to the person (they have said what they need) and
// useful to us (we find out which connectors people actually ask for before
// building one). Nothing here changes what a connected integration does.
//
// The list is a constant rather than a database column on purpose: whether a
// connector works is a fact about the code in this repository, so it belongs
// next to the code and moves in the same commit as the adapter that changes
// it. A column would let the two drift, and the failure mode of that drift is
// a Connect button that dead-ends.

/**
 * CMSs whose tile offers a self-serve Connect button.
 *
 * 🚨 **Empty on purpose, 2026-09-07.** Not one connector has been exercised
 * end-to-end against a live service by us. The audit in
 * altorank-notes/research/connectors-2026-09-07/01-code-audit.md rated exactly
 * two "safe to advertise", and even those two are unverified against a real
 * account; the rest carry known gaps - Wix and Notion cannot update a post they
 * already made, Webflow and Magento assert a public URL nobody checked, Framer
 * was written against an API that does not exist in that shape, Magento asks
 * for a token that dies in four hours, and HubSpot's credential stops being
 * issuable to new accounts on 2026-09-28.
 *
 * So every tile asks instead of offering, and onboarding is concierge-run
 * until a connector has been watched working on somebody's real site. A
 * Connect button that fails costs more than a request form that succeeds.
 *
 * **To bring one back:** add its id here once it has published to a live site,
 * and the tile changes by itself. Its id must already be in CMS_TYPES in
 * connect-cms-dialog.tsx - `connectable.test.ts` fails otherwise, because a
 * Connect button whose dialog will not open is the worst of both.
 *
 * This does not touch connections that already exist: their tiles keep Test
 * and Reconnect, the dialog still opens from `/connect?connect=<id>`, and the
 * adapters are untouched. What is withdrawn is the advertisement.
 */
export const CONNECTABLE_CMS = new Set<string>([]);

/**
 * Integrations whose tile offers "Request integration" instead of "Connect".
 *
 * Anything on the page that is not connectable and is not one of the two
 * OAuth flows (Google, Bing) lands here by subtraction, so a tile added to the
 * database without an adapter gets the request button rather than a dead one.
 * That default is the point: the page cannot silently grow a button that does
 * nothing.
 */
export function isRequestable(integrationId: string, hasOwnFlow: boolean): boolean {
  return !hasOwnFlow && !CONNECTABLE_CMS.has(integrationId);
}
