import { MuninnConfig, ActivationPush, DEFAULT_CONFIG } from "./vault";

interface RememberParams {
  vault: string;
  concept: string;
  content: string;
  type?: string;
  tags?: string[];
  idempotentId?: string;
  entities?: Array<{ name: string; type: string }>;  // Add entities
  relationships?: Array<{ from_entity: string; to_entity: string; rel_type: string; weight?: number }>;  // Add relationships
}

interface RecallParams {
  vault: string;
  query: string;
  maxResults?: number;
  mode?: "semantic" | "recent" | "balanced" | "deep";
  profile?: string;  // Add profile parameter
}

interface Engram {
  id: string;
  concept: string;
  content: string;
  score: number;
  type: string;
  tags: string[];
}

interface ActivateResponse {
  query_id: string;
  total_found: number;
  activations: Engram[];
}

interface LinkParams {
  vault: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight?: number;
}

/**
 * REST API client for MuninnDB.
 * All methods are async and use fetch() (Node 18+ built-in).
 */
export class MuninnClient {
  private config: MuninnConfig;
  private abortController: AbortController | null = null;

  constructor(config: Partial<MuninnConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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

  /**
   * Store a single memory (engram).
   */
  async remember(params: RememberParams): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      concept: params.concept,
      content: params.content,
    };
    if (params.type) body.type = params.type;
    if (params.tags) body.tags = params.tags;
    if (params.idempotentId) body.idempotent_id = params.idempotentId;

    const res = await fetch(
      `${this.baseUrl}/api/engrams?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB remember failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * Recall memories via the 6-phase ACTIVATE pipeline.
   */
  async recall(params: RecallParams): Promise<Engram[]> {
    const body: Record<string, unknown> = {
      context: [params.query],
      max_results: params.maxResults ?? 5,
      mode: params.mode ?? "balanced",
    };

    const res = await fetch(
      `${this.baseUrl}/api/activate?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB recall failed (${res.status}): ${text}`);
    }
    const data: ActivateResponse = await res.json();
    return data.activations ?? [];
  }

  /**
   * Link two memories with a typed relationship.
   */
  async link(params: LinkParams): Promise<void> {
    const body: Record<string, unknown> = {
      source_id: params.sourceId,
      target_id: params.targetId,
      relation: params.relation,
    };
    if (params.weight !== undefined) body.weight = params.weight;

    const res = await fetch(
      `${this.baseUrl}/api/link?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB link failed (${res.status}): ${text}`);
    }
  }

  /**
   * Get a memory by ID.
   */
  async read(vault: string, engramId: string): Promise<Engram | null> {
    const res = await fetch(
      `${this.baseUrl}/api/engrams/${encodeURIComponent(engramId)}?vault=${encodeURIComponent(vault)}`,
      { headers: this.headers },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB read failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * Get the most recently accessed memories (where_left_off equivalent via REST).
   * Response shape: { entries: Engram[], total, offset, limit }
   */
  async getRecentActivity(vault: string): Promise<Engram[]> {
    const res = await fetch(
      `${this.baseUrl}/api/session?vault=${encodeURIComponent(vault)}`,
      { headers: this.headers },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB session failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.entries ?? data ?? [];
  }

  /**
   * Subscribe to real-time memory push events via SSE.
   * Returns an async generator that yields ActivationPush events.
   * Handles reconnection on connection loss.
   */
  async *subscribe(
    vault: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ActivationPush> {
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
        // Reconnect after 5 seconds on connection loss
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Disconnect any active subscriptions.
   */
  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
  }
}
