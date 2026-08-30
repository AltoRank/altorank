"use client";

import { useActionState } from "react";
import {
  generateMetaAction,
  type MetaActionState,
} from "@/app/actions/meta-gen";
import { MetaResult } from "./meta-result";

const INITIAL_STATE: MetaActionState = { success: false };

export function MetaForm() {
  const [state, formAction, isPending] = useActionState(
    generateMetaAction,
    INITIAL_STATE,
  );

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-3">
        <input
          name="keyword"
          type="text"
          required
          minLength={2}
          maxLength={100}
          placeholder="Enter a keyword or topic (e.g. best crm for startups)"
          className="w-full rounded-lg border border-line bg-bg px-4 py-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
        />
        <div className="flex gap-3">
          <input
            name="url"
            type="url"
            placeholder="Optional: page URL for context"
            className="flex-1 rounded-lg border border-line bg-bg px-4 py-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-accent-2 disabled:opacity-50"
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
                Generating...
              </>
            ) : (
              "Generate"
            )}
          </button>
        </div>
      </form>

      {state.error && (
        <div className="mt-4 rounded-lg border border-[oklch(0.8_0.1_25)] bg-[oklch(0.95_0.03_25)] px-4 py-3 text-sm text-[oklch(0.45_0.15_25)]">
          {state.error}
        </div>
      )}

      {state.success && state.result && <MetaResult result={state.result} />}
    </div>
  );
}
