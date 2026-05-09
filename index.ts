import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import { setupMuninnDB, uninstallMuninnDB } from "./src/setup";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * MuninnDB Memory Extension for Pi.
 *
 * MCP-first architecture:
 * - SSE subscription for real-time push (contradictions + relevant memories)
 * - First-turn context injection telling LLM to call muninndb_muninn_where_left_off
 * - All other operations via MCP tools (muninn_remember, muninn_recall, etc.)
 * - Per-project vault auto-injection via MCP bridge
 *
 * Commands:
 *   /muninn-setup    — Install, configure, and verify MuninnDB integration
 *   /muninn-remove   — Remove MuninnDB integration (keeps MuninnDB data)
 */
export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);

  // Interactive setup: install MuninnDB, configure MCP, AGENTS.md, vault
  pi.registerCommand("muninn-setup", {
    description: "Setup MuninnDB memory integration (install, configure, verify)",
    handler: async (_args, ctx) => {
      await setupMuninnDB(ctx);
    },
  });

  // Uninstall: remove extension, MCP config, AGENTS.md section
  pi.registerCommand("muninn-remove", {
    description: "Remove MuninnDB integration (keeps MuninnDB data)",
    handler: async (_args, ctx) => {
      await uninstallMuninnDB(ctx);
    },
  });
}