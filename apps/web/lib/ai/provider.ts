import type { AIProvider } from "./types";
import type { AIProviderType } from "@/lib/types";
import { ClaudeProvider } from "./claude";
import { OpenAIProvider } from "./openai";

// ---------------------------------------------------------------------------
// Factory — resolve the right provider based on workspace settings
// ---------------------------------------------------------------------------

export function resolveProvider(
  aiProvider: AIProviderType | null,
  aiModel?: string | null
): AIProvider {
  const provider = aiProvider ?? "claude";
  const model = aiModel ?? undefined;

  switch (provider) {
    case "claude":
      return new ClaudeProvider(model);
    case "openai":
      return new OpenAIProvider(model);
    default:
      throw new Error(`Unsupported AI provider: ${provider}`);
  }
}
