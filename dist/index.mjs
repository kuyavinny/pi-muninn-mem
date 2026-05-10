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
    let reconnectAttempts = 0;
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
        reconnectAttempts = 0;
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
        const retryDelay = Math.min(5e3 * Math.pow(2, reconnectAttempts), 3e5);
        reconnectAttempts++;
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  }
};

// src/vault.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var LOCALHOST_HOSTS = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
var ALLOWED_PORTS = /* @__PURE__ */ new Set([8474, 8475, 8476, 8477, 8574, 8575, 8576, 8577, 8750, 8850]);
var DEFAULT_VAULT = "default";
var HOME = homedir();
var VAULTS_CONFIG_PATH = join(HOME, ".muninn", "vaults.json");
function readVaultMapping() {
  try {
    if (!existsSync(VAULTS_CONFIG_PATH)) return {};
    const raw = readFileSync(VAULTS_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function writeVaultMapping(mapping) {
  mkdirSync(join(HOME, ".muninn"), { recursive: true });
  const tmpFile = join(HOME, ".muninn", `.vaults-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(tmpFile, JSON.stringify(mapping, null, 2) + "\n");
  const { renameSync: renameSync2 } = __require("node:fs");
  renameSync2(tmpFile, VAULTS_CONFIG_PATH);
}
var PROJECT_MARKERS2 = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml"
];
function isProjectDirectory(dir) {
  return PROJECT_MARKERS2.some((marker) => existsSync(join(dir, marker)));
}
var MCP_CONFIG_PATH = join(HOME, ".config/mcp/mcp.json");
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
  if (!LOCALHOST_HOSTS.includes(url.hostname)) {
    throw new Error(`MuninnDB URL must point to localhost, got: ${url.hostname}`);
  }
  const restPort = parseInt(url.port) - 275;
  if (!ALLOWED_PORTS.has(restPort)) {
    throw new Error(`Invalid derived REST port: ${restPort} (from MCP port ${url.port})`);
  }
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
  if (mcpUrl) {
    try {
      return deriveRestUrl(mcpUrl);
    } catch {
    }
  }
  return "http://127.0.0.1:8475";
}
function resolveVaultName(cwd) {
  const dir = cwd || process.cwd() || "/";
  if (dir === HOME || dir === "/") {
    return DEFAULT_VAULT;
  }
  const mapping = readVaultMapping();
  if (mapping[dir]) {
    return mapping[dir];
  }
  if (isProjectDirectory(dir)) {
    const base = dir.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
    return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").substring(0, 64) || DEFAULT_VAULT;
  }
  return DEFAULT_VAULT;
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
var MUNINN_TOOLS = /* @__PURE__ */ new Set([
  "muninndb_muninn_remember",
  "muninndb_muninn_recall",
  "muninndb_muninn_decide",
  "muninndb_muninn_evolve",
  "muninndb_muninn_consolidate",
  "muninndb_muninn_contradictions",
  "muninndb_muninn_where_left_off",
  "muninndb_muninn_guide",
  "muninndb_muninn_remember_batch",
  "muninndb_muninn_status",
  "muninndb_muninn_health",
  "muninndb_muninn_read",
  "muninndb_muninn_link",
  "muninndb_muninn_unlink",
  "muninndb_muninn_search",
  "muninndb_muninn_delete",
  "muninndb_muninn_list",
  "muninndb_muninn_summary"
]);
var individualRememberCount = 0;
function registerVaultInjection(pi) {
  pi.on("before_agent_start", async () => {
    individualRememberCount = 0;
  });
  pi.on("tool_call", async (event) => {
    if (!MUNINN_TOOLS.has(event.toolName)) return;
    if (!event.input) return;
    const input = event.input;
    if (!input.vault) {
      event.input = { ...input, vault: resolveVaultName(process.cwd()) };
    }
    if (event.toolName === "muninndb_muninn_remember") {
      individualRememberCount++;
      if (individualRememberCount === 2) {
        return {
          message: {
            customType: "muninn_batch_nudge",
            content: "\u{1F4A1} You've made 2 individual muninn_remember calls this turn. Use muninndb_muninn_remember_batch for related memories instead of multiple individual calls. Assess all memories first, then batch save.",
            display: true
          }
        };
      }
    }
    if (event.toolName === "muninndb_muninn_remember_batch") {
      individualRememberCount = 0;
    }
  });
}

// src/setup.ts
import {
  readFileSync as readFileSync2,
  writeFileSync as writeFileSync2,
  mkdirSync as mkdirSync2,
  existsSync as existsSync2,
  chmodSync,
  rmSync,
  renameSync,
  accessSync,
  constants
} from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2, platform, arch, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
var HOME2 = homedir2();
var BIN_DIR = join2(HOME2, "bin");
var MCP_CONFIG_PATH2 = join2(HOME2, ".config/mcp/mcp.json");
var AGENTS_MD_PATH = join2(HOME2, ".pi/agent/AGENTS.md");
var SETTINGS_PATH = join2(HOME2, ".pi/agent/settings.json");
var MUNINN_DATA_DIR = join2(HOME2, ".muninn/data");
var MUNINN_VERSION = "v0.5.1";
var MUNINN_RELEASES = "https://github.com/scrypster/muninndb/releases/download";
var MUNINN_DOCKER_IMAGE = "ghcr.io/scrypster/muninndb:v0.5.1";
var BINARY_HASHES = {
  "linux-amd64": "ff15cdb85e42b68f71f993f5ada7c1e7654e049e1765e70d061c6cc37af82837",
  "linux-arm64": "da8753d0375c68a69f98290ee4e8912c94fc51c8f581553423188e4ea6500345",
  "darwin-amd64": "e4e0175983ed50f01930855a9282cf591905fddc2b9b49be371ca623afc75ce0",
  "darwin-arm64": "5d6883ef3aa48345354b2bfc0a77d676834c6f7d71fbea11de61ecbaa76a44fe",
  "windows-amd64": "1aacd174870aedb7ce477a22432ff2e3bc3ac0a455bb43d58d966f111f961e12"
};
var LOCALHOST_HOSTS2 = ["127.0.0.1", "localhost", "::1", "0.0.0.0"];
var ALLOWED_PORTS2 = /* @__PURE__ */ new Set([8474, 8475, 8476, 8477, 8574, 8575, 8576, 8577, 8750, 8850]);
var AGENTS_MD_SECTION = `# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively \u2014 never rely on local or session-only memory.

## Session Start \u2014 Always

Before beginning any work, call \`muninndb_muninn_where_left_off\` (via mcp) to load context from the previous session.
This is unconditional \u2014 not "if relevant" but "always, before beginning any work."

## Save Protocol

1. **ASSESS** \u2014 Before saving anything from this turn, review the entire exchange and identify ALL memories worth saving.
2. **CHOOSE** \u2014 Based on the count:
   - 1 memory \u2192 \`muninndb_muninn_remember\`
   - 2+ memories \u2192 \`muninndb_muninn_remember_batch\`
3. **SAVE** \u2014 Execute once. Never make two consecutive \`muninndb_muninn_remember\` calls.

If you catch yourself about to make a second \`muninndb_muninn_remember\` call, stop and use \`muninndb_muninn_remember_batch\` instead.

### What to Save

- **Decisions**: "We chose X because Y" \u2192 type=decision
- **Preferences**: "I prefer tabs over spaces" \u2192 type=preference
- **Issues**: "Service X fails on port 8080" \u2192 type=issue
- **Procedures**: "To deploy, run these steps..." \u2192 type=procedure
- **Facts**: "The API returns 429 on rate limits" \u2192 type=fact

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

Vaults are created automatically on first write. Use /muninn-vault to manage them:

- /muninn-vault status \u2014 Show current vault and mapping
- /muninn-vault create [name] \u2014 Link current directory to a vault
- /muninn-vault unlink \u2014 Remove vault mapping for current directory

When in a project directory (has .git, package.json, etc.), the vault name is derived from the directory basename. Otherwise, the 'default' vault is used.

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
  const platformKey = `${osName}-${osArch}`;
  const hash = BINARY_HASHES[platformKey];
  if (!hash) return null;
  const url = `${MUNINN_RELEASES}/${MUNINN_VERSION}/muninn-${platformKey}`;
  const dest = join2(BIN_DIR, binaryName);
  return { url, dest, hash, platformKey };
}
function hasContainerRuntime() {
  try {
    execFileSync("docker", ["--version"], { stdio: "pipe" });
    return "docker";
  } catch {
  }
  try {
    execFileSync("podman", ["--version"], { stdio: "pipe" });
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
  log("\nStep 1: Checking MuninnDB...");
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
        execFileSync(existingBin, ["start"], { timeout: 15e3, stdio: "pipe" });
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
  log("\nStep 3: Vault configuration...");
  log("  Vaults are created automatically on first write.");
  log("  Use /muninn-vault create [name] to link a project directory to a vault.");
  log("  Use /muninn-vault status to see the current vault mapping.");
  log("  Default vault: 'default' (used when not in a project directory).");
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
    log(`  Downloading MuninnDB ${MUNINN_VERSION} for ${platInfo.platformKey}...`);
    try {
      mkdirSync2(BIN_DIR, { recursive: true });
      const tmpDir = mkdirSync2(join2(tmpdir(), "muninn-setup-"), { recursive: true });
      const tmpFile = join2(tmpDir, "muninn-download");
      const response = await fetch(platInfo.url);
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const actualHash = createHash("sha256").update(buffer).digest("hex");
      if (actualHash !== platInfo.hash) {
        rmSync(tmpDir, { recursive: true });
        throw new Error(
          `Integrity check failed!
  Expected: ${platInfo.hash}
  Got:      ${actualHash}
  This binary may have been tampered with. Aborting.`
        );
      }
      writeFileSync2(tmpFile, buffer);
      chmodSync(tmpFile, 488);
      if (existsSync2(platInfo.dest)) rmSync(platInfo.dest);
      renameSync(tmpFile, platInfo.dest);
      rmSync(tmpDir, { recursive: true });
      log(`  \u2713 Binary installed to ${platInfo.dest} (SHA-256 verified)`);
      log("  Initializing MuninnDB...");
      try {
        execFileSync(platInfo.dest, ["init", "--tool", "manual", "--no-token", "--yes", "--yes"], {
          stdio: "pipe",
          timeout: 3e4
        });
        log("  \u2713 MuninnDB initialized");
      } catch (e) {
        warn(`  Init warning: ${(e?.stderr?.toString() || e?.message || "unknown").substring(0, 100)}`);
      }
      log("  Starting MuninnDB...");
      try {
        execFileSync(platInfo.dest, ["start"], { stdio: "pipe", timeout: 15e3 });
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
      const msg = (e?.message || "unknown").substring(0, 200);
      error(`  Installation failed: ${msg}`);
    }
  }
  const runtime = hasContainerRuntime();
  if (runtime) {
    log(`  Trying ${runtime} container...`);
    try {
      const containerName = "muninndb";
      try {
        execFileSync(runtime, ["rm", containerName], { stdio: "pipe" });
      } catch {
      }
      execFileSync(runtime, [
        "run",
        "-d",
        "--name",
        containerName,
        "-p",
        "127.0.0.1:8474:8474",
        "-p",
        "127.0.0.1:8475:8475",
        "-p",
        "127.0.0.1:8476:8476",
        "-p",
        "127.0.0.1:8477:8477",
        "-p",
        "127.0.0.1:8750:8750",
        "-v",
        "muninndb-data:/data",
        MUNINN_DOCKER_IMAGE
      ], { stdio: "pipe", timeout: 3e5 });
      log(`  \u2713 Container started with ${runtime} (localhost only)`);
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
      error(`  Container failed: ${(e?.message || "unknown").substring(0, 100)}`);
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
  log("    Docker:  docker run -d --name muninndb -p 127.0.0.1:8474-8477:8474-8477 -p 127.0.0.1:8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:v0.5.1");
  log("    Podman:  podman run -d --name muninndb -p 127.0.0.1:8474-8477:8474-8477 -p 127.0.0.1:8750:8750 -v muninndb-data:/data ghcr.io/scrypster/muninndb:v0.5.1\n");
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
    if (existsSync2(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync2(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p) => !p.includes("muninn-mem"));
      if (data.packages.length < original) {
        atomicWriteFile(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n");
        log("  \u2713 Removed from Pi settings");
      }
    }
  } catch {
  }
  try {
    if (existsSync2(MCP_CONFIG_PATH2)) {
      const data = JSON.parse(readFileSync2(MCP_CONFIG_PATH2, "utf-8"));
      if (data.mcpServers?.muninndb) {
        delete data.mcpServers.muninndb;
        atomicWriteFile(MCP_CONFIG_PATH2, JSON.stringify(data, null, 2) + "\n");
        log("  \u2713 Removed muninndb from MCP config");
      }
    }
  } catch {
  }
  try {
    if (existsSync2(AGENTS_MD_PATH)) {
      const content = readFileSync2(AGENTS_MD_PATH, "utf-8");
      const result = removeMuninnSection(content);
      if (result.trim() !== content.trim()) {
        atomicWriteFile(AGENTS_MD_PATH, result.trim() + "\n");
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
function atomicWriteFile(filePath, content) {
  const dir = join2(filePath, "..");
  mkdirSync2(dir, { recursive: true });
  const tmpFile = join2(dir, `.muninn-cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync2(tmpFile, content);
  renameSync(tmpFile, filePath);
}
function validateMcpUrl(url) {
  try {
    const parsed = new URL(url);
    if (!LOCALHOST_HOSTS2.includes(parsed.hostname)) return false;
    const port = parseInt(parsed.port);
    if (!ALLOWED_PORTS2.has(port)) return false;
    return true;
  } catch {
    return false;
  }
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
async function checkMcpAdapter() {
  try {
    if (existsSync2(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync2(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      return pkgs.some((p) => p.includes("pi-mcp-adapter"));
    }
  } catch {
  }
  return false;
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
      accessSync(candidate, constants.X_OK);
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
  if (!validateMcpUrl(mcpUrl)) {
    throw new Error(`Invalid MCP URL: ${mcpUrl} \u2014 must be localhost with a known port`);
  }
  let config = { mcpServers: {} };
  if (existsSync2(MCP_CONFIG_PATH2)) {
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
  atomicWriteFile(MCP_CONFIG_PATH2, JSON.stringify(config, null, 2) + "\n");
}
async function writeAgentsMd() {
  if (!existsSync2(AGENTS_MD_PATH)) {
    atomicWriteFile(AGENTS_MD_PATH, AGENTS_MD_SECTION + "\n");
    return;
  }
  const content = readFileSync2(AGENTS_MD_PATH, "utf-8");
  if (content.includes("# Memory: MuninnDB")) {
    const updated = removeMuninnSection(content);
    atomicWriteFile(AGENTS_MD_PATH, updated.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
  } else {
    atomicWriteFile(AGENTS_MD_PATH, content.trim() + "\n\n" + AGENTS_MD_SECTION + "\n");
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
          const sanitizedName = vaultName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").substring(0, 64);
          if (!sanitizedName || sanitizedName === "default") {
            ctx.ui.notify('Cannot create a vault named "default". Choose a project-specific name.', "warning");
            return;
          }
          mapping[cwd] = sanitizedName;
          writeVaultMapping(mapping);
          ctx.ui.notify(
            `\u2713 Linked ${cwd} \u2192 vault "${sanitizedName}"
  Memories in this directory will use vault "${sanitizedName}".
  The vault will be created on first write.`,
            "info"
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
            `\u2713 Unlinked ${cwd} from vault "${removed}".
  This directory will now use vault "${isProject ? cwd.split("/").pop()?.toLowerCase() : "default"}".`,
            "info"
          );
          break;
        }
        case "status":
        default: {
          const lines = [
            `Directory: ${cwd}`,
            `Vault: ${currentVault}`,
            `Resolution: ${mapping[cwd] ? "explicit (vaults.json)" : isProject ? "auto-detected (project marker)" : "default (non-project dir)"}`
          ];
          if (isProject) {
            lines.push(`Project markers: ${PROJECT_MARKERS.filter((m) => __require("node:fs").existsSync(__require("node:path").join(cwd, m))).join(", ") || "none"}`);
          }
          const mappingCount = Object.keys(mapping).length;
          if (mappingCount > 0) {
            lines.push(`
Linked vaults (${mappingCount}):`);
            for (const [dir, vault] of Object.entries(mapping)) {
              const marker = dir === cwd ? " \u2190 current" : "";
              lines.push(`  ${vault.padEnd(20)} ${dir}${marker}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }
      }
    }
  });
}
export {
  index_default as default
};
