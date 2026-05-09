/**
 * Interactive setup for MuninnDB + Pi extension.
 *
 * Handles: MuninnDB installation (binary/Docker/Podman), Ollama detection,
 * MCP configuration, AGENTS.md setup, vault creation, health verification.
 *
 * Design principles:
 * - No auto-pulling of Ollama models (too expensive)
 * - Bundled ONNX embedder works without Ollama (default)
 * - AGENTS.md is non-destructive (additive only)
 * - MCP config merges into existing mcp.json (preserves other servers)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ─── Paths ────────────────────────────────────────────────────────
const HOME = homedir();
const MCP_CONFIG_PATH = join(HOME, ".config/mcp/mcp.json");
const AGENTS_MD_PATH = join(HOME, ".pi/agent/AGENTS.md");
const MUNINN_ENV_PATH = join(HOME, ".muninn/muninn.env");
const MUNINN_DATA_DIR = join(HOME, ".muninn/data");
const SETTINGS_PATH = join(HOME, ".pi/agent/settings.json");

// ─── AGENTS.md Content (additive section) ────────────────────────
const AGENTS_MD_SECTION = `# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Always

Before beginning any work, call \`muninndb_muninn_where_left_off\` (via mcp) to load context from the previous session.
This is unconditional — not "if relevant" but "always, before beginning any work."

## During Every Session

- **Save continuously** — this is a mindset, not a checklist.
- Anything the user shares or that emerges from the work should be saved immediately.
- Do not evaluate whether it is "important enough" — when in doubt, save it.
- Do not wait to be asked. If you discover something useful, write it to memory.

### What to Save

- **Decisions**: "We chose X because Y" → \`muninndb_muninn_decide\`
- **Preferences**: "I prefer tabs over spaces" → \`muninndb_muninn_remember\` type=preference
- **Issues**: "Service X fails on port 8080" → \`muninndb_muninn_remember\` type=issue
- **Procedures**: "To deploy, run these steps..." → \`muninndb_muninn_remember\` type=procedure
- **Facts**: "The API returns 429 on rate limits" → \`muninndb_muninn_remember\` type=fact
- **Batch saves**: Use \`muninndb_muninn_remember_batch\` when storing multiple memories at once

### What NOT to Save

- Greetings, acknowledgments, "let me check", "I'll do that"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you're not confident about

## Tools Available

All 39 MuninnDB tools are available via the \`mcp\` gateway with prefix \`muninndb_muninn_*\`.
Call them using the \`mcp\` function, e.g.: \`mcp({ tool: "muninndb_muninn_where_left_off", args: "{\\"vault\\": \\"muninndb\\"}" })\`

| Tool | Purpose |
|------|---------|
| \`muninndb_muninn_where_left_off\` | Restore context from last session — **call this first** |
| \`muninndb_muninn_recall\` | Semantic search for relevant memories |
| \`muninndb_muninn_remember\` | Store a fact, decision, preference, or observation |
| \`muninndb_muninn_decide\` | Record a decision with rationale and evidence |
| \`muninndb_muninn_remember_batch\` | Store multiple memories at once (max 50) |
| \`muninndb_muninn_evolve\` | Update a memory with new information |
| \`muninndb_muninn_consolidate\` | Merge related memories |
| \`muninndb_muninn_contradictions\` | Check for known contradictions |
| \`muninndb_muninn_guide\` | Get vault-specific usage instructions |

## Vault Strategy

Each project gets its own vault (derived from the directory basename). The vault is injected automatically — you don't need to specify it.

## Contradiction Detection

When you see a \`[⚠️ Contradiction detected]\` message, use \`muninndb_muninn_evolve\` to update the older memory or \`muninndb_muninn_consolidate\` to merge them.`;

// ─── Setup Function ────────────────────────────────────────────────
export async function setupMuninnDB(ctx: any): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");
  const warn = (msg: string) => ctx.ui.notify(msg, "warning");
  const error = (msg: string) => ctx.ui.notify(msg, "error");

  log("╔═══ MuninnDB Setup ═══╗");

  // ─── Step 1: Check MuninnDB ────────────────────────────────────────
  log("Step 1: Checking MuninnDB...");

  let restPort = 8475;
  let mcpPort = 8750;
  let muninnRunning = false;

  // Check CLI instance (default ports)
  if (await checkHealth(8475)) {
    muninnRunning = true;
    log("  ✓ MuninnDB running (CLI, ports 8475/8750)");
  }
  // Check Docker/Podman instance (offset ports)
  else if (await checkHealth(8575)) {
    muninnRunning = true;
    restPort = 8575;
    mcpPort = 8850;
    log("  ✓ MuninnDB running (container, ports 8575/8850)");
  }

  if (!muninnRunning) {
    // Try to start via CLI
    const muninnBin = findMuninnBinary();
    if (muninnBin) {
      log("  MuninnDB found but not running. Starting...");
      try {
        execFileSync(muninnBin, ["start"], { timeout: 10000 });
        // Wait for it to come up
        for (let i = 0; i < 10; i++) {
          if (await checkHealth(8475)) {
            muninnRunning = true;
            log("  ✓ MuninnDB started (CLI, ports 8475/8750)");
            break;
          }
          await sleep(1000);
        }
      } catch {
        // Start failed, show instructions
      }
    }

    if (!muninnRunning) {
      error("MuninnDB is not running. Install and start it:");
      log("");
      log("  Binary install:");
      log("    curl -sSL https://github.com/scrypster/muninndb/releases/latest/download/muninn-linux-amd64 -o ~/bin/muninn");
      log("    chmod +x ~/bin/muninn");
      log("    muninn init --tool manual --no-token --yes --yes");
      log("    muninn start");
      log("");
      log("  Docker:");
      log("    docker run -d --name muninndb \\");
      log("      -p 8474:8474 -p 8475:8475 -p 8476:8476 -p 8477:8477 -p 8750:8750 \\");
      log("      -v muninndb-data:/data ghcr.io/scrypster/muninndb:latest");
      log("");
      log("  Then re-run: /muninn-setup");
      return;
    }
  }

  // ─── Step 2: Embedding info ────────────────────────────────────────
  log("Step 2: Embedding configuration...");
  log("  Default: Bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)");
  log("           Works without any external service. No API key needed.");

  const ollamaRunning = await checkOllama();
  if (ollamaRunning) {
    log("  ✓ Ollama detected — optional upgrades available:");
    log("    Embedding:  ollama pull nomic-embed-text    (768-dim, better quality)");
    log("    Embedding:  ollama pull qwen3-embedding:0.6b (fast, good quality)");
    log("    Enrichment: ollama pull llama3.2:1b          (summaries, entities, contradictions)");
    log("");
    log("  To enable, edit ~/.muninn/muninn.env and restart MuninnDB:");
    log("    MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text");
    log("    MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b");
  } else {
    log("  ℹ Ollama not found. Bundled embedder will be used (works offline).");
    log("  To upgrade embedding quality, install Ollama: https://ollama.com");
  }

  // ─── Step 3: Create vault ──────────────────────────────────────────
  log("Step 3: Creating vault...");
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["vault", "create", "muninndb", "--public", "-u", "root", "-p"], { timeout: 5000 });
      log("  ✓ Vault 'muninndb' created (public)");
    } catch (e: any) {
      if (e?.message?.includes("already exists")) {
        log("  ✓ Vault 'muninndb' already exists");
      } else {
        warn("  Could not create vault — it will be created on first write");
      }
    }
  } else {
    log("  ℹ Vault will be created on first write (muninn binary not found)");
  }

  // ─── Step 4: Configure MCP ──────────────────────────────────────────
  log("Step 4: Configuring MCP...");
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await writeMcpConfig(mcpUrl);
  log(`  ✓ MCP configured: ${mcpUrl}`);

  // ─── Step 5: Configure AGENTS.md (non-destructive) ────────────────
  log("Step 5: Configuring AGENTS.md...");
  await writeAgentsMd();
  log("  ✓ AGENTS.md configured");

  // ─── Step 6: Verify ────────────────────────────────────────────────
  log("");
  log("╔═══ Setup Summary ═══╗");

  if (await checkHealth(restPort)) {
    log(`  ✓ MuninnDB: REST :${restPort}, MCP :${mcpPort}`);
  } else {
    error(`  ✗ MuninnDB: not responding on :${restPort}`);
  }

  log(`  ✓ MCP config: ${MCP_CONFIG_PATH}`);
  log(`  ✓ AGENTS.md: ${AGENTS_MD_PATH}`);
  log(`  ✓ Embedding: ${ollamaRunning ? "Ollama available (optional)" : "Bundled ONNX (default)"}`);

  log("");
  log("Next steps:");
  log("  1. Restart Pi to load the extension");
  log("  2. First turn: call muninndb_muninn_where_left_off (via mcp)");
  log("");
}

// ─── Uninstall ────────────────────────────────────────────────────
export async function uninstallMuninnDB(ctx: any): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");

  log("╔═══ MuninnDB Uninstall ═══╗");

  // Remove extension from settings.json
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p: string) => !p.includes("muninn-memory"));
      if (data.packages.length < original) {
        writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  ✓ Removed from Pi settings");
      }
    }
  } catch { /* ignore */ }

  // Remove muninndb from MCP config
  try {
    if (existsSync(MCP_CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
      if (data.mcpServers?.muninndb) {
        delete data.mcpServers.muninndb;
        writeFileSync(MCP_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  ✓ Removed muninndb from MCP config");
      }
    }
  } catch { /* ignore */ }

  // Remove MuninnDB section from AGENTS.md
  try {
    if (existsSync(AGENTS_MD_PATH)) {
      const content = readFileSync(AGENTS_MD_PATH, "utf-8");
      const result = removeMuninnSection(content);
      if (result.trim() !== content.trim()) {
        writeFileSync(AGENTS_MD_PATH, result.trim() + "\n");
        log("  ✓ Removed MuninnDB section from AGENTS.md");
      }
      // Remove empty file
      if (result.trim().length < 5) {
        // Would need user confirmation — just notify
        log("  ℹ AGENTS.md may be empty — remove manually if desired");
      }
    }
  } catch { /* ignore */ }

  log("");
  log("Restart Pi to apply changes.");
  log("To remove MuninnDB data: rm -rf ~/.muninn");
  log("To stop MuninnDB: muninn stop");
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    return res.ok;
  } catch {
    return false;
  }
}

function findMuninnBinary(): string | null {
  const { PATH = "" } = process.env;
  const candidates = [
    ...PATH.split(":").map((d) => join(d, "muninn")),
    join(homedir(), "bin/muninn"),
    "/usr/local/bin/muninn",
  ];
  for (const candidate of candidates) {
    try {
      require("node:fs").accessSync(candidate, require("node:fs").constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeMcpConfig(mcpUrl: string): Promise<void> {
  mkdirSync(join(MCP_CONFIG_PATH, ".."), { recursive: true });

  let config: any = { mcpServers: {} };
  if (existsSync(MCP_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
    } catch { /* use empty config */ }
  }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.muninndb = {
    url: mcpUrl,
    lifecycle: "keep-alive",
    directTools: true,
  };

  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function writeAgentsMd(): Promise<void> {
  if (!existsSync(AGENTS_MD_PATH)) {
    // Create new file
    writeFileSync(AGENTS_MD_PATH, AGENTS_MD_SECTION + "\n");
    return;
  }

  const content = readFileSync(AGENTS_MD_PATH, "utf-8");
  if (content.includes("# Memory: MuninnDB")) {
    // Update existing section (replace only the MuninnDB section)
    const updated = removeMuninnSection(content);
    writeFileSync(AGENTS_MD_PATH, updated.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  } else {
    // Append (non-destructive)
    writeFileSync(AGENTS_MD_PATH, content.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  }
}

function removeMuninnSection(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (line.startsWith("# Memory: MuninnDB")) {
      skip = true;
      continue;
    }
    if (skip && (line.startsWith("# ") || line.startsWith("## "))) {
      skip = false;
      output.push(line);
      continue;
    }
    if (!skip) {
      output.push(line);
    }
  }
  return output.join("\n");
}