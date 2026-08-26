import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "./auth.ts";
import type { RunEvent } from "./types.ts";

/**
 * Live run feed. Reconnects with backoff, because a run outlives any single
 * socket and the browser should not need a refresh to keep watching.
 */
export function useRunStream(runId: string | null, onEvent: (e: RunEvent) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!runId) return;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    // The token goes in the query string because a browser cannot set headers
    // on a WebSocket, and it is fetched per attempt rather than once: a
    // reconnect minutes into a run must not present an expired session.
    const connect = async () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const token = await getAccessToken();
      if (closed) return;

      const params = new URLSearchParams({ runId });
      if (token) params.set("token", token);
      socket = new WebSocket(`${proto}://${location.host}/ws?${params}`);

      socket.onopen = () => { retry = 0; setConnected(true); };
      socket.onmessage = (ev) => {
        try { handler.current(JSON.parse(ev.data) as RunEvent); } catch { /* ignore malformed frame */ }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        timer = setTimeout(() => void connect(), Math.min(8000, 500 * 2 ** retry++));
      };
      socket.onerror = () => socket?.close();
    };

    void connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [runId]);

  return connected;
}
