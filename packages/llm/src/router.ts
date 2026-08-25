import type { z } from "zod";
import type { GenerateOptions, GenerateResult, LLMProvider, LlmMessage, ModelTier, Usage } from "./types.ts";
import { BudgetExceededError } from "./types.ts";

export type Budget = { maxRequests: number; maxTokens: number };

export type BudgetSnapshot = Usage & {
  maxRequests: number;
  maxTokens: number;
  totalTokens: number;
};

/**
 * Fronts an ordered list of providers with two jobs the free tier makes
 * mandatory:
 *
 *   1. Failover - when Gemini's daily quota is gone, fall through to Groq then
 *      Cerebras rather than failing the run.
 *   2. Budget - hard caps on requests and tokens per run. A runaway agent loop
 *      on a free key otherwise silently burns the entire day's quota.
 */
export class RoutedLLM implements LLMProvider {
  readonly name = "routed";
  #used: Usage = { inputTokens: 0, outputTokens: 0, requests: 0 };

  constructor(
    private providers: LLMProvider[],
    private budget: Budget = {
      maxRequests: Number(process.env.MAX_LLM_REQUESTS_PER_RUN ?? 300),
      maxTokens: Number(process.env.MAX_LLM_TOKENS_PER_RUN ?? 2_000_000),
    },
    private onUsage?: (snapshot: BudgetSnapshot) => void,
  ) {}

  get available(): LLMProvider[] {
    return this.providers.filter((p) => p.isAvailable());
  }

  isAvailable() { return this.available.length > 0; }

  modelFor(tier: ModelTier = "coding") {
    return this.available[0]?.modelFor(tier) ?? "none";
  }

  usage(): BudgetSnapshot {
    return {
      ...this.#used,
      totalTokens: this.#used.inputTokens + this.#used.outputTokens,
      maxRequests: this.budget.maxRequests,
      maxTokens: this.budget.maxTokens,
    };
  }

  #assertBudget() {
    const totalTokens = this.#used.inputTokens + this.#used.outputTokens;
    if (this.#used.requests >= this.budget.maxRequests) {
      throw new BudgetExceededError(
        `run hit its request budget (${this.#used.requests}/${this.budget.maxRequests}). ` +
          `Raise MAX_LLM_REQUESTS_PER_RUN if this is expected.`,
      );
    }
    if (totalTokens >= this.budget.maxTokens) {
      throw new BudgetExceededError(
        `run hit its token budget (${totalTokens}/${this.budget.maxTokens}). ` +
          `Raise MAX_LLM_TOKENS_PER_RUN if this is expected.`,
      );
    }
  }

  #record(usage: Usage) {
    this.#used.inputTokens += usage.inputTokens;
    this.#used.outputTokens += usage.outputTokens;
    this.#used.requests += usage.requests;
    this.onUsage?.(this.usage());
  }

  async #withFailover<T extends { usage: Usage }>(
    fn: (provider: LLMProvider) => Promise<T>,
  ): Promise<T> {
    this.#assertBudget();
    const candidates = this.available;
    if (candidates.length === 0) {
      throw new Error(
        "no LLM provider configured - set GEMINI_API_KEY (free at aistudio.google.com/apikey)",
      );
    }

    const failures: string[] = [];
    for (const provider of candidates) {
      try {
        const result = await fn(provider);
        this.#record(result.usage);
        return result;
      } catch (err) {
        // The budget is ours, not the provider's - failing over would just burn
        // another key against a limit we already decided to enforce.
        if (err instanceof BudgetExceededError) throw err;
        failures.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`all LLM providers failed:\n${failures.map((f) => "  - " + f).join("\n")}`);
  }

  generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult> {
    return this.#withFailover((p) => p.generate(messages, opts));
  }

  generateStructured<T>(
    messages: LlmMessage[],
    schema: z.ZodType<T, z.ZodTypeDef, any>,
    opts?: GenerateOptions & { maxRepairAttempts?: number },
  ) {
    return this.#withFailover((p) => p.generateStructured(messages, schema, opts));
  }
}
