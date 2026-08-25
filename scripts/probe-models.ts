/** Reports which Gemini models this key can actually call, and their free quota. */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();

const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!key) { console.error("no key"); process.exit(1); }

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["gemini-3.1-pro-preview", "gemini-pro-latest", "gemini-2.5-pro",
     "gemini-3.5-flash", "gemini-flash-latest", "gemini-2.5-flash",
     "gemini-3.1-flash-lite", "gemini-3-flash-preview"];

for (const model of models) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "say OK" }] }],
        generationConfig: { maxOutputTokens: 600 },
      }),
    },
  );
  const j: any = await res.json().catch(() => ({}));
  const pad = model.padEnd(26);

  if (j.error) {
    const q = (j.error.details ?? []).find((d: any) => String(d["@type"]).includes("QuotaFailure"));
    const violations = (q?.violations ?? []).map((v: any) => `${v.quotaId}=${v.quotaValue}`).join(" ");
    console.log(`  ${pad} \x1b[31m${j.error.code} ${j.error.status}\x1b[0m ${violations}`);
  } else {
    const text = (j.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => p?.thought !== true).map((p: any) => p.text ?? "").join("").trim();
    const fr = j.candidates?.[0]?.finishReason;
    console.log(`  ${pad} ${text ? "\x1b[32mOK\x1b[0m " + JSON.stringify(text.slice(0, 16)) : "\x1b[33mempty\x1b[0m fr=" + fr}  tok=${j.usageMetadata?.totalTokenCount ?? "?"}`);
  }
}
