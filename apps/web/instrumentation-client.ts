import posthog from "posthog-js";
import { SIGNUP_SOURCE_KEYS } from "@/lib/auth/signup-source";

const posthogProjectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (!posthogProjectToken || !posthogHost) {
  // Analytics are optional. A self-hosted install or a fresh checkout runs
  // without PostHog, and the e2e runner leaves it out on purpose so tests send
  // no events. This used to throw in development, which took down every page
  // of `npm run dev` for anyone who had not set two variables documented
  // nowhere. A warning in the browser console says what is off instead.
  if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_E2E_STUBS !== "1") {
    const missingVariable = !posthogProjectToken
      ? "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"
      : "NEXT_PUBLIC_POSTHOG_HOST";

    console.warn(
      `PostHog analytics are off: ${missingVariable} is not set. Set NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN and NEXT_PUBLIC_POSTHOG_HOST to send product analytics; nothing else depends on them.`,
    );
  }
} else {
  posthog.init(posthogProjectToken, {
    api_host: posthogHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    tracing_headers: [window.location.hostname],
    // /signup arrives with where the visitor came from in its URL (`src`,
    // `ref`, `utm_*`; lib/auth/signup-source.ts). The signup action records
    // those on the new account, server side. PostHog would otherwise keep a
    // second copy: the URL goes into every event's `$current_url`, into the
    // initial-person info it saves in a cookie and localStorage, and into
    // session replay. Masking replaces each value with "<masked>" in all of
    // those, so the referring site and campaign stay in our own database only.
    // The same switch masks ad click ids (gclid, fbclid and the like).
    mask_personal_data_properties: true,
    custom_personal_data_properties: [...SIGNUP_SOURCE_KEYS],
    debug: process.env.NODE_ENV === "development",
  });
}
