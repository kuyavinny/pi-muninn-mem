// Types and utilities for MuninnDB vault management
//
// Vault resolution uses a hybrid strategy:
// 1. Explicit mapping in ~/.muninn/vaults.json (highest priority)
// 2. Project marker detection (.git, package.json, etc.)
// 3. Fallback to "default" for non-project directories
//
// The SSE client connects directly to the MuninnDB REST API on port 8475.
// No port calculation needed — these are fixed by MuninnDB.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Constants ───────────────────────────────────────────────────────

export const DEFAULT_VAULT = "default";
export const MUNINN_REST_URL = "http://127.0.0.1:8475";
export const PROJECT_MARKERS = [
  ".git", "package.json", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "pyproject.toml", "requirements.txt",
  "Makefile", "docker-compose.yml", "docker-compose.yaml",
];

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
    return JSON.parse(readFileSync(VAULTS_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the vault mapping file atomically. Creates ~/.muninn/ if needed. */
export function writeVaultMapping(mapping: VaultMapping): void {
  mkdirSync(join(HOME, ".muninn"), { recursive: true });
  const tmpFile = join(HOME, ".muninn", `.vaults-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, JSON.stringify(mapping, null, 2) + "\n");
  renameSync(tmpFile, VAULTS_CONFIG_PATH);
}

/** Check if a directory contains project markers. */
export function isProjectDirectory(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

// ─── Vault Resolution ───────────────────────────────────────────────

/**
 * Resolves the vault name using a hybrid strategy:
 *
 * 1. Explicit mapping in ~/.muninn/vaults.json (highest priority)
 * 2. Project marker detection (.git, package.json, etc.)
 * 3. Fallback to "default" for non-project directories
 */
export function resolveVaultName(cwd?: string): string {
  const dir = cwd || process.cwd() || "/";

  if (dir === HOME || dir === "/") return DEFAULT_VAULT;

  const mapping = readVaultMapping();
  if (mapping[dir]) return mapping[dir];

  if (isProjectDirectory(dir)) {
    const base = dir.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
    return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").substring(0, 64) || DEFAULT_VAULT;
  }

  return DEFAULT_VAULT;
}

// ─── SSE Push Event ─────────────────────────────────────────────────

export interface ActivationPush {
  trigger: "new_write" | "threshold_crossed" | "contradiction_detected";
  engram_id?: string;
  score?: number;
  engram?: { id: string; concept: string; content: string; type: string; score: number };
  why?: string;
}