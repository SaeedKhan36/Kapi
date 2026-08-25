import type { LLMProvider } from "@kapi/llm";
import { DirectEngine } from "./engines/direct.ts";
import { AiderEngine } from "./engines/aider.ts";
import type { CodingEngine } from "./types.ts";

export * from "./types.ts";
export * from "./git-ops.ts";
export { DirectEngine, AiderEngine };

export type EngineName = "direct" | "aider";

export function createCodingEngine(
  llm: LLMProvider,
  name: EngineName = (process.env.KAPI_ENGINE as EngineName) ?? "direct",
): CodingEngine {
  switch (name) {
    case "aider": return new AiderEngine();
    case "direct": return new DirectEngine(llm);
    default: throw new Error(`unknown KAPI_ENGINE "${name}" (expected direct|aider)`);
  }
}
