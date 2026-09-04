// The handful of fixed strings the enrichment writes into an article, in the
// languages the product generates in. Anything not listed falls back to
// English rather than to a machine translation: a wrong label in the reader's
// language is worse than a right one in the wrong language.

export type Labels = {
  contents: string;
  video: string;
  onYouTube: string;
  figuresFrom: string;
  learnMore: (name: string) => string;
  publishedBy: (name: string) => string;
  visit: string;
  illustration: Record<ImageStyle, string>;
};

export type ImageStyle = "sketch" | "watercolor" | "realistic" | "illustration" | "brand-text";

const EN: Labels = {
  contents: "Contents",
  video: "Video",
  onYouTube: "on YouTube",
  figuresFrom: "Figures from the text:",
  learnMore: (name) => `Learn more about ${name}`,
  publishedBy: (name) => `This article is published by ${name}.`,
  visit: "Visit",
  illustration: {
    sketch: "Sketch illustrating",
    watercolor: "Watercolour illustration of",
    realistic: "Photo-style image illustrating",
    illustration: "Illustration of",
    "brand-text": "Graphic illustrating",
  },
};

const LABELS: Record<string, Labels> = {
  en: EN,
  it: {
    contents: "Indice",
    video: "Video",
    onYouTube: "su YouTube",
    figuresFrom: "Dati tratti dal testo:",
    learnMore: (name) => `Scopri di più su ${name}`,
    publishedBy: (name) => `Questo articolo è pubblicato da ${name}.`,
    visit: "Visita",
    illustration: {
      sketch: "Schizzo che illustra",
      watercolor: "Acquerello che illustra",
      realistic: "Immagine fotografica che illustra",
      illustration: "Illustrazione di",
      "brand-text": "Grafica che illustra",
    },
  },
  es: {
    contents: "Índice",
    video: "Vídeo",
    onYouTube: "en YouTube",
    figuresFrom: "Cifras tomadas del texto:",
    learnMore: (name) => `Más información sobre ${name}`,
    publishedBy: (name) => `Este artículo es publicado por ${name}.`,
    visit: "Visita",
    illustration: {
      sketch: "Boceto que ilustra",
      watercolor: "Acuarela que ilustra",
      realistic: "Imagen fotográfica que ilustra",
      illustration: "Ilustración de",
      "brand-text": "Gráfico que ilustra",
    },
  },
  fr: {
    contents: "Sommaire",
    video: "Vidéo",
    onYouTube: "sur YouTube",
    figuresFrom: "Chiffres tirés du texte :",
    learnMore: (name) => `En savoir plus sur ${name}`,
    publishedBy: (name) => `Cet article est publié par ${name}.`,
    visit: "Visitez",
    illustration: {
      sketch: "Croquis illustrant",
      watercolor: "Aquarelle illustrant",
      realistic: "Image photographique illustrant",
      illustration: "Illustration de",
      "brand-text": "Graphique illustrant",
    },
  },
  de: {
    contents: "Inhalt",
    video: "Video",
    onYouTube: "auf YouTube",
    figuresFrom: "Zahlen aus dem Text:",
    learnMore: (name) => `Mehr über ${name}`,
    publishedBy: (name) => `Dieser Artikel wird von ${name} veröffentlicht.`,
    visit: "Besuchen Sie",
    illustration: {
      sketch: "Skizze zu",
      watercolor: "Aquarell zu",
      realistic: "Fotografische Darstellung von",
      illustration: "Illustration zu",
      "brand-text": "Grafik zu",
    },
  },
};

export function labelsFor(language: string | null | undefined): Labels {
  const code = (language ?? "en").toLowerCase().slice(0, 2);
  return LABELS[code] ?? EN;
}
