import posthog from "posthog-js";
import { SIGNUP_SOURCE_KEYS } from "@/lib/auth/signup-source";

const posthogProjectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (!posthogProjectToken || !posthogHost) {
  // The e2e runner is a development server started without PostHog keys on
  // purpose - tests must not send events - so the development throw below
  // would take down every page it renders. NEXT_PUBLIC_E2E_STUBS mirrors the
  // server-side E2E_STUBS through next.config.ts.
  if (process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_E2E_STUBS !== "1") {
    const missingVariable = !posthogProjectToken
      ? "NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN"
      : "NEXT_PUBLIC_POSTHOG_HOST";

    throw new Error(
      `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
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
