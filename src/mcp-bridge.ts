import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { client } from "./shared-client";
import { resolveVaultName } from "./vault";

// ============================================================
// MCP Bridge — Vault Injection for MuninnDB MCP Tools
//
// Pi's native MCP adapter (pi-mcp-adapter) handles tool discovery
// and call proxying. This module injects the per-project vault
// parameter into muninn_* tool calls that omit it.
//
// How it works:
// 1. Listens to Pi's tool_call event (fires before execution)
// 2. Detects muninn_* tool names
// 3. Mutates event.input to add vault when missing
//
// This replaces the previous bridge which manually discovered
// and registered 39 MCP tools via pi.registerTool(). Now that
// pi-mcp-adapter handles MCP natively via mcp.json, we only
// need this thin vault-injection layer.
// ============================================================

/**
 * Registers a tool_call hook that injects per-project vault
 * into any muninn_* MCP tool call that omits the vault parameter.
 *
 * Must be called once during extension initialization.
 */
export function registerVaultInjection(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    // Only intercept MuninnDB MCP tools (prefixed with muninn_)
    if (!event.toolName.startsWith("muninn_")) return;
    if (!event.input) return;

    // Inject vault from cwd if the caller didn't specify one
    // MCP tool inputs are arbitrarily-shaped; cast to mutate freely
    const input = event.input as Record<string, unknown>;
    if (!input.vault) {
      input.vault = resolveVaultName(process.cwd());
    }
  });
}