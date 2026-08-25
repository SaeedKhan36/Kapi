import type { Run, RunDetail } from "./types.ts";

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  health: () => fetch("/api/health").then(json<{ ok: boolean; database: string; provider: string; llmConfigured: boolean; pushEnabled: boolean }>),
  listRuns: () => fetch("/api/runs").then(json<Run[]>),
  getRun: (id: string) => fetch(`/api/runs/${id}`).then(json<RunDetail>),
  createRun: (body: { goal: string; repoUrl: string; baseBranch?: string; maxConcurrency?: number; maxTasks?: number }) =>
    fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ runId: string }>),
};
