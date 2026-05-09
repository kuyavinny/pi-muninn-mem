// Types and utilities for MuninnDB vault management

export const DEFAULT_VAULT = "default";
export const MAX_AUTO_INJECT = 5;
export const MAX_CONTEXT_CHARS = 2000;

// Environment types for dev/prod support
export type Environment = "dev" | "prod";

// Environment-specific configuration
interface EnvironmentConfig {
  name: Environment;
  restUrl: string;
  mcpUrl: string;
  apiKey?: string;
  sseThreshold: number;
  pushOnWrite: boolean;
}

// Environment definitions
export const ENVIRONMENTS: Record<Environment, EnvironmentConfig> = {
  dev: {
    name: "dev",
    restUrl: "http://127.0.0.1:8475",
    mcpUrl: "http://127.0.0.1:8750/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true,
  },
  prod: {
    name: "prod",
    restUrl: "http://127.0.0.1:8575",
    mcpUrl: "http://127.0.0.1:8850/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true,
  },
};

// Default environment (prod)
export const DEFAULT_ENV: Environment = "prod";

// Legacy config for backward compatibility
export interface MuninnConfig extends EnvironmentConfig {
  /** Vault name override (auto-resolved from cwd if empty) */
  vault?: string;
}

export const DEFAULT_CONFIG: MuninnConfig = {
  ...ENVIRONMENTS.prod,
  vault: undefined,
};

/**
 * Resolves the vault name from the current working directory.
 * Uses the basename of cwd, sanitized to lowercase alphanumeric + hyphens.
 * Falls back to "default" if cwd is unavailable or is home directory.
 */
export function resolveVaultName(cwd?: string): string {
  if (!cwd || cwd === process.env.HOME || cwd === "/") {
    return DEFAULT_VAULT;
  }
  const base = cwd.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "") || DEFAULT_VAULT
  );
}

/**
 * Memory types matching MuninnDB's 12 built-in types.
 */
export enum MemoryType {
  Fact = "fact",
  Decision = "decision",
  Observation = "observation",
  Preference = "preference",
  Issue = "issue",
  Task = "task",
  Procedure = "procedure",
  Event = "event",
  Goal = "goal",
  Constraint = "constraint",
  Identity = "identity",
  Reference = "reference",
}

/**
 * Push event received from SSE subscription.
 */
export interface ActivationPush {
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
  why?: string;
}
