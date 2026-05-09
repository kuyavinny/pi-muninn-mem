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

// index.ts
import { execFile } from "node:child_process";
import { join as join2 } from "node:path";
function index_default(pi) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);
  pi.registerCommand("muninn-setup", {
    description: "Interactive setup for MuninnDB memory integration",
    handler: async (_args, ctx) => {
      const scriptPath = join2(__dirname, "muninn-setup.sh");
      try {
        ctx.ui.notify("Running MuninnDB setup...", "info");
        await new Promise((resolve, reject) => {
          execFile(
            "bash",
            [scriptPath],
            { timeout: 12e4 },
            (err, stdout, stderr) => {
              if (stdout) ctx.ui.notify(stdout, "info");
              if (stderr) ctx.ui.notify(stderr, "warning");
              if (err) reject(err);
              else resolve();
            }
          );
        });
        ctx.ui.notify("MuninnDB setup complete. Restart Pi to apply changes.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Setup failed: ${msg}`, "error");
      }
    }
  });
}
export {
  index_default as default
};
