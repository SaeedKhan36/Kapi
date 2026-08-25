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

  /**
   * Ordered candidates per tier. Model availability varies by key and project -
   * a name in the public docs may 404 for a given key - so we fall through the
   * list on NOT_FOUND and remember what worked.
   */
  static MODEL_CANDIDATES: Record<ModelTier, string[]> = {
    // Pro models are deliberately absent: they carry NO free-tier quota and
    // return 429 immediately, so listing them only adds latency before the
    // Flash model that was always going to serve the request.
    planning: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-flash-latest"],
    coding: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-flash-latest"],
    cheap: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.5-flash"],
  };

  static DEFAULT_MODELS: Record<ModelTier, string> = {
    planning: process.env.KAPI_MODEL_PLANNING ?? "gemini-3.5-flash",
    coding: process.env.KAPI_MODEL_CODING ?? "gemini-3.5-flash",
    cheap: process.env.KAPI_MODEL_CHEAP ?? "gemini-3.1-flash-lite",
  };

  /** Models proven to work for this key, so we pay the 404 probe only once. */
  #resolved = new Map<ModelTier, string>();

  constructor(
    // Google's own SDKs read GOOGLE_API_KEY; accept either so a key pasted under
    // the name Google documents does not silently look "unconfigured".
    private apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    private models = GeminiProvider.DEFAULT_MODELS,
  ) {}

  isAvailable() { return Boolean(this.apiKey); }
  modelFor(tier: ModelTier = "coding") { return this.#resolved.get(tier) ?? this.models[tier]; }

  /** Candidate list for a tier: the configured model first, then fallbacks. */
  #candidates(tier: ModelTier): string[] {
    const configured = this.models[tier];
    const rest = GeminiProvider.MODEL_CANDIDATES[tier].filter((m) => m !== configured);
    return [configured, ...rest];
  }

  async generate(messages: LlmMessage[], opts: GenerateOptions = {}): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is not set (get one free at aistudio.google.com/apikey)");
    }
    const tier = opts.tier ?? "coding";

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

    const notFound: string[] = [];
    for (const model of this.#candidates(tier)) {
      let res: Response;
      try {
        res = await fetchWithRetry(
          `${API}/${model}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
            body: JSON.stringify(body),
            signal: opts.signal,
          },
          this.name,
        );
      } catch (err) {
        // Try the next candidate when this model is unusable for THIS key -
        // either invisible (404) or out of quota (429). Both mean "not this
        // model", not "the request was bad".
        if (err instanceof ModelNotAvailableError) { notFound.push(`${model} (unavailable)`); continue; }
        if (err instanceof QuotaExceededError) { notFound.push(`${model} (quota exhausted)`); continue; }
        throw err;
      }

      const json: any = await res.json();
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      // Thinking models return reasoning parts alongside the answer; only the
      // answer is the completion.
      const text = parts
        .filter((p: any) => p?.thought !== true)
        .map((p: any) => p.text ?? "")
        .join("")
        .trim();

      if (!text) {
        const reason = json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? "unknown";
        throw new Error(
          `gemini/${model} returned no text (finishReason: ${reason})` +
            (reason === "MAX_TOKENS" ? " - raise maxOutputTokens; thinking models spend budget before answering" : ""),
        );
      }

      this.#resolved.set(tier, model);
      return {
        text,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
          requests: 1,
        },
        model,
        provider: this.name,
      };
    }

    throw new QuotaExceededError(
      this.name,
      `no usable gemini model for tier "${tier}": ${notFound.join(", ")}`,
    );
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

/** Pulls the violated quota ids out of a Google error body for a readable message. */
function summariseQuota(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const failure = (parsed.error?.details ?? []).find((d: any) => String(d["@type"]).includes("QuotaFailure"));
    const ids = (failure?.violations ?? []).map((v: any) => v.quotaId).filter(Boolean);
    return ids.length ? ids.join(", ") : body.slice(0, 160);
  } catch {
    return body.slice(0, 160);
  }
}

/** Raised when a model name is not visible to the current API key. */
class ModelNotAvailableError extends Error {
  constructor(url: string) {
    super(`model not available: ${url}`);
    this.name = "ModelNotAvailableError";
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
    if (res.status === 404) throw new ModelNotAvailableError(url);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new Error(`${provider} HTTP ${res.status}: ${lastBody.slice(0, 500)}`);

    if (attempt === maxAttempts) {
      if (res.status === 429) {
        throw new QuotaExceededError(provider, `rate limit / daily quota exhausted: ${lastBody.slice(0, 300)}`);
      }
      throw new Error(`${provider} HTTP ${res.status} after ${maxAttempts} attempts`);
    }

    if (res.status === 429 && /PerDay/i.test(lastBody)) {
      throw new QuotaExceededError(provider, `daily quota exhausted: ${summariseQuota(lastBody)}`);
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`${provider}: unreachable`);
}
