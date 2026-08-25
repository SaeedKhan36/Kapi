import type { SandboxProvider } from "./types.ts";
import { LocalProvider } from "./providers/local.ts";
import { DockerProvider } from "./providers/docker.ts";
import { DaytonaProvider } from "./providers/daytona.ts";

export * from "./types.ts";
export * from "./git.ts";
export { LocalProvider, DockerProvider, DaytonaProvider };

export type ProviderName = "local" | "docker" | "daytona";

export function createSandboxProvider(
  name: ProviderName = (process.env.SANDBOX_PROVIDER as ProviderName) ?? "local",
): SandboxProvider {
  switch (name) {
    case "daytona": return new DaytonaProvider();
    case "docker": return new DockerProvider();
    case "local": return new LocalProvider();
    default: throw new Error(`unknown SANDBOX_PROVIDER "${name}" (expected local|docker|daytona)`);
  }
}

/**
 * Picks the best provider actually usable on this machine, preferring real
 * isolation. Used by the smoke test and by first-run setup.
 */
export async function detectBestProvider(): Promise<SandboxProvider> {
  for (const candidate of [new DaytonaProvider(), new DockerProvider(), new LocalProvider()]) {
    if (await candidate.isAvailable()) return candidate;
  }
  return new LocalProvider();
}
