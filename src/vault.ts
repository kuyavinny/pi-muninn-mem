// Types and utilities for MuninnDB vault management
//
// Vault resolution uses a hybrid strategy:
// 1. Explicit mapping in ~/.muninn/vaults.json (highest priority)
// 2. Project marker detection (.git, package.json, etc.)
// 3. Fallback to "default" for non-project directories
//
// The MCP configuration (mcp.json) is the single source of truth for
// which MuninnDB server to connect to. The REST URL is derived from
// the MCP URL using the MuninnDB port convention:
//   REST port = MCP port - 275
//   e.g. http://host:8750/mcp → http://host:8475

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── URL validation ─────────────────────────────────────────────────

const LOCALHOST_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
const ALLOWED_PORTS = new Set([8474, 8475, 8476, 8477, 8574, 8575, 8576, 8577, 8750, 8850]);

export const DEFAULT_VAULT = "default";
export const MAX_CONTEXT_CHARS = 2000;

// ─── Vault mapping ───────────────────────────────────────────────────

const HOME = homedir();
const VAULTS_CONFIG_PATH = join(HOME, ".muninn", "vaults.json");

export interface VaultMapping {
  [directoryPath: string]: string;
}

/** Read the vault mapping file. Returns empty object if not found. */
export function readVaultMapping(): VaultMapping {
  try {
    if (!existsSync(VAULTS_CONFIG_PATH)) return {};
    const raw = readFileSync(VAULTS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Write the vault mapping file. Creates ~/.muninn/ if needed. */
export function writeVaultMapping(mapping: VaultMapping): void {
  mkdirSync(join(HOME, ".muninn"), { recursive: true });
  const tmpFile = join(HOME, ".muninn", `.vaults-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, JSON.stringify(mapping, null, 2) + "\n");
  // Atomic rename
  const { renameSync } = require("node:fs");
  renameSync(tmpFile, VAULTS_CONFIG_PATH);
}

// ─── Project marker detection ──────────────────────────────────────

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/** Check if a directory contains project markers. */
export function isProjectDirectory(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

// ─── MCP Configuration ──────────────────────────────────────────────

const MCP_CONFIG_PATH = join(HOME, ".config/mcp/mcp.json");

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

  // Validate: must be localhost-only
  if (!LOCALHOST_HOSTS.includes(url.hostname)) {
    throw new Error(`MuninnDB URL must point to localhost, got: ${url.hostname}`);
  }

  const restPort = parseInt(url.port) - 275;

  // Validate: derived port must be in allowed set
  if (!ALLOWED_PORTS.has(restPort)) {
    throw new Error(`Invalid derived REST port: ${restPort} (from MCP port ${url.port})`);
  }

  url.port = String(restPort);
  // Strip /mcp path suffix
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "");
  if (url.pathname === "/" || url.pathname === "") {
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
  if (mcpUrl) {
    try {
      return deriveRestUrl(mcpUrl);
    } catch {
      // Invalid URL — fall back to default
    }
  }
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
 * Resolves the vault name using a hybrid strategy:
 *
 * 1. Explicit mapping in ~/.muninn/vaults.json (highest priority)
 * 2. Project marker detection (.git, package.json, etc.)
 * 3. Fallback to "default" for non-project directories
 *
 * Examples:
 *   ~/.muninn/vaults.json maps "/home/user/work/api" → "api-server"
 *   /home/user/projects/my-app (has .git) → "my-app"
 *   /home/user/Downloads → "default"
 *   /home/user → "default"
 */
export function resolveVaultName(cwd?: string): string {
  const dir = cwd || process.cwd() || "/";

  // 1. Home dir or root → default
  if (dir === HOME || dir === "/") {
    return DEFAULT_VAULT;
  }

  // 2. Check explicit mapping in vaults.json
  const mapping = readVaultMapping();
  if (mapping[dir]) {
    return mapping[dir];
  }

  // 3. Check project markers (.git, package.json, etc.)
  if (isProjectDirectory(dir)) {
    const base = dir.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
    return (
      base
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 64) || DEFAULT_VAULT
    );
  }

  // 4. Non-project directory → default
  return DEFAULT_VAULT;
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