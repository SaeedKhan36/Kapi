import type { RunEvent } from "./run-engine.ts";

type Client = { runId: string | null; send: (data: string) => void };

/**
 * Fan-out of run events to connected browsers.
 *
 * Kept separate from the MessageBus: the bus is the agents' transport, this is
 * the UI's. Conflating them would let a browser inject agent traffic.
 */
export class EventHub {
  #clients = new Set<Client>();
  #recent = new Map<string, RunEvent[]>();

  add(client: Client) {
    this.#clients.add(client);
    // Replay so a browser joining mid-run is not staring at an empty screen.
    if (client.runId) {
      for (const e of this.#recent.get(client.runId) ?? []) {
        client.send(JSON.stringify(e));
      }
    }
    return () => this.#clients.delete(client);
  }

  publish(event: RunEvent) {
    const runId = "runId" in event ? event.runId : event.message.runId;
    const buffer = this.#recent.get(runId) ?? [];
    buffer.push(event);
    if (buffer.length > 500) buffer.shift();
    this.#recent.set(runId, buffer);

    const payload = JSON.stringify(event);
    for (const client of this.#clients) {
      if (client.runId === null || client.runId === runId) {
        try { client.send(payload); } catch { this.#clients.delete(client); }
      }
    }
  }

  get clientCount() { return this.#clients.size; }
}
