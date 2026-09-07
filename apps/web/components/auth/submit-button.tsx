"use client";

import { useFormStatus } from "react-dom";

/**
 * The submit button for the auth forms, which are server-action forms on
 * server components and so had no way to know they were mid-flight.
 *
 * Measured 2026-09-06: "Create account" stayed live 300 ms after the click,
 * and a cold sign-in took 33 s with the button still enabled the whole way.
 * A visitor who clicks again gets a second server action queued behind the
 * first - two sign-ups against one address, the second failing with "already
 * registered" while the first is still sending the confirmation email.
 *
 * `useFormStatus` reads the nearest parent `<form>`'s pending state, so this
 * works inside a server component's form without lifting anything. While
 * pending: disabled, the pending label, `aria-busy`. Same classes as before,
 * so nothing shifts.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  /** What the button says while the action runs. "Signing in…". */
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={
        className ??
        "w-full py-2.5 bg-accent text-white font-medium text-[13px] rounded-[7px] hover:bg-accent-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-progress inline-flex items-center justify-center gap-2"
      }
    >
      {pending && <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {pending ? pendingLabel : children}
    </button>
  );
}
