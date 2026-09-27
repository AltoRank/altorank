import Anthropic from "@anthropic-ai/sdk";
import type { VoiceRules } from "./types";
import { anthropicModel } from "./models";
import { resolveLocale, UNKNOWN_LANGUAGE } from "@/lib/i18n/locale";

const ANALYSIS_PROMPT = `You are a writing style analyst. Analyze the following sample text(s) and extract a detailed voice profile. Return a JSON object with these exact fields:

{
  "tone": "Brief description of overall tone",
  "toneArchetype": "One of: authoritative, friendly, witty, empathetic, provocative, analytical, inspirational, conversational",
  "formalityLevel": "One of: casual, conversational, professional, formal, academic",
  "sentenceRhythm": "Describe the sentence rhythm pattern (e.g., 'Short punchy sentences mixed with occasional longer explanatory ones')",
  "emotionalRegister": "Describe the emotional quality (e.g., 'warm and encouraging with subtle urgency')",
  "technicalDepth": "One of: beginner, intermediate, advanced, expert",
  "audienceAwareness": "Who the writing seems aimed at",
  "vocabulary": ["array", "of", "frequently", "used", "distinctive", "words"],
  "avoidPatterns": ["patterns", "the", "writer", "avoids"],
  "signaturePhrases": ["recurring", "phrases", "or", "constructions"],
  "writingPatterns": ["specific", "structural", "patterns"],
  "tags": ["short", "descriptive", "labels"]
}

Return ONLY valid JSON, no markdown fences or explanation.`;

/**
 * The language line for the analysis. The model reads any language; what it
 * needs telling is that the samples are not English, so it quotes vocabulary
 * and phrases as written and describes pronouns as the language carries them
 * - a Turkish "we" is usually a suffix ("ekibimiz", "sunuyoruz"), not "biz",
 * and a profile that looked only for the pronoun missed it on 2026-09-22.
 */
export function voiceLanguageNote(language?: string | null): string {
  const locale = resolveLocale(language);
  // Unread is not English: the model can tell the language from the text.
  const name = locale.code === UNKNOWN_LANGUAGE ? "the samples' own language (identify it from the text)" : locale.name;
  return (
    `The samples are written in ${name}. Quote vocabulary, signature phrases and patterns in ${name} exactly as written, ` +
    `never translated. Describe person and address (first-person plural or singular, formal or informal "you") as ${name} expresses them, ` +
    `including through verb endings and possessive suffixes, not only through pronouns.`
  );
}

/**
 * Analyze writing samples using Claude to extract deep voice rules.
 * Falls back gracefully if the API key isn't configured.
 */
export async function analyzeVoiceWithAI(
  sampleTexts: string[],
  language?: string | null,
): Promise<VoiceRules> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const client = new Anthropic({ apiKey });

  const combined = sampleTexts
    .map((t, i) => `--- Sample ${i + 1} ---\n${t}`)
    .join("\n\n");

  const response = await client.messages.create({
    // Content tier: this reads a client's writing to derive their voice, and a
    // weaker read produces a voice profile that skews every future article.
    model: anthropicModel("content"),
    max_tokens: 1024,
    system: `${ANALYSIS_PROMPT}\n\n${voiceLanguageNote(language)}`,
    messages: [{ role: "user", content: combined }],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Strip potential markdown fences
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "");

  try {
    const parsed = JSON.parse(cleaned) as VoiceRules;
    return parsed;
  } catch {
    throw new Error("Failed to parse AI voice analysis response");
  }
}
