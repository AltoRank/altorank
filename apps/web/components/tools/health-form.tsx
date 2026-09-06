"use client";

import { useActionState } from "react";
import {
  checkHealthAction,
  type HealthActionState,
} from "@/app/actions/health";
import { HealthResult } from "./health-result";

const INITIAL_STATE: HealthActionState = { success: false };

export function HealthForm() {
  const [state, formAction, isPending] = useActionState(
    checkHealthAction,
    INITIAL_STATE,
  );

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row">
        <input
          name="url"
          type="url"
          required
          placeholder="https://example.com/page"
          className="flex-1 rounded-lg border border-line bg-bg px-4 py-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-accent-2 disabled:opacity-50"
        >
          {isPending ? (
            <>
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Checking...
            </>
          ) : (
            "Check SEO Health"
          )}
        </button>
      </form>

      {state.error && (
        <div className="mt-4 rounded-lg border border-[oklch(0.8_0.1_25)] bg-[oklch(0.95_0.03_25)] px-4 py-3 text-sm text-[oklch(0.45_0.15_25)]">
          {state.error}
        </div>
      )}

      {state.success && state.result && <HealthResult result={state.result} />}
    </div>
  );
}
