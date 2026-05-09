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
function registerLifecycleHooks(pi) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes = [];
  let sseAbort = null;
  let isFirstTurn = true;
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;
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
    if (!isFirstTurn) return;
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
import { readFileSync as readFileSync2, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { execFileSync } from "node:child_process";
var HOME = homedir2();
var MCP_CONFIG_PATH2 = join2(HOME, ".config/mcp/mcp.json");
var AGENTS_MD_PATH = join2(HOME, ".pi/agent/AGENTS.md");
var MUNINN_ENV_PATH = join2(HOME, ".muninn/muninn.env");
var MUNINN_DATA_DIR = join2(HOME, ".muninn/data");
var SETTINGS_PATH = join2(HOME, ".pi/agent/settings.json");
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
async function setupMuninnDB(ctx) {
  const log = (msg) => ctx.ui.notify(msg, "info");
  const warn = (msg) => ctx.ui.notify(msg, "warning");
  const error = (msg) => ctx.ui.notify(msg, "error");
  log("\u2554\u2550\u2550\u2550 MuninnDB Setup \u2550\u2550\u2550\u2557");
  log("Step 1: Checking MuninnDB...");
  let restPort = 8475;
  let mcpPort = 8750;
  let muninnRunning = false;
  if (await checkHealth(8475)) {
    muninnRunning = true;
    log("  \u2713 MuninnDB running (CLI, ports 8475/8750)");
  } else if (await checkHealth(8575)) {
    muninnRunning = true;
    restPort = 8575;
    mcpPort = 8850;
    log("  \u2713 MuninnDB running (container, ports 8575/8850)");
  }
  if (!muninnRunning) {
    const muninnBin2 = findMuninnBinary();
    if (muninnBin2) {
      log("  MuninnDB found but not running. Starting...");
      try {
        execFileSync(muninnBin2, ["start"], { timeout: 1e4 });
        for (let i = 0; i < 10; i++) {
          if (await checkHealth(8475)) {
            muninnRunning = true;
            log("  \u2713 MuninnDB started (CLI, ports 8475/8750)");
            break;
          }
          await sleep(1e3);
        }
      } catch {
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
  log("Step 2: Embedding configuration...");
  log("  Default: Bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)");
  log("           Works without any external service. No API key needed.");
  const ollamaRunning = await checkOllama();
  if (ollamaRunning) {
    log("  \u2713 Ollama detected \u2014 optional upgrades available:");
    log("    Embedding:  ollama pull nomic-embed-text    (768-dim, better quality)");
    log("    Embedding:  ollama pull qwen3-embedding:0.6b (fast, good quality)");
    log("    Enrichment: ollama pull llama3.2:1b          (summaries, entities, contradictions)");
    log("");
    log("  To enable, edit ~/.muninn/muninn.env and restart MuninnDB:");
    log("    MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text");
    log("    MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b");
  } else {
    log("  \u2139 Ollama not found. Bundled embedder will be used (works offline).");
    log("  To upgrade embedding quality, install Ollama: https://ollama.com");
  }
  log("Step 3: Creating vault...");
  const muninnBin = findMuninnBinary();
  if (muninnBin) {
    try {
      execFileSync(muninnBin, ["vault", "create", "muninndb", "--public", "-u", "root", "-p"], { timeout: 5e3 });
      log("  \u2713 Vault 'muninndb' created (public)");
    } catch (e) {
      if (e?.message?.includes("already exists")) {
        log("  \u2713 Vault 'muninndb' already exists");
      } else {
        warn("  Could not create vault \u2014 it will be created on first write");
      }
    }
  } else {
    log("  \u2139 Vault will be created on first write (muninn binary not found)");
  }
  log("Step 4: Configuring MCP...");
  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;
  await writeMcpConfig(mcpUrl);
  log(`  \u2713 MCP configured: ${mcpUrl}`);
  log("Step 5: Configuring AGENTS.md...");
  await writeAgentsMd();
  log("  \u2713 AGENTS.md configured");
  log("");
  log("\u2554\u2550\u2550\u2550 Setup Summary \u2550\u2550\u2550\u2557");
  if (await checkHealth(restPort)) {
    log(`  \u2713 MuninnDB: REST :${restPort}, MCP :${mcpPort}`);
  } else {
    error(`  \u2717 MuninnDB: not responding on :${restPort}`);
  }
  log(`  \u2713 MCP config: ${MCP_CONFIG_PATH2}`);
  log(`  \u2713 AGENTS.md: ${AGENTS_MD_PATH}`);
  log(`  \u2713 Embedding: ${ollamaRunning ? "Ollama available (optional)" : "Bundled ONNX (default)"}`);
  log("");
  log("Next steps:");
  log("  1. Restart Pi to load the extension");
  log("  2. First turn: call muninndb_muninn_where_left_off (via mcp)");
  log("");
}
async function uninstallMuninnDB(ctx) {
  const log = (msg) => ctx.ui.notify(msg, "info");
  log("\u2554\u2550\u2550\u2550 MuninnDB Uninstall \u2550\u2550\u2550\u2557");
  try {
    if (existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(readFileSync2(SETTINGS_PATH, "utf-8"));
      const pkgs = data.packages || [];
      const original = pkgs.length;
      data.packages = pkgs.filter((p) => !p.includes("muninn-memory"));
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
      if (result.trim().length < 5) {
        log("  \u2139 AGENTS.md may be empty \u2014 remove manually if desired");
      }
    }
  } catch {
  }
  log("");
  log("Restart Pi to apply changes.");
  log("To remove MuninnDB data: rm -rf ~/.muninn");
  log("To stop MuninnDB: muninn stop");
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
  const lines = content.split("\n");
  const output = [];
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
