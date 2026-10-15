"use client";

import { useRef } from "react";

/**
 * One field for the email code: digits only, the phone's number pad, and the
 * one-time-code autofill iOS and Android offer from the email. When the last
 * digit lands the form submits itself, so a pasted or autofilled code is one
 * step, not two.
 */
export function CodeInput({ length = 6 }: { length?: number }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <div>
      <label htmlFor="signup-code" className="text-[12.5px] font-medium text-ink-2 mb-1.5 block">
        Code
      </label>
      <input
        ref={ref}
        id="signup-code"
        name="code"
        required
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,12}"
        maxLength={12}
        placeholder="123456"
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "");
          if (digits.length >= length) e.target.form?.requestSubmit();
        }}
        className="w-full px-3 py-3 bg-bg border border-line rounded-[7px] text-center font-mono text-[22px] tracking-[0.4em] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
      />
    </div>
  );
}
