import { MUNINN_REST_URL } from "./vault";
import type { ActivationPush } from "./vault";

/**
 * Minimal MuninnDB REST client — SSE subscription only.
 * All other operations go through MCP tools.
 */
export class MuninnClient {
  private baseUrl: string;

  constructor(restUrl: string = MUNINN_REST_URL) {
    this.baseUrl = restUrl.replace(/\/+$/, "");
  }

  /**
   * Subscribe to real-time memory push events via SSE.
   *
   * MuninnDB pushes:
   * - new_write: memory stored matching the subscription threshold
   * - contradiction_detected: new memory conflicts with existing one
   * - threshold_crossed: memory's activation score crosses threshold
   *
   * Auto-reconnects with exponential backoff (5s → 5min).
   */
  async *subscribe(vault: string, signal?: AbortSignal): AsyncGenerator<ActivationPush> {
    let reconnectAttempts = 0;
    const url = new URL(`${this.baseUrl}/api/subscribe`);
    url.searchParams.set("vault", vault);
    url.searchParams.set("push_on_write", "true");
    url.searchParams.set("threshold", "0.7");

    while (!signal?.aborted) {
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "text/event-stream" },
          signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        reconnectAttempts = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                yield JSON.parse(line.slice(6));
              } catch {
                /* skip malformed SSE data */
              }
            }
          }
        }
      } catch {
        if (signal?.aborted) break;
        const retryDelay = Math.min(5000 * Math.pow(2, reconnectAttempts), 300000);
        reconnectAttempts++;
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
}
