import posthog from "posthog-js";

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
    debug: process.env.NODE_ENV === "development",
  });
}
