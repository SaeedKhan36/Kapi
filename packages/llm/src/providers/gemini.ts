import type { z } from "zod";
import type {
  GenerateOptions, GenerateResult, LLMProvider, LlmMessage, ModelTier, Usage,
} from "../types.ts";
import { QuotaExceededError, StructuredOutputError } from "../types.ts";
import { extractJson } from "../json.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Google AI Studio - the only genuinely free tier that survives a coding agent
 * (~1,500 requests/day, 1M context, no credit card).
 *
 * Model routing by tier keeps the daily quota alive: deep reasoning only where
 * it changes the outcome (planning), fast Flash everywhere else.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";

  static DEFAULT_MODELS: Record<ModelTier, string> = {
    planning: process.env.KAPI_MODEL_PLANNING ?? "gemini-3.1-pro-preview",
    coding: process.env.KAPI_MODEL_CODING ?? "gemini-3.7-flash",
    cheap: process.env.KAPI_MODEL_CHEAP ?? "gemini-3.7-flash",
  };

  constructor(
    private apiKey = process.env.GEMINI_API_KEY,
    private models = GeminiProvider.DEFAULT_MODELS,
  ) {}

  isAvailable() { return Boolean(this.apiKey); }
  modelFor(tier: ModelTier = "coding") { return this.models[tier]; }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY is not set (get one free at aistudio.google.com/apikey)");
    const model = this.modelFor(opts.tier ?? "coding");

    const systemParts = [opts.system, ...messages.filter((m) => m.role === "system").map((m) => m.content)]
      .filter(Boolean).join("\n\n");

    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    };
    if (systemParts) body.systemInstruction = { parts: [{ text: systemParts }] };

    const res = await fetchWithRetry(
      `${API}/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: opts.signal,
      },
      this.name,
    );

    const json: any = await res.json();
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text ?? "").join("").trim();

    if (!text) {
      const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? "unknown";
      throw new Error(`gemini returned no text (finishReason: ${reason})`);
    }

    const usage: Usage = {
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      requests: 1,
    };
    return { text, usage, model, provider: this.name };
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
        system: [opts.system, "Respond with a single valid JSON value and nothing else. No prose, no markdown fences."]
          .filter(Boolean).join("\n\n"),
      });
      total.inputTokens += result.usage.inputTokens;
      total.outputTokens += result.usage.outputTokens;
      total.requests += result.usage.requests;
      lastRaw = result.text;

      try {
        const parsed = schema.safeParse(JSON.parse(extractJson(result.text)));
        if (parsed.success) {
          return { value: parsed.data, usage: total, model: result.model, provider: this.name };
        }
        lastError = parsed.error.issues
          .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
      } catch (err) {
        lastError = `response was not parsable JSON: ${String(err)}`;
      }

      // Feed the failure back so the model repairs rather than re-guesses.
      convo.push({ role: "assistant", content: result.text });
      convo.push({
        role: "user",
        content: `That response was rejected by schema validation:\n${lastError}\n\nReturn corrected JSON only.`,
      });
    }

    throw new StructuredOutputError(
      `failed to obtain schema-valid JSON after ${maxRepairs + 1} attempts:\n${lastError}`,
      lastRaw,
    );
  }
}

/** Retries 429/5xx with exponential backoff; converts exhausted quota into a typed error. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  provider: string,
  maxAttempts = 4,
): Promise<Response> {
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    lastBody = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new Error(`${provider} HTTP ${res.status}: ${lastBody.slice(0, 500)}`);

    if (attempt === maxAttempts) {
      if (res.status === 429) {
        throw new QuotaExceededError(provider, `rate limit / daily quota exhausted: ${lastBody.slice(0, 300)}`);
      }
      throw new Error(`${provider} HTTP ${res.status} after ${maxAttempts} attempts`);
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`${provider}: unreachable`);
}
