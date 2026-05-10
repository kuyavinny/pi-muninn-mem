import { MuninnConfig, ActivationPush, MUNINN_REST_URL } from "./vault";

/**
 * Minimal MuninnDB REST client.
 *
 * Only provides SSE subscription — the one operation that MCP cannot do.
 * All other operations (remember, recall, decide, read, link, etc.)
 * are handled by the LLM through MCP tools.
 */
export class MuninnClient {
  private config: MuninnConfig;

  constructor(config: Partial<MuninnConfig> = {}) {
    this.config = {
      restUrl: MUNINN_REST_URL,
      sseThreshold: 0.7,
      pushOnWrite: true,
      ...config,
    };
  }

  private get baseUrl(): string {
    return this.config.restUrl;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      h["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }

  /** Update the REST API URL at runtime (e.g., if mcp.json changes). */
  setBaseUrl(url: string): void {
    this.config.restUrl = url.replace(/\/+$/, "");
  }

  /**
   * Subscribe to real-time memory push events via SSE.
   *
   * This is the ONLY REST operation we need. MCP has no equivalent
   * for server-push notifications. MuninnDB pushes:
   * - new_write: when a memory is stored that matches the subscription threshold
   * - contradiction_detected: when a new memory conflicts with an existing one
   * - threshold_crossed: when a memory's activation score crosses the threshold
   *
   * Auto-reconnects on connection loss with a 5-second delay.
   */
  async *subscribe(
    vault: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ActivationPush> {
    let reconnectAttempts = 0;
    const url = new URL(`${this.baseUrl}/api/subscribe`);
    url.searchParams.set("vault", vault);
    url.searchParams.set("push_on_write", String(this.config.pushOnWrite));
    url.searchParams.set("threshold", String(this.config.sseThreshold));

    while (!signal?.aborted) {
      try {
        const response = await fetch(url.toString(), {
          headers: { ...this.headers, Accept: "text/event-stream" },
          signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        reconnectAttempts = 0; // Reset on successful connection

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
                const push: ActivationPush = JSON.parse(line.slice(6));
                yield push;
              } catch {
                // Skip malformed SSE data
              }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) break;
        // Exponential backoff: 5s, 10s, 20s, 40s, up to 5min max
        const retryDelay = Math.min(5000 * Math.pow(2, reconnectAttempts), 300000);
        reconnectAttempts++;
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
}