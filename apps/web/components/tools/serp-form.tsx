"use client";

import { useActionState } from "react";
import {
  analyzeSerpAction,
  type SerpActionState,
} from "@/app/actions/serp-tool";
import { getLocaleOptions } from "@/lib/seo/locales";
import { SerpResult } from "./serp-result";

const localeOptions = getLocaleOptions();

const INITIAL_STATE: SerpActionState = { success: false };

export function SerpForm() {
  const [state, formAction, isPending] = useActionState(
    analyzeSerpAction,
    INITIAL_STATE,
  );

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row">
        <input
          name="keyword"
          type="text"
          required
          minLength={2}
          maxLength={100}
          placeholder="Enter a keyword (e.g. project management software)"
          className="flex-1 rounded-lg border border-line bg-bg px-4 py-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
        />
        <select
          name="locale"
          defaultValue="en"
          className="rounded-lg border border-line bg-bg px-3 py-3 text-sm text-ink-2 transition-colors focus:border-accent focus:outline-none sm:w-[200px]"
        >
          {localeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
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
              Analyzing...
            </>
          ) : (
            "Analyze SERP"
          )}
        </button>
      </form>

      {state.error && (
        <div className="mt-4 rounded-lg border border-[oklch(0.8_0.1_25)] bg-[oklch(0.95_0.03_25)] px-4 py-3 text-sm text-[oklch(0.45_0.15_25)]">
          {state.error}
        </div>
      )}

      {state.success && state.result && <SerpResult result={state.result} />}
    </div>
  );
}
