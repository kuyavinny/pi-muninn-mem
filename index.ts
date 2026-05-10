import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import { setupMuninnDB, uninstallMuninnDB } from "./src/setup";
import { resolveVaultName, readVaultMapping, writeVaultMapping, isProjectDirectory } from "./src/vault";
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
 *   /muninn-vault    — Show current vault, create/link vault for project directory
 */
export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);

  // Interactive setup: install MuninnDB, configure MCP, AGENTS.md
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

  // Vault management: show status, create/link, unlink
  pi.registerCommand("muninn-vault", {
    description: "Manage MuninnDB vaults (status, create, unlink)",
    handler: async (args, ctx) => {
      const cwd = process.cwd();
      const subcommand = args?.trim().split(/\s+/)[0] || "status";
      const name = args?.trim().split(/\s+/).slice(1).join(" ");

      const mapping = readVaultMapping();
      const currentVault = resolveVaultName(cwd);
      const isProject = isProjectDirectory(cwd);

      switch (subcommand) {
        case "create": {
          const vaultName = name || cwd.split("/").filter(Boolean).pop() || "default";
          const sanitizedName = vaultName
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+|-+$/g, "")
            .substring(0, 64);

          if (!sanitizedName || sanitizedName === "default") {
            ctx.ui.notify('Cannot create a vault named "default". Choose a project-specific name.', "warning");
            return;
          }

          // Add to mapping
          mapping[cwd] = sanitizedName;
          writeVaultMapping(mapping);

          ctx.ui.notify(
            `✓ Linked ${cwd} → vault "${sanitizedName}"\n` +
            `  Memories in this directory will use vault "${sanitizedName}".\n` +
            `  The vault will be created on first write.`,
            "info",
          );
          break;
        }

        case "unlink": {
          if (!mapping[cwd]) {
            ctx.ui.notify("This directory is not explicitly linked to a vault.", "info");
            return;
          }

          const removed = mapping[cwd];
          delete mapping[cwd];
          writeVaultMapping(mapping);

          ctx.ui.notify(
            `✓ Unlinked ${cwd} from vault "${removed}".\n` +
            `  This directory will now use vault "${isProject ? cwd.split("/").pop()?.toLowerCase() : "default"}".`,
            "info",
          );
          break;
        }

        case "status":
        default: {
          const lines = [
            `Directory: ${cwd}`,
            `Vault: ${currentVault}`,
            `Resolution: ${mapping[cwd] ? "explicit (vaults.json)" : isProject ? "auto-detected (project marker)" : "default (non-project dir)"}`,
          ];

          if (isProject) {
            lines.push(`Project markers: ${PROJECT_MARKERS.filter((m) => require("node:fs").existsSync(require("node:path").join(cwd, m))).join(", ") || "none"}`);
          }

          const mappingCount = Object.keys(mapping).length;
          if (mappingCount > 0) {
            lines.push(`\nLinked vaults (${mappingCount}):`);
            for (const [dir, vault] of Object.entries(mapping)) {
              const marker = dir === cwd ? " ← current" : "";
              lines.push(`  ${vault.padEnd(20)} ${dir}${marker}`);
            }
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
      }
    },
  });
}