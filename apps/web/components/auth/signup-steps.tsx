"use client";

import { useRef, useState } from "react";
import { DOMAIN_PATTERN, normalizeDomain } from "@/lib/domain/shape";
import { SubmitButton } from "./submit-button";

const INPUT =
  "w-full px-3 py-2.5 bg-bg border border-line rounded-[7px] text-base sm:text-[14px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";
const LABEL = "text-[12.5px] font-medium text-ink-2 mb-1.5 block";

/**
 * The signup form's fields, one question at a time: the website, then the
 * email, in the one server-action form the page owns. Without JavaScript the
 * domain step submits and the server answers with the email step, so it
 * still signs up. A domain from the homepage's growth plan starts on the email.
 */
export function SignupSteps({ prefilledDomain, startOnDomain = false }: { prefilledDomain: string | null; startOnDomain?: boolean }) {
  const [domain, setDomain] = useState(prefilledDomain ?? "");
  // A domain the server refused comes back on the domain step, with it filled in.
  const [step, setStep] = useState<"domain" | "email">(prefilledDomain && !startOnDomain ? "email" : "domain");
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const domainRef = useRef<HTMLInputElement | null>(null);

  function next() {
    const d = normalizeDomain(domain);
    if (!DOMAIN_PATTERN.test(d)) {
      setError("Enter your website as a domain, like acme.com.");
      domainRef.current?.focus();
      return;
    }
    setDomain(d);
    setError(null);
    setStep("email");
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  return (
    <div className="space-y-4">
      {step === "domain" ? (
        <div>
          <label htmlFor="signup-domain" className={LABEL}>
            Your website
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={domainRef}
              id="signup-domain"
              name="domain"
              type="text"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => {
                // Enter moves on rather than submitting half a form.
                if (e.key === "Enter") {
                  e.preventDefault();
                  next();
                }
              }}
              inputMode="url"
              autoComplete="url"
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "signup-domain-error" : "signup-domain-hint"}
              className={INPUT}
              placeholder="yourbusiness.com"
            />
            {/* A submit button, so before hydration or without JavaScript it
                still works: the server checks the domain and comes back on
                the email step. Once hydrated, the click is handled here. */}
            <button
              type="submit"
              onClick={(e) => {
                e.preventDefault();
                next();
              }}
              className="shrink-0 py-2.5 px-4 bg-ink text-bg font-medium text-[14px] rounded-[7px] hover:opacity-90 transition-opacity cursor-pointer"
            >
              Continue
            </button>
          </div>
          {error ? (
            <p id="signup-domain-error" role="alert" className="mt-1.5 text-[12px] text-err-ink">
              {error}
            </p>
          ) : (
            <p id="signup-domain-hint" className="mt-1.5 text-[12px] text-ink-3">
              Nothing to install, and nothing publishes without your approval.
            </p>
          )}
        </div>
      ) : (
        <>
          <input type="hidden" name="domain" value={domain} />
          <div className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-panel px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[11.5px] text-ink-3">Your website</div>
              <div className="truncate font-mono text-[13px] text-ink">{domain}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setStep("domain");
                requestAnimationFrame(() => domainRef.current?.focus());
              }}
              className="shrink-0 rounded-[7px] px-2 py-2 text-[12.5px] text-ink-2 underline decoration-line underline-offset-[3px] hover:text-ink"
            >
              Change
            </button>
          </div>
          <div>
            <label htmlFor="signup-email" className={LABEL}>
              Work email
            </label>
            <input
              ref={emailRef}
              id="signup-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={INPUT}
              placeholder="you@yourbusiness.com"
            />
            <p className="mt-1.5 text-[12px] text-ink-3">We email you a code to type on the next screen. No password to make up.</p>
          </div>
          <SubmitButton pendingLabel="Sending your code…">Send my code</SubmitButton>
        </>
      )}
    </div>
  );
}
