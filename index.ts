import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * MuninnDB Memory Extension for Pi.
 *
 * MCP-first architecture:
 * - SSE subscription for real-time push (contradictions + relevant memories)
 * - First-turn context injection telling LLM to call muninn_where_left_off
 * - All other operations via MCP tools (muninn_remember, muninn_recall, etc.)
 * - Per-project vault auto-injection via MCP bridge
 *
 * The LLM is guided by ~/.pi/agent/AGENTS.md to save continuously
 * and recall at session start.
 */
export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);
}