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

/**
 * Registers a tool_call hook that injects per-project vault
 * into any muninn_* MCP tool call that omits the vault parameter.
 */
export function registerVaultInjection(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    // Only intercept MuninnDB MCP tools
    if (!event.toolName.startsWith("muninn_")) return;
    if (!event.input) return;

    // Inject vault from cwd if the caller didn't specify one
    const input = event.input as Record<string, unknown>;
    if (!input.vault) {
      input.vault = resolveVaultName(process.cwd());
    }
  });
}