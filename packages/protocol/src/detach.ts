/**
 * Fire-and-forget work that must not take the process down with it.
 *
 * Node has thrown on unhandled rejections since v15, so a bare `void
 * somePromise()` is a live grenade in a long-running process: one dropped
 * database connection while persisting an audit row, and the orchestrator
 * exits - killing every run in flight and orphaning their sandboxes, which
 * bill per second.
 *
 * The work here is genuinely secondary - persisting a log line, warming a
 * subscription. Losing one is a bad afternoon; losing the run that was paying
 * for a sandbox is a bad week. So failures are logged loudly and swallowed.
 *
 * Anything a run's *correctness* depends on must be awaited instead. This is
 * not a way to ignore errors, only a way to keep bookkeeping from being fatal.
 */
export function detach(work: Promise<unknown>, what: string): void {
  void work.catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[kapi] ${what} failed (continuing): ${detail}`);
  });
}
