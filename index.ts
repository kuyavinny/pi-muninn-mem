import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
import { setupMuninnDB, uninstallMuninnDB } from "./src/setup";
import { resolveVaultName, readVaultMapping, writeVaultMapping, isProjectDirectory, PROJECT_MARKERS } from "./src/vault";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * MuninnDB Memory Extension for Pi.
 *
 * Commands:
 *   /muninn-setup    — Install, configure, and verify MuninnDB integration
 *   /muninn-remove   — Remove MuninnDB integration (keeps MuninnDB data)
 *   /muninn-vault    — Manage vaults: status, create, unlink
 *   /muninn-dream    — Run dream protocol: consolidate, evolve, enrich memories
 */
export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);

  pi.registerCommand("muninn-setup", {
    description: "Setup MuninnDB memory integration (install, configure, verify)",
    handler: async (_args, ctx) => {
      await setupMuninnDB(ctx);
    },
  });

  pi.registerCommand("muninn-remove", {
    description: "Remove MuninnDB integration (keeps MuninnDB data)",
    handler: async (_args, ctx) => {
      await uninstallMuninnDB(ctx);
    },
  });

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
          const sanitized = vaultName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").substring(0, 64);

          if (!sanitized || sanitized === "default") {
            ctx.ui.notify('Cannot create a vault named "default". Choose a project-specific name.', "warning");
            return;
          }

          mapping[cwd] = sanitized;
          writeVaultMapping(mapping);

          ctx.ui.notify(
            `✓ Linked ${cwd} → vault "${sanitized}"\n` +
            `  Memories in this directory will use vault "${sanitized}".\n` +
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

          const fallback = isProject ? cwd.split("/").filter(Boolean).pop()?.toLowerCase() : "default";
          ctx.ui.notify(
            `✓ Unlinked ${cwd} from vault "${removed}".\n` +
            `  This directory will now use vault "${fallback}".`,
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
            const markers = PROJECT_MARKERS.filter((m) => existsSync(join(cwd, m)));
            if (markers.length > 0) lines.push(`Project markers: ${markers.join(", ")}`);
          }

          const entries = Object.entries(mapping);
          if (entries.length > 0) {
            lines.push(`\nLinked vaults (${entries.length}):`);
            for (const [dir, vault] of entries) {
              lines.push(`  ${vault.padEnd(20)} ${dir}${dir === cwd ? " ← current" : ""}`);
            }
          }

          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
      }
    },
  });

  pi.registerCommand("muninn-dream", {
    description: "Run dream protocol: consolidate, evolve, and enrich memories",
    handler: async (_args, ctx) => {
      const vault = resolveVaultName(process.cwd());

      ctx.ui.notify(
        `🧠 MuninnDB Dream Protocol (vault: "${vault}")\n\n` +
        `Run these MCP tools in sequence:\n\n` +
        `1. muninndb_muninn_contradictions — Find unresolved contradictions\n` +
        `   → For each contradiction: use muninndb_muninn_evolve to update the older memory, or muninndb_muninn_consolidate to merge them\n\n` +
        `2. muninndb_muninn_recall(mode=recent, limit=20) — Review recent memories\n` +
        `   → Identify overlapping or duplicate memories → muninndb_muninn_consolidate\n` +
        `   → Identify outdated memories → muninndb_muninn_evolve\n\n` +
        `3. muninndb_muninn_get_enrichment_candidates(stages=[summary,entities]) — Find memories missing summaries or entities\n` +
        `   → Use muninndb_muninn_apply_enrichment to add missing summaries and entities\n\n` +
        `4. muninndb_muninn_decide — Record any decisions made during this session\n\n` +
        `5. muninndb_muninn_where_left_off — Save final session state for next time`,
        "info",
      );
    },
  });
}