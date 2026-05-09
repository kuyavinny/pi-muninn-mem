// Dual-client for MuninnDB dev/prod environments
import { MuninnClient } from "./client";
import { Environment, ENVIRONMENTS, DEFAULT_ENV, resolveVaultName } from "./vault";

interface RememberParams {
  vault: string;
  concept: string;
  content: string;
  type?: string;
  tags?: string[];
  idempotentId?: string;
  entities?: Array<{ name: string; type: string }>;
  relationships?: Array<{ from_entity: string; to_entity: string; rel_type: string; weight?: number }>;
}

interface RecallParams {
  vault: string;
  query: string;
  maxResults?: number;
  mode?: "semantic" | "recent" | "balanced" | "deep";
  profile?: string;
}

interface Engram {
  id: string;
  concept: string;
  content: string;
  score: number;
  type: string;
  tags: string[];
}

interface ActivationPush {
  trigger: "new_write" | "threshold_crossed" | "contradiction_detected";
  engram_id?: string;
  score?: number;
  engram?: {
    id: string;
    concept: string;
    content: string;
    type: string;
    score: number;
  };
}

/**
 * Dual MuninnDB client that writes to both environments but reads from current.
 * Supports seamless switching between dev and prod environments.
 */
export class DualMuninnClient {
  private devClient: MuninnClient;
  private prodClient: MuninnClient;
  private currentEnv: Environment;

  constructor(initialEnv: Environment = DEFAULT_ENV) {
    this.devClient = new MuninnClient(ENVIRONMENTS.dev);
    this.prodClient = new MuninnClient(ENVIRONMENTS.prod);
    this.currentEnv = initialEnv;
  }

  /**
   * Get the client for the current environment.
   */
  private getCurrentClient(): MuninnClient {
    return this.currentEnv === "dev" ? this.devClient : this.prodClient;
  }

  /**
   * Set the current environment (dev or prod).
   */
  setEnvironment(env: Environment): void {
    this.currentEnv = env;
  }

  /**
   * Get the current environment.
   */
  getEnvironment(): Environment {
    return this.currentEnv;
  }

  /**
   * Store a memory in both environments (dual-write).
   * Returns the result from the current environment.
   * If one environment fails, the other still succeeds.
   */
  async remember(params: RememberParams): Promise<{ id: string }> {
    // Write to both environments in parallel
    // Use the current environment's result as the authoritative response
    const [currentResult, _otherResult] = await Promise.allSettled([
      this.getCurrentClient().remember(params),
      (this.currentEnv === "dev" ? this.prodClient : this.devClient).remember(params),
    ]);

    if (currentResult.status === "fulfilled") {
      return currentResult.value;
    }

    // Current env failed — fall back to the other env's result
    if (_otherResult.status === "fulfilled") {
      return _otherResult.value;
    }

    // Both failed
    throw new Error(
      `Failed to store memory in both environments: ${currentResult.reason?.message}, ${_otherResult.reason?.message}`
    );
  }

  /**
   * Recall memories from the current environment only.
   */
  async recall(params: RecallParams): Promise<Engram[]> {
    return this.getCurrentClient().recall(params);
  }

  /**
   * Link two memories in both environments (dual-write).
   */
  async link(params: {
    vault: string;
    sourceId: string;
    targetId: string;
    relation: string;
    weight?: number;
  }): Promise<void> {
    // Best-effort dual-write — don't fail if one env is down
    const results = await Promise.allSettled([
      this.devClient.link(params),
      this.prodClient.link(params),
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === results.length) {
      throw new Error(`Failed to link memories in both environments`);
    }
  }

  /**
   * Get a memory by ID from current environment.
   */
  async read(vault: string, engramId: string): Promise<Engram | null> {
    return this.getCurrentClient().read(vault, engramId);
  }

  /**
   * Get recent activity from current environment.
   */
  async getRecentActivity(vault: string): Promise<Engram[]> {
    return this.getCurrentClient().getRecentActivity(vault);
  }

  /**
   * Subscribe to real-time memory push events from current environment.
   */
  async *subscribe(
    vault: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ActivationPush> {
    yield* this.getCurrentClient().subscribe(vault, signal);
  }

  /**
   * Sync memories from one environment to another.
   * Useful for initial setup or recovering from outages.
   */
  async sync(fromEnv: Environment, toEnv: Environment, vault: string): Promise<void> {
    const fromClient = fromEnv === "dev" ? this.devClient : this.prodClient;
    const toClient = toEnv === "dev" ? this.devClient : this.prodClient;
    
    // Get all engrams from source
    const engrams = await fromClient.getRecentActivity(vault);
    
    // Write to target
    for (const engram of engrams) {
      try {
        await toClient.remember({
          vault,
          concept: engram.concept,
          content: engram.content,
          type: engram.type,
          tags: engram.tags,
        });
      } catch (err) {
        console.warn(`Failed to sync engram ${engram.id}:`, err);
      }
    }
  }
}