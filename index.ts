import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerLifecycleHooks from "./src/extension";
import { registerMemoryTools } from "./src/tools";
import { registerVaultInjection } from "./src/mcp-bridge";

export default function (pi: ExtensionAPI) {
  // Register lifecycle hooks for automatic memory management
  registerLifecycleHooks(pi);

  // Register 3 custom Pi tools (remember, recall, decide)
  registerMemoryTools(pi);

  // Inject per-project vault into muninn_* MCP tool calls via tool_call hook
  // (pi-mcp-adapter handles MCP tool discovery and proxying via mcp.json)
  registerVaultInjection(pi);
}