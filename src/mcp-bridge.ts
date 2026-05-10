import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveVaultName } from "./vault";

// ============================================================
// MCP Bridge — Vault Injection + Batch Nudge for MuninnDB Tools
//
// Pi's native MCP adapter (pi-mcp-adapter) handles tool discovery
// and call proxying for all 39 muninn_* tools. This module:
//
// 1. Injects the per-project vault parameter into muninn_* tool calls
// 2. Counts individual muninn_remember calls per turn and nudges
//    toward muninn_remember_batch when 2+ consecutive calls are made
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

// Track individual muninn_remember calls per turn for batch nudge
let individualRememberCount = 0;

/**
 * Registers tool_call hooks for MuninnDB MCP tools:
 * 1. Vault injection — adds per-project vault to tool calls
 * 2. Batch nudge — reminds the LLM to use remember_batch after 2+
 *    consecutive individual remember calls
 */
export function registerVaultInjection(pi: ExtensionAPI): void {
  // Reset counter at start of each turn
  pi.on("before_agent_start", async () => {
    individualRememberCount = 0;
  });

  pi.on("tool_call", async (event) => {
    // Only intercept known MuninnDB MCP tools (allowlist, not prefix match)
    if (!MUNINN_TOOLS.has(event.toolName)) return;
    if (!event.input) return;

    // Inject vault from cwd if the caller didn't specify one
    const input = event.input as Record<string, unknown>;
    if (!input.vault) {
      event.input = { ...input, vault: resolveVaultName(process.cwd()) };
    }

    // Batch nudge: count individual muninn_remember calls
    if (event.toolName === "muninndb_muninn_remember") {
      individualRememberCount++;
      if (individualRememberCount === 2) {
        // Inject a nudge after the second individual remember call
        return {
          message: {
            customType: "muninn_batch_nudge",
            content:
              "💡 You've made 2 individual muninn_remember calls this turn. " +
              "Use muninndb_muninn_remember_batch for related memories instead of " +
              "multiple individual calls. Assess all memories first, then batch save.",
            display: true,
          },
        };
      }
    }

    // Reset counter on batch call — using batch correctly
    if (event.toolName === "muninndb_muninn_remember_batch") {
      individualRememberCount = 0;
    }
  });
}