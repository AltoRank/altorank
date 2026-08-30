"use client";

import { useActionState } from "react";
import {
  clusterKeywordsAction,
  type ClustersActionState,
} from "@/app/actions/clusters";
import { getLocaleOptions } from "@/lib/seo/locales";
import { ClustersResult } from "./clusters-result";

const localeOptions = getLocaleOptions();

const INITIAL_STATE: ClustersActionState = { success: false };

export function ClustersForm() {
  const [state, formAction, isPending] = useActionState(
    clusterKeywordsAction,
    INITIAL_STATE,
  );

  return (
    <div>
      <form action={formAction} className="flex flex-col gap-3">
        <textarea
          name="keywords"
          required
          rows={3}
          placeholder="Enter keywords separated by commas (max 20)&#10;e.g. crm software, crm for startups, best crm tools, small business crm"
          className="w-full rounded-lg border border-line bg-bg px-4 py-3 text-sm text-ink placeholder:text-ink-3 transition-colors focus:border-accent focus:outline-none resize-none"
        />
        <div className="flex gap-3">
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
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-accent-2 disabled:opacity-50 sm:flex-none"
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
                Clustering...
              </>
            ) : (
              "Build Clusters"
            )}
          </button>
        </div>
      </form>

      {state.error && (
        <div className="mt-4 rounded-lg border border-[oklch(0.8_0.1_25)] bg-[oklch(0.95_0.03_25)] px-4 py-3 text-sm text-[oklch(0.45_0.15_25)]">
          {state.error}
        </div>
      )}

      {state.success && state.result && (
        <ClustersResult result={state.result} />
      )}
    </div>
  );
}
