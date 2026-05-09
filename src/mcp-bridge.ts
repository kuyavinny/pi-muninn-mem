import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName } from "./vault";

// ============================================================
// MCP Bridge — Vault Injection for MuninnDB MCP Tools
//
// Pi's native MCP adapter (pi-mcp-adapter) handles tool discovery
// and call proxying for all 39 muninn_* tools. This module injects
// the per-project vault parameter into muninn_* tool calls that omit it.
//
// The extension doesn't need to register any custom tools — MCP
// provides muninn_remember, muninn_recall, muninn_decide, muninn_env,
// and 35 more. The LLM is guided by AGENTS.md to use them.
// ============================================================

// Allowlist of known MuninnDB MCP tools (prefixed with muninndb_muninn_ via pi-mcp-adapter)
const MUNINN_TOOLS = new Set([
  "muninndb_muninn_remember",
  "muninndb_muninn_recall",
  "muninndb_muninn_decide",
  "muninndb_muninn_evolve",
  "muninndb_muninn_consolidate",
  "muninndb_muninn_contradictions",
  "muninndb_muninn_where_left_off",
  "muninndb_muninn_guide",
  "muninndb_muninn_remember_batch",
  "muninndb_muninn_status",
  "muninndb_muninn_health",
  "muninndb_muninn_read",
  "muninndb_muninn_link",
  "muninndb_muninn_unlink",
  "muninndb_muninn_search",
  "muninndb_muninn_delete",
  "muninndb_muninn_list",
  "muninndb_muninn_summary",
]);

/**
 * Registers a tool_call hook that injects per-project vault
 * into known MuninnDB MCP tool calls that omit the vault parameter.
 * Uses an allowlist to avoid intercepting unknown tools.
 */
export function registerVaultInjection(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    // Only intercept known MuninnDB MCP tools (allowlist, not prefix match)
    if (!MUNINN_TOOLS.has(event.toolName)) return;
    if (!event.input) return;

    // Inject vault from cwd if the caller didn't specify one
    const input = event.input as Record<string, unknown>;
    if (!input.vault) {
      event.input = { ...input, vault: resolveVaultName(process.cwd()) };
    }
  });
}