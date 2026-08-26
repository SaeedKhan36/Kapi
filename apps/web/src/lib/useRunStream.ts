import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
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

    // Proof is a short-lived ticket minted over HTTP (Authorization header),
    // not the session JWT: browsers cannot set WebSocket headers, and a JWT
    // in the query string would land in access logs. Minted per attempt so a
    // reconnect minutes into a run does not present an expired handle.
    const connect = async () => {
      if (closed) return;
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const { ticket } = await api.wsTicket(runId);
        if (closed) return;

        const params = new URLSearchParams({ runId, ticket });
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
      } catch {
        if (closed) return;
        timer = setTimeout(() => void connect(), Math.min(8000, 500 * 2 ** retry++));
      }
    };

    void connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
  }, [runId]);

  return connected;
}
