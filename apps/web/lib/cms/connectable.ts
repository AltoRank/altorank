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
 * CMSs the connection dialog has a real credential form for, and whose adapter
 * has been exercised. Their tiles deep-link to the dialog on that platform's
 * tab.
 *
 * `framer` is deliberately absent. Our own adapter notes say it "has not been
 * exercised against a live Framer project" (lib/cms/publish-mode.ts,
 * lib/cms/connector-notes.ts), and the research on 2026-09-07 found the
 * adapter was written against an API that does not exist in the shape we
 * assumed: Framer shipped a Server API on 2026-02-12 which is a WebSocket SDK
 * (npm `framer-api`), not the REST surface framer.ts calls. Offering Connect
 * would be offering a button that cannot work. It returns to this set when the
 * adapter is rewritten and tested against a real project.
 */
export const CONNECTABLE_CMS = new Set([
  "wordpress",
  "wordpress-plugin",
  "shopify",
  "magento",
  "webflow",
  "ghost",
  "wix",
  "notion",
  "hubspot",
  "woocommerce",
  "webhook",
  "git",
]);

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
