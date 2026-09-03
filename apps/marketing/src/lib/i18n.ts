import { APP_LIVE, PRIMARY_CTA } from '@/constants';

/**
 * UI chrome copy for the localised pages (/it, /de).
 *
 * Only LABELS translate. Every destination stays on its English URL, because
 * /it and /de carry three pages between them and there is no localised
 * /pricing, /blog or /about to point at. Sending an Italian reader to an
 * English pricing page is the honest outcome; minting /it/pricing links that
 * 404 is not. Revisit that decision if the localised surface ever grows.
 *
 * Nav and footer entries are keyed by HREF rather than by their English label,
 * so rewording a label in constants.ts cannot silently orphan a translation.
 * Anything missing falls back to the English string the component already has,
 * which means a new link ships untranslated rather than blank.
 *
 * Register follows what each locale's existing pages already use: German is
 * formal (Sie), Italian informal (tu). "Open source" and "Approval-first" stay
 * in English in both, as brand and category terms that are used untranslated
 * in those markets.
 */
export type Lang = 'en' | 'it' | 'de';

const LANGS = new Set<Lang>(['en', 'it', 'de']);

export function resolveLang(lang: string | undefined): Lang {
  return LANGS.has(lang as Lang) ? (lang as Lang) : 'en';
}

interface Chrome {
  navAria: string;
  menuAria: string;
  signIn: string;
  signUp: string;
  /** Nav CTA. Mirrors the APP_LIVE branch so flipping it cannot strand these. */
  ctaShort: string;
  /** Label by href, for NAV_LINKS and the footer's link groups. */
  links: Record<string, string>;
  /** Footer column headings, keyed by the English group name. */
  groups: Record<string, string>;
  tagline: string;
  rights: string;
  productOf: string;
  vat: string;
  cta: { heading: string; body: string; secondary: string; label: string; note: string | null };
}

export const CHROME: Record<Lang, Chrome> = {
  en: {
    navAria: 'Primary',
    menuAria: 'Menu',
    signIn: 'Sign in',
    signUp: 'Sign up',
    ctaShort: PRIMARY_CTA.short,
    links: {},
    groups: {},
    tagline:
      "The open-source AI SEO content engine. Research, write, and publish, with an editor's approval on everything that ships.",
    rights: 'All rights reserved.',
    productOf: 'A product of',
    vat: 'VAT',
    cta: {
      heading: 'Read the source before you trust it with your site.',
      body: 'Self-host it free and run it yourself, or let us host it. Either way nothing goes live on your site until you say so.',
      secondary: 'Self-host it free',
      label: PRIMARY_CTA.label,
      note: PRIMARY_CTA.note,
    },
  },
  it: {
    navAria: 'Principale',
    menuAria: 'Menu',
    signIn: 'Accedi',
    signUp: 'Registrati',
    ctaShort: APP_LIVE ? 'Aggiungi dominio' : 'Prenota una demo',
    links: {
      '/#how-it-works': 'Come funziona',
      '/#features': 'Funzionalità',
      '/open-source': 'Open source',
      '/approval-first-seo-content': 'Approval-first',
      '/alternatives': 'Alternative',
      '/pricing': 'Prezzi',
      '/blog': 'Blog',
      '/success-stories': 'Casi studio',
      '/tools': 'Strumenti gratuiti',
      '/geo': 'Guide GEO',
      '/agency-blueprint': 'Il piano per le agenzie',
      '/about': 'Chi siamo',
      '/privacy': 'Privacy',
      '/terms': 'Termini',
    },
    groups: { Product: 'Prodotto', Resources: 'Risorse', Company: 'Azienda' },
    tagline:
      'Il motore open source di contenuti SEO con AI. Ricerca, scrive e pubblica, con l’approvazione di un editor su tutto ciò che va online.',
    rights: 'Tutti i diritti riservati.',
    productOf: 'Un prodotto di',
    vat: 'P. IVA',
    cta: {
      heading: 'Leggi il codice prima di affidargli il tuo sito.',
      body: 'Installalo gratis sulla tua infrastruttura, oppure lascia che lo ospitiamo noi. In ogni caso niente va online sul tuo sito finché non lo dici tu.',
      secondary: 'Installalo gratis',
      label: APP_LIVE ? 'Aggiungi il tuo dominio' : 'Prenota una demo di 20 minuti',
      note: APP_LIVE ? 'Aggiungi un dominio e il workspace si configura da sé' : null,
    },
  },
  de: {
    navAria: 'Hauptnavigation',
    menuAria: 'Menü',
    signIn: 'Anmelden',
    signUp: 'Registrieren',
    ctaShort: APP_LIVE ? 'Domain hinzufügen' : 'Demo buchen',
    links: {
      '/#how-it-works': 'So funktioniert es',
      '/#features': 'Funktionen',
      '/open-source': 'Open Source',
      '/approval-first-seo-content': 'Approval-first',
      '/alternatives': 'Alternativen',
      '/pricing': 'Preise',
      '/blog': 'Blog',
      '/success-stories': 'Erfolgsgeschichten',
      '/tools': 'Kostenlose Tools',
      '/geo': 'GEO-Guides',
      '/agency-blueprint': 'Agentur-Blueprint',
      '/about': 'Über uns',
      '/privacy': 'Datenschutz',
      '/terms': 'AGB',
    },
    groups: { Product: 'Produkt', Resources: 'Ressourcen', Company: 'Unternehmen' },
    tagline:
      'Die quelloffene KI-Engine für SEO-Inhalte. Recherchieren, schreiben und veröffentlichen, mit der Freigabe eines Redakteurs für alles, was live geht.',
    rights: 'Alle Rechte vorbehalten.',
    productOf: 'Ein Produkt von',
    vat: 'USt-IdNr.',
    cta: {
      heading: 'Lesen Sie den Quellcode, bevor Sie ihm Ihre Website anvertrauen.',
      body: 'Hosten Sie es kostenlos selbst, oder lassen Sie uns das übernehmen. So oder so geht nichts auf Ihrer Website live, bevor Sie es freigeben.',
      secondary: 'Kostenlos selbst hosten',
      label: APP_LIVE ? 'Domain hinzufügen' : 'Demo buchen (20 Minuten)',
      note: APP_LIVE ? 'Domain hinzufügen, der Workspace wird automatisch eingerichtet' : null,
    },
  },
};

export function chrome(lang: string | undefined): Chrome {
  return CHROME[resolveLang(lang)];
}

/** Translated label for a link, falling back to the English one it ships with. */
export function linkLabel(c: Chrome, href: string, fallback: string): string {
  return c.links[href] ?? fallback;
}
