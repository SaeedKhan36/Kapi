import type { z } from "zod";
import type {
  GenerateOptions, GenerateResult, LLMProvider, LlmMessage, ModelTier, Usage,
} from "../types.ts";
import { QuotaExceededError, StructuredOutputError } from "../types.ts";
import { extractJson } from "../json.ts";

/**
 * Groq and Cerebras both speak the OpenAI chat-completions shape, so one
 * implementation covers both failover targets.
 */
export class OpenAICompatProvider implements LLMProvider {
  constructor(
    readonly name: string,
    private baseUrl: string,
    private apiKey: string | undefined,
    private models: Record<ModelTier, string>,
  ) {}

  static groq() {
    return new OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", process.env.GROQ_API_KEY, {
      planning: process.env.KAPI_GROQ_PLANNING ?? "llama-3.3-70b-versatile",
      coding: process.env.KAPI_GROQ_CODING ?? "llama-3.3-70b-versatile",
      cheap: process.env.KAPI_GROQ_CHEAP ?? "llama-3.1-8b-instant",
    });
  }

  static cerebras() {
    return new OpenAICompatProvider("cerebras", "https://api.cerebras.ai/v1", process.env.CEREBRAS_API_KEY, {
      planning: process.env.KAPI_CEREBRAS_PLANNING ?? "llama-3.3-70b",
      coding: process.env.KAPI_CEREBRAS_CODING ?? "llama-3.3-70b",
      cheap: process.env.KAPI_CEREBRAS_CHEAP ?? "llama3.1-8b",
    });
  }

  isAvailable() { return Boolean(this.apiKey); }
  modelFor(tier: ModelTier = "coding") { return this.models[tier]; }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    if (!this.apiKey) throw new Error(`${this.name.toUpperCase()}_API_KEY is not set`);
    const model = this.modelFor(opts.tier ?? "coding");
    const payload = {
      model,
      messages: opts.system ? [{ role: "system", content: opts.system }, ...messages] : messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxOutputTokens ?? 8192,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 429) throw new QuotaExceededError(this.name, body.slice(0, 300));
      throw new Error(`${this.name} HTTP ${res.status}: ${body.slice(0, 400)}`);
    }

    const json: any = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error(`${this.name} returned no text`);

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        requests: 1,
      },
      model,
      provider: this.name,
    };
  }

  async generateStructured<T>(
    messages: LlmMessage[],
    schema: z.ZodType<T, z.ZodTypeDef, any>,
    opts: GenerateOptions & { maxRepairAttempts?: number } = {},
  ) {
    const maxRepairs = opts.maxRepairAttempts ?? 2;
    const convo = [...messages];
    const total: Usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
    let lastRaw = "";
    let lastError = "";

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const result = await this.generate(convo, {
        ...opts,
        system: [opts.system, "Respond with a single valid JSON value and nothing else."]
          .filter(Boolean).join("\n\n"),
      });
      total.inputTokens += result.usage.inputTokens;
      total.outputTokens += result.usage.outputTokens;
      total.requests += result.usage.requests;
      lastRaw = result.text;

      try {
        const parsed = schema.safeParse(JSON.parse(extractJson(result.text)));
        if (parsed.success) return { value: parsed.data, usage: total, model: result.model, provider: this.name };
        lastError = parsed.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      } catch (err) {
        lastError = `response was not parsable JSON: ${String(err)}`;
      }

      convo.push({ role: "assistant", content: result.text });
      convo.push({ role: "user", content: `Schema validation failed:\n${lastError}\n\nReturn corrected JSON only.` });
    }

    throw new StructuredOutputError(`failed after ${maxRepairs + 1} attempts:\n${lastError}`, lastRaw);
  }
}
