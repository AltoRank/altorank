import { test as base, expect } from "@playwright/test";
import { createAccount, destroyAccount, signIn, type Account, type WorkspaceSpec } from "./account";

type Fixtures = {
  /**
   * Per-file shape of the account, via `test.use({ accountShape: { workspaces: [...] } })`.
   * An object rather than a bare array: Playwright reads a two-element array
   * option as a `[value, options]` tuple.
   */
  accountShape: { workspaces?: WorkspaceSpec[] };
  /** A fresh account, torn down after the test whatever happens. */
  account: Account;
  /** The same account, with the page already signed in and on /dashboard. */
  signedIn: Account;
};

export const test = base.extend<Fixtures>({
  accountShape: [{}, { option: true }],
  account: async ({ accountShape }, provide) => {
    const account = await createAccount({ workspaces: accountShape.workspaces });
    try {
      await provide(account);
    } finally {
      await destroyAccount(account);
    }
  },
  signedIn: async ({ page, account }, provide) => {
    await signIn(page, account.email);
    await provide(account);
  },
});

export { expect };
