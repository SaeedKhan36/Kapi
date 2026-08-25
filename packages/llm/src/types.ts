import type { z } from "zod";

export type ModelTier = "planning" | "coding" | "cheap";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export type GenerateOptions = {
  tier?: ModelTier;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type Usage = { inputTokens: number; outputTokens: number; requests: number };

export type GenerateResult = { text: string; usage: Usage; model: string; provider: string };

export interface LLMProvider {
  readonly name: string;
  isAvailable(): boolean;
  modelFor(tier: ModelTier): string;
  generate(messages: LlmMessage[], opts?: GenerateOptions): Promise<GenerateResult>;
  /** Structured output validated against a Zod schema, with repair retries. */
  generateStructured<T>(
    messages: LlmMessage[],
    schema: z.ZodType<T, z.ZodTypeDef, any>,
    opts?: GenerateOptions & { maxRepairAttempts?: number },
  ): Promise<{ value: T; usage: Usage; model: string; provider: string }>;
}

export class QuotaExceededError extends Error {
  constructor(readonly provider: string, message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class StructuredOutputError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}
