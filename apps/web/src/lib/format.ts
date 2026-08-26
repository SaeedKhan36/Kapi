/** "4m ago" - short enough to sit in a metadata row without wrapping. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";

  const units: Array<[limit: number, size: number, suffix: string]> = [
    [3600, 60, "m"],
    [86400, 3600, "h"],
    [2592000, 86400, "d"],
  ];
  for (const [limit, size, suffix] of units) {
    if (seconds < limit) return `${Math.round(seconds / size)}${suffix} ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** 1_240 -> "1.2k". Token counts are context, not accounting. */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "you/repo" out of a clone URL, for a header that should not wrap. */
export function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/, "");
}
