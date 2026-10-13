/**
 * The dashboard pages an account before its trial may still open: the ones
 * the wizard opens (Search Console's tab and Google's OAuth landing), and
 * nothing else. Everything else under the dashboard sends it to the card.
 */
import { describe, expect, it } from "vitest";
import { openBeforeTrial } from "../gate-paths";

describe("openBeforeTrial", () => {
  it.each(["/connect", "/connect/google", "/connect/google/"])("lets %s through", (path) => {
    expect(openBeforeTrial(path)).toBe(true);
  });

  it.each(["/dashboard", "/content", "/content/abc", "/keywords", "/reports", "/articles", "/workspaces", "/settings/billing", "/connected", "/connections/x"])(
    "gates %s",
    (path) => {
      expect(openBeforeTrial(path)).toBe(false);
    },
  );

  // No header means the middleware did not run for this request; not knowing
  // the path is not a reason to open the page.
  it.each([null, undefined, ""])("gates an unknown path (%s)", (path) => {
    expect(openBeforeTrial(path)).toBe(false);
  });
});
