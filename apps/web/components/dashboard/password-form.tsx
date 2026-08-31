"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { changePassword } from "@/app/actions/settings";

/**
 * Authenticated password change.
 *
 * Two reasons this exists. The everyday one: an account that wants a new
 * password should not have to pretend it forgot the old one. The resilience
 * one: when the Supabase redirect allowlist is missing an entry, a reset
 * email's link gets clamped to the site root, where the middleware's
 * stray-code handler still signs the recovery session in - at the dashboard,
 * not the set-password form. Without this card that person is signed in today
 * and locked out again at next sign-out. With it, the clamped path still ends
 * in a changed password.
 */
export function PasswordForm() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  return (
    <form
      className="flex flex-col gap-3"
      action={(fd) =>
        start(async () => {
          const r = await changePassword(fd);
          setResult(r.error ? { ok: false, msg: r.error } : { ok: true, msg: "Password changed." });
        })
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">
            New password
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">
            Repeat it
          </span>
          <input
            name="confirm"
            type="password"
            required
            minLength={8}
            className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent"
          />
        </label>
      </div>
      {result && (
        <div className={`text-[12.5px] ${result.ok ? "text-ok-ink" : "text-err-ink"}`}>
          {result.msg}
        </div>
      )}
      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
