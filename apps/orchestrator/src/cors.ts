/**
 * Who may call this API from a browser.
 *
 * The dashboard is same-origin in both development (Vite) and production
 * (`apps/web/server.mjs` proxies `/api`), so a well-deployed kapi never needs
 * CORS for its own UI. CORS exists for the cases that are not that: a split
 * origin during a migration, a local dashboard pointed at a remote API, or a
 * caller that is not the dashboard at all.
 *
 * Single-operator mode reflects any origin — there is one trusted user.
 * Multi-user mode reflects nothing unless `KAPI_PUBLIC_URL` or
 * `KAPI_CORS_ORIGINS` names the dashboard, because an open API in front of
 * Clerk is how a stranger spends someone else's sandbox budget.
 */
export type CorsPolicy = {
  /** Reflect any Origin. Only legitimate when there is one operator. */
  open: boolean;
  origins: string[];
};

export function corsPolicy(
  env: NodeJS.ProcessEnv = process.env,
  mode: "clerk" | "workos" | "none" = "none",
): CorsPolicy {
  const origins = new Set<string>();
  for (const raw of (env.KAPI_CORS_ORIGINS ?? "").split(",")) {
    const origin = normalizeOrigin(raw);
    if (origin) origins.add(origin);
  }
  const pub = normalizeOrigin(env.KAPI_PUBLIC_URL);
  if (pub) origins.add(pub);

  if (origins.size > 0) return { open: false, origins: [...origins] };
  return { open: mode === "none", origins: [] };
}

/** The value to put in `Access-Control-Allow-Origin`, or undefined to refuse. */
export function allowCorsOrigin(origin: string | undefined, policy: CorsPolicy): string | undefined {
  if (!origin) return undefined;
  if (policy.open) return origin;
  return policy.origins.includes(origin) ? origin : undefined;
}

function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}
