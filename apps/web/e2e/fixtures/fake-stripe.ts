import type { Page } from "@playwright/test";

/**
 * Stripe.js, as far as the checkout sheet uses it, for a server with no
 * Stripe account (e2e/fixtures/server-env.ts gives it a placeholder
 * publishable key so the button opens Embedded Checkout on the page).
 *
 * Like the real one it allows one Embedded Checkout per page: a second
 * `createEmbeddedCheckoutPage` before the first is destroyed throws. It
 * never asks for a client secret, so no server action runs and nothing
 * reaches Stripe. `window.__checkouts.live` is how many forms exist now.
 */
const SCRIPT = `
window.__checkouts = { live: 0, made: 0 };
window.Stripe = function () {
  return {
    createEmbeddedCheckoutPage: async function () {
      if (window.__checkouts.live > 0) throw new Error("You cannot have multiple Embedded Checkout objects.");
      window.__checkouts.live += 1;
      window.__checkouts.made += 1;
      var frame = null;
      var gone = false;
      return {
        mount: function (host) {
          frame = document.createElement("iframe");
          frame.setAttribute("data-fake-checkout", "");
          frame.title = "Secure checkout";
          frame.style.height = "600px";
          host.appendChild(frame);
        },
        destroy: function () {
          if (gone) return;
          gone = true;
          window.__checkouts.live -= 1;
          if (frame) frame.remove();
        },
      };
    },
  };
};
`;

export async function fakeStripe(page: Page): Promise<void> {
  await page.route(/^https:\/\/js\.stripe\.com\//, (route) => route.fulfill({ contentType: "application/javascript", body: SCRIPT }));
}

/** How many checkout forms exist on the page right now. */
export function liveCheckouts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __checkouts?: { live: number } }).__checkouts?.live ?? 0);
}
