import { chromium } from "@playwright/test";
import { createAccount, destroyAccount, signIn } from "./fixtures/account";
import { BASE_URL } from "./fixtures/env";

/**
 * Compile the routes the specs hit, for real, before any of them is timed.
 *
 * `next dev` compiles a route on its first request. The heavy ones - the
 * onboarding pipeline behind /api/onboard/stream, the editor behind
 * /content/[id] - can take tens of seconds cold, enough to blow a spec's whole
 * 60s budget on whichever test reaches them first, and to starve GoTrue while
 * every worker's fixture is creating a user at once. And most of them are
 * auth-gated, so an anonymous GET only compiles the /signin it redirects to.
 *
 * So warm them signed in, from one throwaway account, sequentially, off every
 * test's clock. Best-effort: a route that errs cold is diagnosed by the spec
 * that needs it, not here.
 */
async function globalSetup(): Promise<void> {
  const account = await createAccount({ workspaces: [{ domain: "warmup.e2e.altorank.test", onboarded: true }] });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: BASE_URL });
    page.setDefaultTimeout(90_000);
    await signIn(page, account.email, "/dashboard");
    for (const path of ["/dashboard", "/keywords", "/content", "/articles", "/onboarding"]) {
      await page.goto(path, { waitUntil: "load" }).catch(() => {});
    }
    // The editor route carries a param; compile it on the warm-up workspace.
    const { admin } = await import("./fixtures/account");
    const { data: art } = await admin()
      .from("articles")
      .insert({ workspace_id: account.workspaces[0].id, title: "warmup", slug: "warmup", status: "review", ai_provider: "claude" })
      .select("id")
      .single();
    if (art) await page.goto(`/content/${art.id}`, { waitUntil: "load" }).catch(() => {});
  } finally {
    await browser.close();
    await destroyAccount(account);
  }
}

export default globalSetup;
