var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/client.ts
var MuninnClient = class {
  config;
  constructor(config = {}) {
    this.config = {
      restUrl: "http://127.0.0.1:8475",
      sseThreshold: 0.7,
      pushOnWrite: true,
      ...config
    };
  }
  get baseUrl() {
    return this.config.restUrl;
  }
  get headers() {
    const h = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      h["Authorization"] = `Bearer ${this.config.apiKey}`;
    }
    return h;
  }
  /** Update the REST API URL at runtime (e.g., if mcp.json changes). */
  setBaseUrl(url) {
    this.config.restUrl = url.replace(/\/+$/, "");
  }
  /**
   * Subscribe to real-time memory push events via SSE.
   *
   * This is the ONLY REST operation we need. MCP has no equivalent
   * for server-push notifications. MuninnDB pushes:
   * - new_write: when a memory is stored that matches the subscription threshold
   * - contradiction_detected: when a new memory conflicts with an existing one
   * - threshold_crossed: when a memory's activation score crosses the threshold
   *
   * Auto-reconnects on connection loss with a 5-second delay.
   */
  async *subscribe(vault, signal) {
    const url = new URL(`${this.baseUrl}/api/subscribe`);
    url.searchParams.set("vault", vault);
    url.searchParams.set("push_on_write", String(this.config.pushOnWrite));
    url.searchParams.set("threshold", String(this.config.sseThreshold));
    while (!signal?.aborted) {
      try {
        const response = await fetch(url.toString(), {
          headers: { ...this.headers, Accept: "text/event-stream" },
          signal
        });
        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const push = JSON.parse(line.slice(6));
                yield push;
              } catch {
              }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) break;
        await new Promise((r) => setTimeout(r, 5e3));
      }
    }
  }
};

// src/vault.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_VAULT = "default";
var MCP_CONFIG_PATH = join(homedir(), ".config/mcp/mcp.json");
function readMcpConfig() {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function deriveRestUrl(mcpUrl) {
  const url = new URL(mcpUrl);
  const restPort = parseInt(url.port) - 275;
  url.port = String(restPort);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "");
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "";
  } else {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/\/+$/, "");
}
function getMuninnRestUrl() {
  const config = readMcpConfig();
  const mcpUrl = config?.mcpServers?.muninndb?.url;
  if (mcpUrl) return deriveRestUrl(mcpUrl);
  return "http://127.0.0.1:8475";
}
function resolveVaultName(cwd) {
  if (!cwd || cwd === process.env.HOME || cwd === "/") {
    return DEFAULT_VAULT;
  }
  const base = cwd.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
  return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_VAULT;
}

// src/shared-client.ts
var client = new MuninnClient({ restUrl: getMuninnRestUrl() });

// src/subscribe.ts
async function startSSESubscription(client2, vault, signal, onPush) {
  (async () => {
    try {
      for await (const push of client2.subscribe(vault, signal)) {
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (push.trigger === "new_write" && push.engram && push.score != null && push.score >= 0.7) {
          onPush(push);
        }
      }
    } catch {
    }
  })();
}

// src/extension.ts
async function checkMuninnHealth(muninnClient) {
  try {
    const url = muninnClient.config?.restUrl ?? "http://127.0.0.1:8475";
    const res = await fetch(`${url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
function registerLifecycleHooks(pi) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes = [];
  let sseAbort = null;
  let isFirstTurn = true;
  let muninnUp = false;
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;
    const healthResult = await checkMuninnHealth(client);
    muninnUp = healthResult;
    if (!muninnUp) {
      ctx.ui.notify(
        "MuninnDB is not running. Run /muninn-setup to install and configure it.",
        "warning"
      );
      return;
    }
    ctx.ui.notify(`MuninnDB: vault "${currentVault}"`, "info");
    sseAbort = new AbortController();
    startSSESubscription(client, currentVault, sseAbort.signal, (push) => {
      pendingPushes.push(push);
    });
  });
  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
    isFirstTurn = true;
  });
  pi.on("before_agent_start", async () => {
    if (!muninnUp || !isFirstTurn) return;
    isFirstTurn = false;
    return {
      message: {
        customType: "muninn_session_start",
        content: `MuninnDB memory is connected (vault: "${currentVault}"). Call muninndb_muninn_where_left_off (via mcp) to restore context from your last session, then muninndb_muninn_recall whenever you need relevant memories.`,
        display: false
      }
    };
  });
  pi.on("context", async () => {
    if (pendingPushes.length === 0) return;
    const relevant = pendingPushes.filter((p) => p.trigger === "new_write" || p.trigger === "contradiction_detected").slice(0, 3);
    if (relevant.length === 0) return;
    const content = relevant.map((p) => {
      if (p.trigger === "contradiction_detected" && p.engram) {
        return `[\u26A0\uFE0F Contradiction detected]: "${p.engram.concept}" \u2014 ${p.why ?? "New information conflicts with existing memory"}. Use muninndb_muninn_evolve(id="${p.engram.id}", ...) to update it, or muninndb_muninn_consolidate to merge.`;
      }
      return `[Memory Update]: ${p.engram?.concept}: ${p.engram?.content}`;
    }).join("\n");
    pendingPushes = [];
    return {
      message: {
        customType: "muninn_memory",
        content,
        display: true
      }
    };
  });
}

// src/mcp-bridge.ts
function registerVaultInjection(pi) {
  pi.on("tool_call", async (event) => {
    if (!event.toolName.startsWith("muninn_")) return;
    if (!event.input) return;
    const input = event.input;
    if (!input.vault) {
      input.vault = resolveVaultName(process.cwd());
    }
  });
}

// src/setup.ts
import { readFileSync as readFileSync2, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2, platform, arch } from "node:os";
import { execFileSync, execSync } from "node:child_process";
var HOME = homedir2();
var BIN_DIR = join2(HOME, "bin");
var MCP_CONFIG_PATH2 = join2(HOME, ".config/mcp/mcp.json");
var AGENTS_MD_PATH = join2(HOME, ".pi/agent/AGENTS.md");
var SETTINGS_PATH = join2(HOME, ".pi/agent/settings.json");
var PI_PACKAGES_DIR = join2(HOME, ".pi/agent/packages");
var MUNINN_VERSION = "v0.5.1";
var MUNINN_RELEASES = "https://github.com/scrypster/muninndb/releases/download";
var MUNINN_DOCKER_IMAGE = "ghcr.io/scrypster/muninndb:latest";
var AGENTS_MD_SECTION = `# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively \u2014 never rely on local or session-only memory.

## Session Start \u2014 Always

Before beginning any work, call \`muninndb_muninn_where_left_off\` (via mcp) to load context from the previous session.
This is unconditional \u2014 not "if relevant" but "always, before beginning any work."

## During Every Session

- **Save continuously** \u2014 this is a mindset, not a checklist.
- Anything the user shares or that emerges from the work should be saved immediately.
- Do not evaluate whether it is "important enough" \u2014 when in doubt, save it.
- Do not wait to be asked. If you discover something useful, write it to memory.

### What to Save

- **Decisions**: "We chose X because Y" \u2192 \`muninndb_muninn_decide\`
- **Preferences**: "I prefer tabs over spaces" \u2192 \`muninndb_muninn_remember\` type=preference
- **Issues**: "Service X fails on port 8080" \u2192 \`muninndb_muninn_remember\` type=issue
- **Procedures**: "To deploy, run these steps..." \u2192 \`muninndb_muninn_remember\` type=procedure
- **Facts**: "The API returns 429 on rate limits" \u2192 \`muninndb_muninn_remember\` type=fact
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
| \`muninndb_muninn_where_left_off\` | Restore context from last session \u2014 **call this first** |
| \`muninndb_muninn_recall\` | Semantic search for relevant memories |
| \`muninndb_muninn_remember\` | Store a fact, decision, preference, or observation |
| \`muninndb_muninn_decide\` | Record a decision with rationale and evidence |
| \`muninndb_muninn_remember_batch\` | Store multiple memories at once (max 50) |
| \`muninndb_muninn_evolve\` | Update a memory with new information |
| \`muninndb_muninn_consolidate\` | Merge related memories |
| \`muninndb_muninn_contradictions\` | Check for known contradictions |
| \`muninndb_muninn_guide\` | Get vault-specific usage instructions |

## Vault Strategy

Each project gets its own vault (derived from the directory basename). The vault is injected automatically \u2014 you don't need to specify it.

## Contradiction Detection

When you see a \`[\u26A0\uFE0F Contradiction detected]\` message, use \`muninndb_muninn_evolve\` to update the older memory or \`muninndb_muninn_consolidate\` to merge them.`;
function getPlatformBinary() {
  const p = platform();
  const a = arch();
  let osName;
  let osArch;
  let binaryName;
  if (p === "linux" && a === "x64") {
    osName = "linux";
    osArch = "amd64";
    binaryName = "muninn";
  } else if (p === "linux" && a === "arm64") {
    osName = "linux";
    osArch = "arm64";
    binaryName = "muninn";
  } else if (p === "darwin" && a === "x64") {
    osName = "darwin";
    osArch = "amd64";
    binaryName = "muninn";
  } else if (p === "darwin" && (a === "arm64" || a === "arm")) {
    osName = "darwin";
    osArch = "arm64";
    binaryName = "muninn";
  } else if (p === "win32" && a === "x64") {
    osName = "windows";
    osArch = "amd64";
    binaryName = "muninn.exe";
  } else {
    return null;
  }
  const url = `${MUNINN_RELEASES}/${MUNINN_VERSION}/muninn-${osName}-${osArch}`;
  const dest = join2(BIN_DIR, binaryName);
  return { url, dest };
}
function hasContainerRuntime() {
  try {
    execSync("docker --version", { stdio: "pipe" });
    return "docker";
  } catch {
  }
  try {
    execSync("podman --version", { stdio: "pipe" });
    return "podman";
  } catch {
  }
  return null;
}
async function setupMuninnDB(ctx) {
  const log = (msg) => ctx.ui.notify(msg, "info");
  const warn = (msg) => ctx.ui.notify(msg, "warning");
  const error = (msg) => ctx.ui.notify(msg, "error");
  log("\u2554\u2550\u2550\u2550 MuninnDB Setup \u2550\u2550\u2550\u2557\n");
  if (!await checkMcpAdapter()) {
    error("pi-mcp-adapter is not installed.");
    log("  MuninnDB tools are exposed via MCP. Without pi-mcp-adapter, Pi cannot see them.");
    log("  Install it with:");
    log("    pi install npm:pi-mcp-adapter");
    log("");
    log("  Then re-run: /muninn-setup\n");
    return;
  } else {
    log("  \u2713 pi-mcp-adapter is installed");
  }
  log("Step 1: Checking MuninnDB...");
  let restPort = 8475;
  let mcpPort = 8750;
  let muninnRunning = false;
  if (await checkHealth(8475)) {
    muninnRunning = true;
    log("  \u2713 MuninnDB running (ports 8475/8750)");
  } else if (await checkHealth(8575)) {
    muninnRunning = true;
    restPort = 8575;
    mcpPort = 8850;
    log("  \u2713 MuninnDB running (container, ports 8575/8850)");
  }
  if (!muninnRunning) {
    const existingBin = findMuninnBinary();
    if (existingBin) {
      log("  MuninnDB found but not running. Starting...");
      try {
        execFileSync(existingBin, ["start"], { timeout: 15e3 });
      } catch {
      }
      for (let i = 0; i < 15; i++) {
        if (await checkHealth(8475)) {
          muninnRunning = true;
          log("  \u2713 MuninnDB started (ports 8475/8750)");
          break;
        }
        await sleep(1e3);
      }
    }
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
  log("\nStep 2: Embedding configuration...");
  log("  Default: Bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)");
  log("           Works without any external service. No API key needed.");
  const ollamaRunning = await checkOllama();
  if (ollamaRunning) {
    log("  \u2713 Ollama detected \u2014 optional upgrades available:");
    log("    Embedding:  ollama pull nomic-embed-text      (768-dim, better quality)");
    log("    Embedding:  ollama pull qwen3-embedding:0.6b   (fast, good quality)");
    log("    Enrichment: ollama pull llama3.2:1b            (summaries, contradictions)");
    log("  To enable, edit ~/.muninn/muninn.env:");
    log("    MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text");
    log("    MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b");
  } else {
    log("  \u2139 Ollama not found. Bundled embedder works offline.");
    log("  For better quality, install Ollama: https://ollama.com");
  }
  log("\nStep 3: Creating vault...");
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["vault", "create", "muninndb", "--public", "-u", "root", "-p"], {
        timeout: 5e3,
        stdio: "pipe"
      });
      log("  \u2713 Vault 'muninndb' created (public)");
    } catch (e) {
      const msg = e?.stderr?.toString() || e?.message || "";
      if (msg.includes("already exists") || msg.includes("409")) {
        log("  \u2713 Vault 'muninndb' already exists");
      } else {
        warn("  Could not create vault \u2014 it will be created on first write");
      }
    }
  } else {
    log("  \u2139 Vault will be created on first write");
  }
  log("\nStep 4: Configuring MCP...");
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await writeMcpConfig(mcpUrl);
  log(`  \u2713 MCP configured: ${mcpUrl}`);
  log("\nStep 5: Configuring AGENTS.md...");
  await writeAgentsMd();
  log("  \u2713 AGENTS.md configured");
  log("\n\u2554\u2550\u2550\u2550 Setup Summary \u2550\u2550\u2550\u2557");
  if (await checkHealth(restPort)) {
    log(`  \u2713 MuninnDB: REST :${restPort}, MCP :${mcpPort}`);
  } else {
    error(`  \u2717 MuninnDB: not responding on :${restPort}`);
  }
  log(`  \u2713 MCP config: ${MCP_CONFIG_PATH2}`);
  log(`  \u2713 AGENTS.md: ${AGENTS_MD_PATH}`);
  log(`  \u2713 Embedding: ${ollamaRunning ? "Ollama available (optional)" : "Bundled ONNX (default)"}`);
  log("\nNext steps:");
  log("  1. Restart Pi to load the extension and MCP config");
  log("  2. First turn: call muninndb_muninn_where_left_off (via mcp)\n");
}
async function installMuninnDB(log, warn, error) {
  log("  MuninnDB not found. Installing...");
  const platInfo = getPlatformBinary();
  if (platInfo) {
    log(`  Downloading MuninnDB ${MUNINN_VERSION} for ${platform()}-${arch()}...`);
    try {
      mkdirSync(BIN_DIR, { recursive: true });
      const tmpFile = join2(BIN_DIR, "muninn-download-tmp");
      execSync(`curl -fSL "${platInfo.url}" -o "${tmpFile}"`, {
        stdio: "pipe",
        timeout: 12e4
      });
      chmodSync(tmpFile, 493);
      const finalDest = platInfo.dest;
      if (existsSync(finalDest)) rmSync(finalDest);
      __require("node:fs").renameSync(tmpFile, finalDest);
      log(`  \u2713 Binary installed to ${finalDest}`);
      log("  Initializing MuninnDB...");
      try {
        execSync(`"${finalDest}" init --tool manual --no-token --yes --yes`, {
          stdio: "pipe",
          timeout: 3e4
        });
        log("  \u2713 MuninnDB initialized");
      } catch (e) {
        warn(`  Init warning: ${e?.message?.substring(0, 100) || "unknown"}`);
      }
      log("  Starting MuninnDB...");
      try {
        execSync(`"${finalDest}" start`, { stdio: "pipe", timeout: 15e3 });
      } catch {
      }
      for (let i = 0; i < 20; i++) {
        if (await checkHealth(8475)) {
          log("  \u2713 MuninnDB started (ports 8475/8750)");
          return true;
        }
        await sleep(1e3);
      }
      warn("  MuninnDB binary installed but not responding on :8475");
      warn("  It may need a moment to initialize. Try /muninn-setup again in a few seconds.");
      return false;
    } catch (e) {
      warn(`  Binary download failed: ${e?.message?.substring(0, 100) || "unknown"}`);
    }
  }
  const runtime = hasContainerRuntime();
  if (runtime) {
    log(`  Trying ${runtime} container...`);
    try {
      const containerName = "muninndb";
      try {
        execSync(`${runtime} rm ${containerName} 2>/dev/null`, { stdio: "pipe" });
      } catch {
      }
      execSync(
        `${runtime} run -d --name ${containerName} -p 8474:8474 -p 8475:8475 -p 8476:8476 -p 8477:8477 -p 8750:8750 -v muninndb-data:/data ${MUNINN_DOCKER_IMAGE}`,
        { stdio: "pipe", timeout: 3e5 }
      );
      log(`  \u2713 Container started with ${runtime}`);
      for (let i = 0; i < 30; i++) {
        if (await checkHealth(8475)) {
          log("  \u2713 MuninnDB ready (ports 8475/8750)");
          return true;
        }
        await sleep(1e3);
      }
      warn("  Container started but not responding on :8475");
      return false;
    } catch (e) {
      error(`  Container failed: ${e?.message?.substring(0, 100) || "unknown"}`);
    }
  }
  if (!platInfo && !runtime) {
    error(`  Unsupported platform: ${platform()}-${arch()}`);
    error("  No container runtime found either.");
  } else if (!platInfo) {
    error(`  No binary for ${platform()}-${arch()}, and no container runtime.`);
  }
  log("\n  Manual install options:");
  log("    Binary:  https://github.com/scrypster/muninndb/releases");
  log("    Docker:  docker run -d --name muninndb -p 8474-8477:8474-8477 -p 8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:latest");
  log("    Podman:  podman run -d --name muninndb -p 8474-8477:8474-8477 -p 8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:latest\n");
  return false;
}
async function uninstallMuninnDB(ctx) {
  const log = (msg) => ctx.ui.notify(msg, "info");
  log("\u2554\u2550\u2550\u2550 MuninnDB Uninstall \u2550\u2550\u2550\u2557\n");
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["stop"], { timeout: 1e4, stdio: "pipe" });
      log("  \u2713 MuninnDB stopped");
    } catch {
    }
  }
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync2(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p) => !p.includes("muninn-mem"));
      if (data.packages.length < original) {
        writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  \u2713 Removed from Pi settings");
      }
    }
  } catch {
  }
  try {
    if (existsSync(MCP_CONFIG_PATH2)) {
      const data = JSON.parse(readFileSync2(MCP_CONFIG_PATH2, "utf-8"));
      if (data.mcpServers?.muninndb) {
        delete data.mcpServers.muninndb;
        writeFileSync(MCP_CONFIG_PATH2, JSON.stringify(data, null, 2) + "\n");
        log("  \u2713 Removed muninndb from MCP config");
      }
    }
  } catch {
  }
  try {
    if (existsSync(AGENTS_MD_PATH)) {
      const content = readFileSync2(AGENTS_MD_PATH, "utf-8");
      const result = removeMuninnSection(content);
      if (result.trim() !== content.trim()) {
        writeFileSync(AGENTS_MD_PATH, result.trim() + "\n");
        log("  \u2713 Removed MuninnDB section from AGENTS.md");
      }
    }
  } catch {
  }
  log("\nRestart Pi to apply changes.");
  log("To remove MuninnDB data:  rm -rf ~/.muninn");
  log("To remove MuninnDB binary: rm ~/bin/muninn");
  log("To remove container:        docker rm -f muninndb\n");
}
async function checkMcpAdapter() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync2(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      return pkgs.some((p) => p.includes("pi-mcp-adapter"));
    }
  } catch {
  }
  return false;
}
async function checkHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
async function checkOllama() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    return res.ok;
  } catch {
    return false;
  }
}
function findMuninnBinary() {
  const { PATH = "" } = process.env;
  const candidates = [
    ...PATH.split(":").map((d) => join2(d, "muninn")),
    join2(homedir2(), "bin/muninn"),
    "/usr/local/bin/muninn"
  ];
  for (const candidate of candidates) {
    try {
      __require("node:fs").accessSync(candidate, __require("node:fs").constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function writeMcpConfig(mcpUrl) {
  mkdirSync(join2(MCP_CONFIG_PATH2, ".."), { recursive: true });
  let config = { mcpServers: {} };
  if (existsSync(MCP_CONFIG_PATH2)) {
    try {
      config = JSON.parse(readFileSync2(MCP_CONFIG_PATH2, "utf-8"));
    } catch {
    }
  }
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.muninndb = {
    url: mcpUrl,
    lifecycle: "keep-alive",
    directTools: true
  };
  writeFileSync(MCP_CONFIG_PATH2, JSON.stringify(config, null, 2) + "\n");
}
async function writeAgentsMd() {
  mkdirSync(join2(AGENTS_MD_PATH, ".."), { recursive: true });
  if (!existsSync(AGENTS_MD_PATH)) {
    writeFileSync(AGENTS_MD_PATH, AGENTS_MD_SECTION + "\n");
    return;
  }
  const content = readFileSync2(AGENTS_MD_PATH, "utf-8");
  if (content.includes("# Memory: MuninnDB")) {
    const updated = removeMuninnSection(content);
    writeFileSync(AGENTS_MD_PATH, updated.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  } else {
    writeFileSync(AGENTS_MD_PATH, content.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  }
}
function removeMuninnSection(content) {
  const marker = "# Memory: MuninnDB";
  const start = content.indexOf(marker);
  if (start === -1) return content;
  const afterStart = content.indexOf("\n# ", start + marker.length);
  if (afterStart === -1) {
    return content.substring(0, start).trimEnd();
  }
  return (content.substring(0, start) + content.substring(afterStart)).replace(/\n{3,}/g, "\n\n").trimEnd();
}

// index.ts
function index_default(pi) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);
  pi.registerCommand("muninn-setup", {
    description: "Setup MuninnDB memory integration (install, configure, verify)",
    handler: async (_args, ctx) => {
      await setupMuninnDB(ctx);
    }
  });
  pi.registerCommand("muninn-remove", {
    description: "Remove MuninnDB integration (keeps MuninnDB data)",
    handler: async (_args, ctx) => {
      await uninstallMuninnDB(ctx);
    }
  });
}
export {
  index_default as default
};
