import { authHeaders } from "./auth.ts";
import type { Run, RunDetail } from "./types.ts";

/**
 * A failed request the UI can act on.
 *
 * The orchestrator answers a refused run with a code and, where one exists, a
 * URL that fixes it - installing the GitHub App on the repository is a normal
 * next step, not a dead end. Losing that detail in a generic Error would leave
 * the user with "403" and nowhere to go.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly installUrl?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    throw new ApiError(
      (body.error as string) ?? `HTTP ${res.status}`,
      res.status,
      body.code as string | undefined,
      body.installUrl as string | undefined,
    );
  }
  return res.json() as Promise<T>;
};

/** Every call carries the session, when there is one. */
const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    headers: { ...(await authHeaders()), ...init.headers },
  });
  return json<T>(res);
};

export type Health = {
  ok: boolean;
  database: string;
  provider: string;
  llmConfigured: boolean;
  pushEnabled: boolean;
  auth: "clerk" | "workos" | "none";
  githubApp: boolean;
  limits?: {
    /** Workers one run may hold at once. The engine clamps anything above it. */
    maxWorkers: number;
    /** Tasks one run may be planned into. Plans longer than this are trimmed. */
    maxTasks: number;
  };
};

export type Me = {
  user: { id: string; email?: string; name?: string };
  github: {
    connected: boolean;
    connectUrl: string;
    /** True when the provider collects the grant in its own client-side UI. */
    inApp?: boolean;
  };
  githubApp: boolean;
};

export type Repository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt?: string;
};

export type Branch = { name: string; sha: string; protected: boolean };

export type Authorization =
  | { ok: true }
  | { ok: false; reason: string; installUrl?: string; action?: string };

export const api = {
  // Health is public, so it deliberately skips the auth header - it is what
  // the UI uses to discover whether authentication is on in the first place.
  health: () => fetch("/api/health").then(json<Health>),

  /** Short-lived handle for the WebSocket upgrade. Replaces putting a JWT in the URL. */
  wsTicket: (runId: string) =>
    request<{ ticket: string; expiresInSeconds: number }>(
      `/api/ws-tickets?runId=${encodeURIComponent(runId)}`,
      { method: "POST" },
    ),

  me: () => request<Me>("/api/me"),
  listRuns: () => request<Run[]>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),

  listRepos: () => request<{ repositories: Repository[] }>("/api/github/repos"),
  listBranches: (owner: string, repo: string) =>
    request<{ branches: Branch[] }>(
      `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    ),
  authorization: (owner: string, repo: string) =>
    request<Authorization>(
      `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/authorization`,
    ),

  createRun: (body: {
    goal: string; repoUrl: string; baseBranch?: string;
    maxConcurrency?: number; maxTasks?: number;
  }) =>
    request<{ runId: string }>("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};
