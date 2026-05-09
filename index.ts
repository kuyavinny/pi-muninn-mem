import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { join } from "node:path";

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

  // Register /muninn-setup command for interactive setup
  pi.registerCommand("muninn-setup", {
    description: "Interactive setup for MuninnDB memory integration",
    handler: async (_args, ctx) => {
      const scriptPath = join(__dirname, "muninn-setup.sh");

      try {
        ctx.ui.notify("Running MuninnDB setup...", "info");

        await new Promise<void>((resolve, reject) => {
          execFile(
            "bash",
            [scriptPath],
            { timeout: 120_000 },
            (err, stdout, stderr) => {
              if (stdout) ctx.ui.notify(stdout, "info");
              if (stderr) ctx.ui.notify(stderr, "warning");
              if (err) reject(err);
              else resolve();
            },
          );
        });

        ctx.ui.notify("MuninnDB setup complete. Restart Pi to apply changes.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Setup failed: ${msg}`, "error");
      }
    },
  });
}