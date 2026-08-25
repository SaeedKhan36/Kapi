/**
 * Verifies model rotation against a stubbed fetch: no network, no quota spent.
 * Rotation is what multiplies a 20-request-per-model-per-day cap into something
 * usable, so it is worth testing directly.
 */
import { GeminiProvider } from "../packages/llm/src/providers/gemini.ts";

let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra ? "  | " + extra : ""}`);
  if (!cond) fail++;
};

const called: string[] = [];
const quotaDead = new Set<string>();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const model = String(url).match(/models\/([^:]+):/)?.[1] ?? "?";
  called.push(model);
  if (quotaDead.has(model)) {
    return new Response(
      JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const run = async () => {
  const provider = new GeminiProvider("test-key");

  // 1. rotation across healthy models
  for (let i = 0; i < 4; i++) await provider.generate([{ role: "user", content: "hi" }], { tier: "coding" });
  const distinct = new Set(called);
  check("spreads across multiple models", distinct.size >= 3, `used: ${[...distinct].join(", ")}`);
  check("does not pin every call to one model", called[0] !== called[1], called.slice(0, 2).join(" then "));

  // 2. exhausted models are skipped, not retried
  called.length = 0;
  quotaDead.add("gemini-3.5-flash");
  quotaDead.add("gemini-3-flash-preview");
  for (let i = 0; i < 3; i++) await provider.generate([{ role: "user", content: "hi" }], { tier: "coding" });
  const deadHits = called.filter((m) => quotaDead.has(m)).length;
  check("stops retrying exhausted models", deadHits <= 2, `${deadHits} wasted call(s) on dead models`);
  check("records which models are exhausted", provider.exhaustedModels.length >= 2,
    provider.exhaustedModels.join(", "));

  // 3. all dead -> a typed quota error, not a generic failure
  called.length = 0;
  ["gemini-2.5-flash", "gemini-flash-latest"].forEach((m) => quotaDead.add(m));
  let threw = "";
  try {
    await provider.generate([{ role: "user", content: "hi" }], { tier: "coding" });
  } catch (err) {
    threw = err instanceof Error ? err.constructor.name : "?";
  }
  check("surfaces QuotaExceededError when every model is spent", threw === "QuotaExceededError", threw);

  globalThis.fetch = realFetch;
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
  process.exit(fail === 0 ? 0 : 1);
};
run();
