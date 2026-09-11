"use client";

import type { BusinessProfile } from "@/lib/onboarding/business-profile";
import { LANGUAGE_OPTIONS, MARKET_OPTIONS, GLOBAL_MARKET } from "@/lib/onboarding/locale";
import { Field, inputClass } from "./fields";

/**
 * Name, language, market, description. The wizard's first screen and the
 * General settings tab render exactly this; only the wrapper differs.
 *
 * Labels in the select, codes in the columns: `saveProfile` runs these
 * through `resolveLocale`, so the value here is the label a person reads.
 */
export function BusinessFields({
  profile,
  patch,
}: {
  profile: BusinessProfile;
  patch: (p: Partial<BusinessProfile>) => void;
}) {
  const market = MARKET_OPTIONS.find((m) => m.label === profile.country);
  const knownLanguage = LANGUAGE_OPTIONS.find((o) => o.label.toLowerCase() === profile.language.toLowerCase());
  return (
    <div className="flex flex-col gap-4">
      <Field label="Business name">
        <input className={inputClass} value={profile.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Acme" />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Language">
          <select className={inputClass} value={knownLanguage?.label ?? profile.language} onChange={(e) => patch({ language: e.target.value })}>
            {!knownLanguage && <option value={profile.language}>{profile.language}</option>}
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.code} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Market" hint={market?.hint ?? "Where your search demand is. Keyword data comes from this country."}>
          <select className={inputClass} value={market ? market.label : GLOBAL_MARKET} onChange={(e) => patch({ country: e.target.value })}>
            {MARKET_OPTIONS.map((m) => (
              <option key={m.label} value={m.label}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" hint="Used to keep drafts about your actual business rather than the category.">
        <textarea
          rows={7}
          className={`${inputClass} resize-none leading-[1.6]`}
          value={profile.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="What you sell, to whom, and what sets it apart."
        />
      </Field>
      <details>
        <summary className="cursor-pointer text-sm text-ink-2">Buying goals and product details</summary>
        <div className="mt-4 flex flex-col gap-4">
          {([{key:"buyingJobs",label:"What buyers need to accomplish"},{key:"differentiators",label:"What sets your offering apart"},{key:"exclusions",label:"Needs or customers you do not serve"}] as const).map(({key,label}) =>
            <Field key={key} label={label} hint="One item per line. Only include claims you can support.">
              <textarea rows={3} className={inputClass} value={(profile[key] ?? []).join("\n")} onChange={(e) => patch({[key]:e.target.value.split("\n")})} />
            </Field>)}
          <Field label="Where an interested buyer should go" hint="Your product, pricing, booking or contact page.">
            <input className={inputClass} value={profile.conversionUrl ?? ""} onChange={(e) => patch({conversionUrl:e.target.value})} placeholder="https://example.com/contact" />
          </Field>
        </div>
      </details>
    </div>
  );
}
