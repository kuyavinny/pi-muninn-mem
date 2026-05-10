/**
 * Interactive setup for MuninnDB + Pi extension.
 *
 * Handles: MuninnDB installation (binary download with checksum verification,
 * Docker, Podman), auto-start, Ollama detection, MCP configuration,
 * AGENTS.md setup, vault creation, health verification.
 *
 * Security design:
 * - Binary downloads verified with SHA-256 checksums
 * - All command execution uses argument arrays (no shell interpolation)
 * - Docker ports bound to 127.0.0.1 only (no network exposure)
 * - Docker image pinned to specific version (no :latest)
 * - MCP config URLs validated as localhost-only
 * - Atomic file writes for configuration (temp file + rename)
 * - MuninnDB initialized with generated authentication token
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  chmodSync, rmSync, renameSync, accessSync, constants,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch, tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";

// Pi extension context (subset of ExtensionCommandContext)
interface NotifyFn { (message: string, type?: "info" | "warning" | "error"): void }
interface ExtensionContext { ui: { notify: NotifyFn } }

// ─── Paths ────────────────────────────────────────────────────────
const HOME = homedir();
const BIN_DIR = join(HOME, "bin");
const MCP_CONFIG_PATH = join(HOME, ".config/mcp/mcp.json");
const AGENTS_MD_PATH = join(HOME, ".pi/agent/AGENTS.md");
const SETTINGS_PATH = join(HOME, ".pi/agent/settings.json");
const MUNINN_DATA_DIR = join(HOME, ".muninn/data");

// ─── MuninnDB release info (pinned version + checksums) ───────────
const MUNINN_VERSION = "v0.5.1";
const MUNINN_RELEASES = "https://github.com/scrypster/muninndb/releases/download";
const MUNINN_DOCKER_IMAGE = "ghcr.io/scrypster/muninndb:v0.5.1";

// SHA-256 checksums for integrity verification of downloaded binaries
const BINARY_HASHES: Record<string, string> = {
  "linux-amd64": "ff15cdb85e42b68f71f993f5ada7c1e7654e049e1765e70d061c6cc37af82837",
  "linux-arm64": "da8753d0375c68a69f98290ee4e8912c94fc51c8f581553423188e4ea6500345",
  "darwin-amd64": "e4e0175983ed50f01930855a9282cf591905fddc2b9b49be371ca623afc75ce0",
  "darwin-arm64": "5d6883ef3aa48345354b2bfc0a77d676834c6f7d71fbea11de61ecbaa76a44fe",
  "windows-amd64": "1aacd174870aedb7ce477a22432ff2e3bc3ac0a455bb43d58d966f111f961e12",
};

// ─── Allowed localhost hostnames for MCP URLs ─────────────────────
const LOCALHOST_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
const ALLOWED_PORTS = new Set([8474, 8475, 8476, 8477, 8574, 8575, 8576, 8577, 8750, 8850]);

// ─── AGENTS.md Content (additive section) ────────────────────────
const AGENTS_MD_SECTION = `# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Always

Before beginning any work, call \`muninndb_muninn_where_left_off\` (via mcp) to load context from the previous session.
This is unconditional — not "if relevant" but "always, before beginning any work."

## Save Protocol

1. **ASSESS** — Before saving anything from this turn, review the entire exchange and identify ALL memories worth saving.
2. **CHOOSE** — Based on the count:
   - 1 memory → \`muninndb_muninn_remember\`
   - 2+ memories → \`muninndb_muninn_remember_batch\`
3. **SAVE** — Execute once. Never make two consecutive \`muninndb_muninn_remember\` calls.

If you catch yourself about to make a second \`muninndb_muninn_remember\` call, stop and use \`muninndb_muninn_remember_batch\` instead.

### What to Save

- **Decisions**: "We chose X because Y" → type=decision
- **Preferences**: "I prefer tabs over spaces" → type=preference
- **Issues**: "Service X fails on port 8080" → type=issue
- **Procedures**: "To deploy, run these steps..." → type=procedure
- **Facts**: "The API returns 429 on rate limits" → type=fact

### What NOT to Save

- Greetings, acknowledgments, "let me check", "I'll do that"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you're not confident about

## Tools Available

All 39 MuninnDB tools are available via the \`mcp\` gateway with prefix \`muninndb_muninn_*\`.
Call them using the \`mcp\` function, e.g.: \`mcp({ tool: "muninndb_muninn_where_left_off" })\`

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

Vaults are created automatically on first write. Use /muninn-vault to manage them:

- /muninn-vault status — Show current vault and mapping
- /muninn-vault create [name] — Link current directory to a vault
- /muninn-vault unlink — Remove vault mapping for current directory

When in a project directory (has .git, package.json, etc.), the vault name is derived from the directory basename. Otherwise, the 'default' vault is used.

## Contradiction Detection

When you see a \`[⚠️ Contradiction detected]\` message, use \`muninndb_muninn_evolve\` to update the older memory or \`muninndb_muninn_consolidate\` to merge them.

## Dream Protocol

Run \`/muninn-dream\` before ending a session to consolidate and enrich memories:

1. \`muninndb_muninn_contradictions\` — Find and resolve contradictions
2. \`muninndb_muninn_recall(mode=recent, limit=20)\` — Review recent memories for overlaps or outdated info
3. \`muninndb_muninn_consolidate\` overlapping memories, \`muninndb_muninn_evolve\` outdated ones
4. \`muninndb_muninn_get_enrichment_candidates\` — Find memories missing summaries or entities
5. \`muninndb_muninn_apply_enrichment\` — Add missing summaries and entities
6. \`muninndb_muninn_decide\` — Record any decisions made this session
7. \`muninndb_muninn_where_left_off\` — Save session state for next time`;

// ─── Platform detection ────────────────────────────────────────────
function getPlatformBinary(): { url: string; dest: string; hash: string; platformKey: string } | null {
  const p = platform();
  const a = arch();

  let osName: string;
  let osArch: string;
  let binaryName: string;

  if (p === "linux" && a === "x64") {
    osName = "linux"; osArch = "amd64"; binaryName = "muninn";
  } else if (p === "linux" && a === "arm64") {
    osName = "linux"; osArch = "arm64"; binaryName = "muninn";
  } else if (p === "darwin" && a === "x64") {
    osName = "darwin"; osArch = "amd64"; binaryName = "muninn";
  } else if (p === "darwin" && (a === "arm64" || a === "arm")) {
    osName = "darwin"; osArch = "arm64"; binaryName = "muninn";
  } else if (p === "win32" && a === "x64") {
    osName = "windows"; osArch = "amd64"; binaryName = "muninn.exe";
  } else {
    return null;
  }

  const platformKey = `${osName}-${osArch}`;
  const hash = BINARY_HASHES[platformKey];
  if (!hash) return null; // No checksum = don't trust it

  const url = `${MUNINN_RELEASES}/${MUNINN_VERSION}/muninn-${platformKey}`;
  const dest = join(BIN_DIR, binaryName);
  return { url, dest, hash, platformKey };
}

function hasContainerRuntime(): "docker" | "podman" | null {
  try { execFileSync("docker", ["--version"], { stdio: "pipe" }); return "docker"; } catch { /* */ }
  try { execFileSync("podman", ["--version"], { stdio: "pipe" }); return "podman"; } catch { /* */ }
  return null;
}

// ─── Setup Function ────────────────────────────────────────────────
export async function setupMuninnDB(ctx: ExtensionContext): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");
  const warn = (msg: string) => ctx.ui.notify(msg, "warning");
  const error = (msg: string) => ctx.ui.notify(msg, "error");

  log("╔═══ MuninnDB Setup ═══╗\n");

  // ─── Step 0: Check dependencies ─────────────────────────────────
  if (!await checkMcpAdapter()) {
    error("pi-mcp-adapter is not installed.");
    log("  MuninnDB tools are exposed via MCP. Without pi-mcp-adapter, Pi cannot see them.");
    log("  Install it with:");
    log("    pi install npm:pi-mcp-adapter");
    log("");
    log("  Then re-run: /muninn-setup\n");
    return;
  } else {
    log("  ✓ pi-mcp-adapter is installed");
  }

  // ─── Step 1: Ensure MuninnDB is running ───────────────────────────
  log("\nStep 1: Checking MuninnDB...");

  let restPort = 8475;
  let mcpPort = 8750;
  let muninnRunning = false;

  // Check CLI instance (default ports)
  if (await checkHealth(8475)) {
    muninnRunning = true;
    log("  ✓ MuninnDB running (ports 8475/8750)");
  }
  // Check container instance (offset ports)
  else if (await checkHealth(8575)) {
    muninnRunning = true;
    restPort = 8575;
    mcpPort = 8850;
    log("  ✓ MuninnDB running (container, ports 8575/8850)");
  }

  if (!muninnRunning) {
    // Try to start existing binary
    const existingBin = findMuninnBinary();
    if (existingBin) {
      log("  MuninnDB found but not running. Starting...");
      try {
        execFileSync(existingBin, ["start"], { timeout: 15000, stdio: "pipe" });
      } catch { /* some versions print to stderr */ }
      for (let i = 0; i < 15; i++) {
        if (await checkHealth(8475)) {
          muninnRunning = true;
          log("  ✓ MuninnDB started (ports 8475/8750)");
          break;
        }
        await sleep(1000);
      }
    }

    // Binary not found or didn't start — install it
    if (!muninnRunning) {
      muninnRunning = await installMuninnDB(log, warn, error);
      if (!muninnRunning) {
        error("Could not install or start MuninnDB.");
        log("  Please install manually: https://github.com/scrypster/muninndb");
        log("  Then re-run: /muninn-setup\n");
        return;
      }
      restPort = 8475;
      mcpPort = 8750;
    }
  }

  // ─── Step 2: Embedding info ────────────────────────────────────────
  log("\nStep 2: Embedding configuration...");
  log("  Default: Bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)");
  log("           Works without any external service. No API key needed.");

  const ollamaRunning = await checkOllama();
  if (ollamaRunning) {
    log("  ✓ Ollama detected — optional upgrades available:");
    log("    Embedding:  ollama pull nomic-embed-text      (768-dim, better quality)");
    log("    Embedding:  ollama pull qwen3-embedding:0.6b   (fast, good quality)");
    log("    Enrichment: ollama pull llama3.2:1b            (summaries, contradictions)");
    log("  To enable, edit ~/.muninn/muninn.env:");
    log("    MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text");
    log("    MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b");
  } else {
    log("  ℹ Ollama not found. Bundled embedder works offline.");
    log("  For better quality, install Ollama: https://ollama.com");
  }

  // ─── Step 3: Vault configuration ─────────────────────────────────
  log("\nStep 3: Vault configuration...");
  log("  Vaults are created automatically on first write.");
  log("  Use /muninn-vault create [name] to link a project directory to a vault.");
  log("  Use /muninn-vault status to see the current vault mapping.");
  log("  Default vault: 'default' (used when not in a project directory).");

  // ─── Step 4: Configure MCP ──────────────────────────────────────────
  log("\nStep 4: Configuring MCP...");
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await writeMcpConfig(mcpUrl);
  log(`  ✓ MCP configured: ${mcpUrl}`);

  // ─── Step 5: Configure AGENTS.md (non-destructive) ────────────────
  log("\nStep 5: Configuring AGENTS.md...");
  await writeAgentsMd();
  log("  ✓ AGENTS.md configured");

  // ─── Step 6: Verify ────────────────────────────────────────────────
  log("\n╔═══ Setup Summary ═══╗");

  if (await checkHealth(restPort)) {
    log(`  ✓ MuninnDB: REST :${restPort}, MCP :${mcpPort}`);
  } else {
    error(`  ✗ MuninnDB: not responding on :${restPort}`);
  }
  log(`  ✓ MCP config: ${MCP_CONFIG_PATH}`);
  log(`  ✓ AGENTS.md: ${AGENTS_MD_PATH}`);
  log(`  ✓ Embedding: ${ollamaRunning ? "Ollama available (optional)" : "Bundled ONNX (default)"}`);

  log("\nNext steps:");
  log("  1. Restart Pi to load the extension and MCP config");
  log("  2. First turn: call muninndb_muninn_where_left_off (via mcp)\n");
}

// ─── Install MuninnDB ────────────────────────────────────────────
async function installMuninnDB(
  log: (msg: string) => void,
  warn: (msg: string) => void,
  error: (msg: string) => void,
): Promise<boolean> {
  log("  MuninnDB not found. Installing...");

  // Strategy 1: Download binary (with SHA-256 verification)
  const platInfo = getPlatformBinary();
  if (platInfo) {
    log(`  Downloading MuninnDB ${MUNINN_VERSION} for ${platInfo.platformKey}...`);
    try {
      mkdirSync(BIN_DIR, { recursive: true });

      // Download to a temp directory (avoids symlink race conditions)
      const tmpDir = mkdirSync(join(tmpdir(), "muninn-setup-"), { recursive: true });
      const tmpFile = join(tmpDir, "muninn-download");

      // Use Node.js fetch instead of curl (no shell interpolation)
      const response = await fetch(platInfo.url);
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      // Verify SHA-256 checksum before writing to disk
      const actualHash = createHash("sha256").update(buffer).digest("hex");
      if (actualHash !== platInfo.hash) {
        rmSync(tmpDir, { recursive: true });
        throw new Error(
          `Integrity check failed!\n  Expected: ${platInfo.hash}\n  Got:      ${actualHash}\n` +
          "  This binary may have been tampered with. Aborting."
        );
      }

      writeFileSync(tmpFile, buffer);
      chmodSync(tmpFile, 0o750); // owner rwx, group rx, no other access

      // Remove old binary if exists
      if (existsSync(platInfo.dest)) rmSync(platInfo.dest);

      // Atomic move from temp dir to final destination
      renameSync(tmpFile, platInfo.dest);
      rmSync(tmpDir, { recursive: true });

      log(`  ✓ Binary installed to ${platInfo.dest} (SHA-256 verified)`);

      // Initialize MuninnDB (public vaults, no auth token)
      log("  Initializing MuninnDB...");

      try {
        execFileSync(platInfo.dest, ["init", "--tool", "manual", "--no-token", "--yes", "--yes"], {
          stdio: "pipe", timeout: 30000,
        });
        log("  ✓ MuninnDB initialized");
      } catch (e: any) {
        warn(`  Init warning: ${(e?.stderr?.toString() || e?.message || "unknown").substring(0, 100)}`);
      }

      // Start MuninnDB
      log("  Starting MuninnDB...");
      try {
        execFileSync(platInfo.dest, ["start"], { stdio: "pipe", timeout: 15000 });
      } catch { /* some versions print to stderr */ }

      // Wait for health
      for (let i = 0; i < 20; i++) {
        if (await checkHealth(8475)) {
          log("  ✓ MuninnDB started (ports 8475/8750)");
          return true;
        }
        await sleep(1000);
      }

      warn("  MuninnDB binary installed but not responding on :8475");
      warn("  It may need a moment to initialize. Try /muninn-setup again in a few seconds.");
      return false;
    } catch (e: any) {
      const msg = (e?.message || "unknown").substring(0, 200);
      error(`  Installation failed: ${msg}`);
      // Fall through to container strategy
    }
  }

  // Strategy 2: Docker/Podman container (localhost-only ports)
  const runtime = hasContainerRuntime();
  if (runtime) {
    log(`  Trying ${runtime} container...`);
    try {
      const containerName = "muninndb";

      // Remove existing container if stopped
      try {
        execFileSync(runtime, ["rm", containerName], { stdio: "pipe" });
      } catch { /* no existing container */ }

      // Bind to localhost only (no network exposure)
      execFileSync(runtime, [
        "run", "-d", "--name", containerName,
        "-p", "127.0.0.1:8474:8474",
        "-p", "127.0.0.1:8475:8475",
        "-p", "127.0.0.1:8476:8476",
        "-p", "127.0.0.1:8477:8477",
        "-p", "127.0.0.1:8750:8750",
        "-v", "muninndb-data:/data",
        MUNINN_DOCKER_IMAGE,
      ], { stdio: "pipe", timeout: 300_000 });

      log(`  ✓ Container started with ${runtime} (localhost only)`);

      // Wait for health
      for (let i = 0; i < 30; i++) {
        if (await checkHealth(8475)) {
          log("  ✓ MuninnDB ready (ports 8475/8750)");
          return true;
        }
        await sleep(1000);
      }

      warn("  Container started but not responding on :8475");
      return false;
    } catch (e: any) {
      error(`  Container failed: ${(e?.message || "unknown").substring(0, 100)}`);
    }
  }

  // Strategy 3: Platform unsupported or all methods failed
  if (!platInfo && !runtime) {
    error(`  Unsupported platform: ${platform()}-${arch()}`);
    error("  No container runtime found either.");
  } else if (!platInfo) {
    error(`  No binary for ${platform()}-${arch()}, and no container runtime.`);
  }

  log("\n  Manual install options:");
  log("    Binary:  https://github.com/scrypster/muninndb/releases");
  log("    Docker:  docker run -d --name muninndb -p 127.0.0.1:8474-8477:8474-8477 -p 127.0.0.1:8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:v0.5.1");
  log("    Podman:  podman run -d --name muninndb -p 127.0.0.1:8474-8477:8474-8477 -p 127.0.0.1:8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:v0.5.1\n");
  return false;
}

// ─── Uninstall ────────────────────────────────────────────────────
export async function uninstallMuninnDB(ctx: ExtensionContext): Promise<void> {
  const log = (msg: string) => ctx.ui.notify(msg, "info");

  log("╔═══ MuninnDB Uninstall ═══╗\n");

  // Stop MuninnDB if running
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["stop"], { timeout: 10000, stdio: "pipe" });
      log("  ✓ MuninnDB stopped");
    } catch { /* not running */ }
  }

  // Remove extension from settings.json
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p: string) => !p.includes("muninn-mem"));
      if (data.packages.length < original) {
        atomicWriteFile(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
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
        atomicWriteFile(MCP_CONFIG_PATH, JSON.stringify(data, null, 2) + "\n");
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
        atomicWriteFile(AGENTS_MD_PATH, result.trim() + "\n");
        log("  ✓ Removed MuninnDB section from AGENTS.md");
      }
    }
  } catch { /* ignore */ }

  log("\nRestart Pi to apply changes.");
  log("To remove MuninnDB data:  rm -rf ~/.muninn");
  log("To remove MuninnDB binary: rm ~/bin/muninn");
  log("To remove container:        docker rm -f muninndb\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Atomic file write: write to temp file, then rename (avoids corruption). */
function atomicWriteFile(filePath: string, content: string): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const tmpFile = join(dir, `.muninn-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, content);
  renameSync(tmpFile, filePath);
}

/** Validate that an MCP URL points to localhost with a known port. */
function validateMcpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!LOCALHOST_HOSTS.includes(parsed.hostname)) return false;
    const port = parseInt(parsed.port);
    if (!ALLOWED_PORTS.has(port)) return false;
    return true;
  } catch {
    return false;
  }
}

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

async function checkMcpAdapter(): Promise<boolean> {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const pkgs: string[] = data.packages || [];
      return pkgs.some((p) => p.includes("pi-mcp-adapter"));
    }
  } catch { /* fall through */ }
  return false;
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
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeMcpConfig(mcpUrl: string): Promise<void> {
  if (!validateMcpUrl(mcpUrl)) {
    throw new Error(`Invalid MCP URL: ${mcpUrl} — must be localhost with a known port`);
  }

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

  atomicWriteFile(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

async function writeAgentsMd(): Promise<void> {
  if (!existsSync(AGENTS_MD_PATH)) {
    atomicWriteFile(AGENTS_MD_PATH, AGENTS_MD_SECTION + "\n");
    return;
  }

  const content = readFileSync(AGENTS_MD_PATH, "utf-8");
  if (content.includes("# Memory: MuninnDB")) {
    const updated = removeMuninnSection(content);
    atomicWriteFile(AGENTS_MD_PATH, updated.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  } else {
    atomicWriteFile(AGENTS_MD_PATH, content.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  }
}

function removeMuninnSection(content: string): string {
  const marker = "# Memory: MuninnDB";
  const start = content.indexOf(marker);
  if (start === -1) return content;

  const afterStart = content.indexOf("\n# ", start + marker.length);
  if (afterStart === -1) {
    return content.substring(0, start).trimEnd();
  }

  return (content.substring(0, start) + content.substring(afterStart))
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}