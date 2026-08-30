import Anthropic from "@anthropic-ai/sdk";
import type { VoiceRules } from "./types";
import { anthropicModel } from "./models";

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
 * Analyze writing samples using Claude to extract deep voice rules.
 * Falls back gracefully if the API key isn't configured.
 */
export async function analyzeVoiceWithAI(
  sampleTexts: string[],
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
    system: ANALYSIS_PROMPT,
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
