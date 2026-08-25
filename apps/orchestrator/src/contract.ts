import type { SharedContract } from "@kapi/protocol";

/** Renders the shared contract into the prompt block every worker receives. */
export function renderContract(contract: SharedContract): string {
  const lines: string[] = [contract.summary];

  if (contract.endpoints.length) {
    lines.push("", "API endpoints:");
    for (const e of contract.endpoints) {
      lines.push(`  ${e.method} ${e.path} - ${e.description}`);
      if (e.requestShape) lines.push(`    request:  ${e.requestShape}`);
      if (e.responseShape) lines.push(`    response: ${e.responseShape}`);
    }
  }

  if (contract.tables.length) {
    lines.push("", "Database tables:");
    for (const t of contract.tables) {
      lines.push(`  ${t.name}(${t.columns.map((c) => `${c.name}: ${c.type}`).join(", ")})`);
    }
  }

  if (contract.conventions.length) {
    lines.push("", "Conventions:");
    for (const c of contract.conventions) lines.push(`  - ${c}`);
  }

  return lines.join("\n");
}
