/**
 * How the e2e dev server is started, in one place.
 *
 * `npm run e2e` starts it through playwright.config.ts `webServer`, and
 * `npm run dev:e2e` starts the same server by hand for a fast loop (the runner
 * reuses whatever already answers on the port). Both read this module, so
 * the long-running server gets the same no-spend overrides as the one the
 * runner starts: before this, `dev:e2e` set only E2E_STUBS, kept every paid
 * key from the env files, and left NEXT_PUBLIC_APP_URL pointing wherever
 * .env.local said, so the onboarding worker could be dispatched to a plain
 * dev server on another port.
 *
 * No imports: scripts/dev-e2e.ts runs this under tsx without Next.
 */

export const E2E_PORT = 3110;

export const E2E_SERVER_ENV: Record<string, string> = {
  E2E_STUBS: "1",
  // The check-what-we-found form stays the fallback when a site read
  // fails, so the specs that walk it keep running with auto-start off;
  // first-look-gate.spec turns it on per browser (lib/dev/simulation.ts).
  ONBOARDING_AUTOSTART: "0",
  // Own build directory, so this server can start beside a plain `next dev`
  // of the same checkout (Next 16 locks `.next/dev` per process).
  NEXT_DIST_DIR: ".next-e2e",
  // The onboarding run and the fan-out call this server back over HTTP
  // (lib/content/fan-out.ts); a base URL pointing at another dev server
  // would run the worker there, against whatever database it has.
  NEXT_PUBLIC_APP_URL: `http://localhost:${E2E_PORT}`,
  // Belt and braces: even a path the stubs miss cannot authenticate to a
  // paid provider, and the approval gate is exercised as self-host (no
  // Stripe), where approving needs no plan. An empty value wins over the env
  // files: Next only fills variables that are not already set.
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  DATAFORSEO_API_KEY: "",
  DATAFORSEO_LOGIN: "",
  DATAFORSEO_PASSWORD: "",
  STRIPE_SECRET_KEY: "",
};
