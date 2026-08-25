/**
 * LLMs wrap JSON in prose and fences even when told not to. Recover the largest
 * balanced JSON object/array rather than trusting the response to be clean.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();

  const fence = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  const body = fence ? fence[1].trim() : trimmed;

  if ((body.startsWith("{") && body.endsWith("}")) || (body.startsWith("[") && body.endsWith("]"))) {
    return body;
  }

  const start = body.search(/[{[]/);
  if (start === -1) return body;

  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}
