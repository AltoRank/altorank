import { defineConfig, devices } from "@playwright/test";
// Loads .env.development.local / .env.local into this process and refuses any
// Supabase or base URL that is not localhost. See e2e/README.md.
import { BASE_URL } from "./e2e/fixtures/env";

/**
 * The e2e runner. Real UI, real server actions, real pipeline, real (local)
 * database; the model, DataForSEO and every fetch of a customer site are
 * replaced by fixtures when the dev server runs with E2E_STUBS=1, which is how
 * `webServer` below starts it. Nothing in this suite spends money.
 */
export default defineConfig({
  testDir: "./e2e",
  // Compiles the routes the specs hit before any of them is timed (dev cold start).
  globalSetup: "./e2e/global-setup.ts",
  // Each spec is written to finish well inside a minute on fixtures; a slower
  // run is a regression worth seeing.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  // One worker on purpose. The suite is six short specs; running them in
  // parallel against a single cold dev server and one local GoTrue starves both
  // - admin createUser times out, a cascade delete hits a statement timeout -
  // for no real time saving once the routes are warm. Serial is reliable and
  // still well under a minute after the warm-up.
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"], ["html", { open: "on-failure" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx next dev -p 3110",
    // /signin answers 200 without a session; / is a redirect to the marketing site.
    url: `${BASE_URL}/signin`,
    // A server already on 3110 is reused locally, so `npm run dev:e2e` in one
    // terminal and `npm run e2e` in another is a fast loop. It MUST have been
    // started with E2E_STUBS=1: a plain `next dev` on that port would let the
    // onboarding spec reach real providers.
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      E2E_STUBS: "1",
      // Belt and braces: even a path the stubs miss cannot authenticate to a
      // paid provider, and the approval gate is exercised as self-host (no
      // Stripe), where approving needs no plan.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      DATAFORSEO_API_KEY: "",
      DATAFORSEO_LOGIN: "",
      DATAFORSEO_PASSWORD: "",
      STRIPE_SECRET_KEY: "",
    },
  },
});
