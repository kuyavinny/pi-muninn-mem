// Types and utilities for MuninnDB vault management
//
// The MCP configuration (mcp.json) is the single source of truth for
// which MuninnDB server to connect to. The REST URL is derived from
// the MCP URL using the MuninnDB port convention:
//   REST port = MCP port - 275
//   e.g. http://host:8750/mcp → http://host:8475

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_VAULT = "default";
export const MAX_CONTEXT_CHARS = 2000;

// ─── MCP Configuration ──────────────────────────────────────────────

const MCP_CONFIG_PATH = join(homedir(), ".config/mcp/mcp.json");

export interface McpConfig {
  mcpServers: Record<string, { url?: string; [k: string]: unknown }>;
}

/** Read mcp.json to find MuninnDB server configuration. */
export function readMcpConfig(): McpConfig | null {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Derive the REST API URL from the MCP URL.
 *  MuninnDB convention: REST port = MCP port - 275, strip /mcp path.
 *  e.g. http://127.0.0.1:8750/mcp → http://127.0.0.1:8475
 *  e.g. http://127.0.0.1:8850/mcp → http://127.0.0.1:8575
 */
export function deriveRestUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const restPort = parseInt(url.port) - 275;
  url.port = String(restPort);
  // Strip /mcp path suffix
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "");
  if (url.pathname === "/" || url.pathname === "") {
    // Return without trailing slash
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/+$/, "");
}

/** Get the MuninnDB REST URL by reading mcp.json.
 *  Falls back to the default dev instance if mcp.json is unavailable.
 */
export function getMuninnRestUrl(): string {
  const config = readMcpConfig();
  const mcpUrl = config?.mcpServers?.muninndb?.url;
  if (mcpUrl) return deriveRestUrl(mcpUrl);
  return "http://127.0.0.1:8475";
}

// ─── MuninnDB Client Configuration ─────────────────────────────────

export interface MuninnConfig {
  restUrl: string;
  sseThreshold: number;
  pushOnWrite: boolean;
  apiKey?: string;
}

// ─── Vault Resolution ───────────────────────────────────────────────

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

// ─── Memory Types ────────────────────────────────────────────────────

/**
 * Memory types matching MuninnDB's built-in types.
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

// ─── SSE Push Event ─────────────────────────────────────────────────

/**
 * Push event received from SSE subscription.
 * MuninnDB pushes these events when memories are written or contradictions detected.
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