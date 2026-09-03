// Italian mirror of src/data/homepage.ts. Hand-translated, following the same
// pattern as src/pages/it/agency-blueprint.astro and src/pages/de/alternatives/*
// (no i18n runtime, full copy per locale).
//
// Only the prose is translated. Every number, product claim and row here must
// stay identical to the English source: this file inherits CMS_LIST,
// LOCALE_COUNT and READINESS_SCAN from homepage.ts rather than restating them,
// so a change to the evidenced numbers cannot drift between locales.
//
// Tone follows the Italian outreach copy: informal-professional `tu`, peer to
// peer, never markety. Typographic apostrophes (’) throughout, both because it
// is correct Italian and because a straight quote breaks a single-quoted
// Astro attribute if this copy is ever inlined.
export { CMS_LIST, LOCALE_COUNT, READINESS_SCAN, COMPARISON_THEM } from './homepage';

export const STEPS_IT = [
  {
    n: 1,
    title: 'Aggiungi un dominio',
    desc: 'Incolla un URL. AltoRank crea il workspace, analizza le pagine, confronta i competitor e trova le parole chiave con un margine reale. Nessuna configurazione.',
  },
  {
    n: 2,
    title: 'Costruisci il piano',
    desc: 'Un calendario di 30 giorni, una parola chiave al giorno, ordinata per traffico rispetto alla difficoltà per quel dominio specifico. Colleghi Google Search Console e il piano parte dai tuoi click, impression e posizioni reali, in sola lettura, invece che da una stima.',
  },
  {
    n: 3,
    title: 'Bozza e revisione',
    desc: 'Ogni mattina una bozza nella tua voce, con punteggio SEO e link interni. La approvi o la rimandi indietro. Non c’è una terza opzione.',
  },
  {
    n: 4,
    title: 'Pubblica',
    desc: 'Gli articoli approvati vanno su Shopify, WordPress, Webflow, WooCommerce o su una delle altre sette destinazioni.',
  },
];

// Same rows, same order, same claims as COMPARISON in homepage.ts. The
// deliberately absent backlink-exchange row stays absent here too.
export const COMPARISON_IT = [
  { label: 'Codice sorgente', legacy: 'Chiuso', ours: 'Open source, tutto quanto' },
  { label: 'Puoi eseguirlo tu', legacy: 'Non previsto', ours: 'Self-host gratis, senza funzioni bloccate' },
  { label: 'Dove vivono i tuoi dati', legacy: 'Sulla loro infrastruttura', ours: 'Sulla tua, se fai self-hosting' },
  { label: 'Pubblicazione', legacy: 'Autopilot, pubblica senza di te', ours: 'Approvi tu, altrimenti non esce' },
  { label: 'Logica di scoring e ranking', legacy: 'Non ispezionabile', ours: 'Codice leggibile che puoi verificare' },
  { label: 'Più di un sito', legacy: 'Prezzo per sito', ours: 'Un workspace per sito, o per cliente' },
  { label: 'Prezzo di partenza', legacy: 'Solo in abbonamento', ours: '0 $ in self-hosting' },
  { label: 'Prova gratuita', legacy: 'Prova di 3 giorni, carta subito, addebito al terzo giorno', ours: 'Nessuna. Nulla viene addebitato finché non scegli un piano' },
  { label: 'Disdetta', legacy: 'Tramite assistenza, o con un flusso di retention', ours: 'Un pulsante nella tua pagina di fatturazione' },
  { label: 'Dopo la disdetta', legacy: 'L’accesso finisce con il piano', ours: 'Articoli e cronologia restano leggibili' },
];

// Column header over the `legacy` values in the table (the mobile cards use
// COMPARISON_THEM, the competitor names, exactly as the English page does).
export const COMPARISON_LEGACY_HEADER_IT = 'Stack SEO tradizionale';

export const OSS_BULLETS_IT = [
  'Workspace multi-cliente',
  'Report white-label',
  'Tutte e 12 le destinazioni di pubblicazione',
  'Gate di approvazione editoriale',
  'L’algoritmo di scoring SEO, leggibile',
];
