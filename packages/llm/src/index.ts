import { GeminiProvider } from "./providers/gemini.ts";
import { OpenAICompatProvider } from "./providers/openai-compat.ts";
import { RoutedLLM, type Budget, type BudgetSnapshot } from "./router.ts";
import type { LLMProvider } from "./types.ts";

export * from "./types.ts";
export * from "./router.ts";
export { GeminiProvider, OpenAICompatProvider };
export { extractJson } from "./json.ts";

/**
 * Default chain, ordered by free-tier capability:
 * Gemini (1,500 rpd, 1M context) -> Groq (fast, ~1k rpd) -> Cerebras (1M tok/day).
 */
export function createLLM(opts: { budget?: Budget; onUsage?: (s: BudgetSnapshot) => void } = {}): RoutedLLM {
  const chain: LLMProvider[] = [
    new GeminiProvider(),
    OpenAICompatProvider.groq(),
    OpenAICompatProvider.cerebras(),
  ];
  return new RoutedLLM(chain, opts.budget, opts.onUsage);
}
