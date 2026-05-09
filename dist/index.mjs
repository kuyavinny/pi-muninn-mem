var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/vault.ts
var DEFAULT_VAULT = "default";
var MAX_CONTEXT_CHARS = 2e3;
var ENVIRONMENTS = {
  dev: {
    name: "dev",
    restUrl: "http://127.0.0.1:8475",
    mcpUrl: "http://127.0.0.1:8750/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true
  },
  prod: {
    name: "prod",
    restUrl: "http://127.0.0.1:8575",
    mcpUrl: "http://127.0.0.1:8850/mcp",
    sseThreshold: 0.7,
    pushOnWrite: true
  }
};
var DEFAULT_ENV = "prod";
var DEFAULT_CONFIG = {
  ...ENVIRONMENTS.prod,
  vault: void 0
};
function resolveVaultName(cwd) {
  if (!cwd || cwd === process.env.HOME || cwd === "/") {
    return DEFAULT_VAULT;
  }
  const base = cwd.split("/").filter(Boolean).pop() || DEFAULT_VAULT;
  return base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_VAULT;
}

// src/client.ts
var MuninnClient = class {
  config;
  abortController = null;
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
  /**
   * Store a single memory (engram).
   */
  async remember(params) {
    const body = {
      concept: params.concept,
      content: params.content
    };
    if (params.type) body.type = params.type;
    if (params.tags) body.tags = params.tags;
    if (params.idempotentId) body.idempotent_id = params.idempotentId;
    const res = await fetch(
      `${this.baseUrl}/api/engrams?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB remember failed (${res.status}): ${text}`);
    }
    return res.json();
  }
  /**
   * Recall memories via the 6-phase ACTIVATE pipeline.
   */
  async recall(params) {
    const body = {
      context: [params.query],
      max_results: params.maxResults ?? 5,
      mode: params.mode ?? "balanced"
    };
    const res = await fetch(
      `${this.baseUrl}/api/activate?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB recall failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.activations ?? [];
  }
  /**
   * Link two memories with a typed relationship.
   */
  async link(params) {
    const body = {
      source_id: params.sourceId,
      target_id: params.targetId,
      relation: params.relation
    };
    if (params.weight !== void 0) body.weight = params.weight;
    const res = await fetch(
      `${this.baseUrl}/api/link?vault=${encodeURIComponent(params.vault)}`,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB link failed (${res.status}): ${text}`);
    }
  }
  /**
   * Get a memory by ID.
   */
  async read(vault, engramId) {
    const res = await fetch(
      `${this.baseUrl}/api/engrams/${encodeURIComponent(engramId)}?vault=${encodeURIComponent(vault)}`,
      { headers: this.headers }
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB read failed (${res.status}): ${text}`);
    }
    return res.json();
  }
  /**
   * Get the most recently accessed memories (where_left_off equivalent via REST).
   * Response shape: { entries: Engram[], total, offset, limit }
   */
  async getRecentActivity(vault) {
    const res = await fetch(
      `${this.baseUrl}/api/session?vault=${encodeURIComponent(vault)}`,
      { headers: this.headers }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MuninnDB session failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return data.entries ?? data ?? [];
  }
  /**
   * Subscribe to real-time memory push events via SSE.
   * Returns an async generator that yields ActivationPush events.
   * Handles reconnection on connection loss.
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
  /**
   * Disconnect any active subscriptions.
   */
  disconnect() {
    this.abortController?.abort();
    this.abortController = null;
  }
};

// src/dual-client.ts
var DualMuninnClient = class {
  devClient;
  prodClient;
  currentEnv;
  constructor(initialEnv = DEFAULT_ENV) {
    this.devClient = new MuninnClient(ENVIRONMENTS.dev);
    this.prodClient = new MuninnClient(ENVIRONMENTS.prod);
    this.currentEnv = initialEnv;
  }
  /**
   * Get the client for the current environment.
   */
  getCurrentClient() {
    return this.currentEnv === "dev" ? this.devClient : this.prodClient;
  }
  /**
   * Set the current environment (dev or prod).
   */
  setEnvironment(env) {
    this.currentEnv = env;
  }
  /**
   * Get the current environment.
   */
  getEnvironment() {
    return this.currentEnv;
  }
  /**
   * Store a memory in both environments (dual-write).
   * Returns the result from the current environment.
   * If one environment fails, the other still succeeds.
   */
  async remember(params) {
    const [currentResult, _otherResult] = await Promise.allSettled([
      this.getCurrentClient().remember(params),
      (this.currentEnv === "dev" ? this.prodClient : this.devClient).remember(params)
    ]);
    if (currentResult.status === "fulfilled") {
      return currentResult.value;
    }
    if (_otherResult.status === "fulfilled") {
      return _otherResult.value;
    }
    throw new Error(
      `Failed to store memory in both environments: ${currentResult.reason?.message}, ${_otherResult.reason?.message}`
    );
  }
  /**
   * Recall memories from the current environment only.
   */
  async recall(params) {
    return this.getCurrentClient().recall(params);
  }
  /**
   * Link two memories in both environments (dual-write).
   */
  async link(params) {
    const results = await Promise.allSettled([
      this.devClient.link(params),
      this.prodClient.link(params)
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === results.length) {
      throw new Error(`Failed to link memories in both environments`);
    }
  }
  /**
   * Get a memory by ID from current environment.
   */
  async read(vault, engramId) {
    return this.getCurrentClient().read(vault, engramId);
  }
  /**
   * Get recent activity from current environment.
   */
  async getRecentActivity(vault) {
    return this.getCurrentClient().getRecentActivity(vault);
  }
  /**
   * Subscribe to real-time memory push events from current environment.
   */
  async *subscribe(vault, signal) {
    yield* this.getCurrentClient().subscribe(vault, signal);
  }
  /**
   * Sync memories from one environment to another.
   * Useful for initial setup or recovering from outages.
   */
  async sync(fromEnv, toEnv, vault) {
    const fromClient = fromEnv === "dev" ? this.devClient : this.prodClient;
    const toClient = toEnv === "dev" ? this.devClient : this.prodClient;
    const engrams = await fromClient.getRecentActivity(vault);
    for (const engram of engrams) {
      try {
        await toClient.remember({
          vault,
          concept: engram.concept,
          content: engram.content,
          type: engram.type,
          tags: engram.tags
        });
      } catch (err) {
        console.warn(`Failed to sync engram ${engram.id}:`, err);
      }
    }
  }
};

// src/shared-client.ts
var MUNINN_ENV = process.env.MUNINN_ENV || DEFAULT_ENV;
var client = new DualMuninnClient(MUNINN_ENV);

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
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

// src/knowledge-extractor.ts
var OLLAMA_BASE_URL = process.env.MUNINN_OLLAMA_URL?.replace(/^ollama:\/\//, "http://")?.replace(/\/[^/]+$/, "") ?? "http://localhost:11434";
var OLLAMA_MODEL = process.env.MUNINN_EXTRACT_MODEL ?? "llama3.2:1b";
var OLLAMA_TIMEOUT_MS = 3e4;
var EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Analyze the conversation and extract ONLY information worth remembering long-term.

Rules:
- Extract facts, decisions, preferences, issues, and procedures \u2014 NOT chitchat, acknowledgments, or meta-discussion
- Skip: greetings, "let me check", "I'll do that", tool output, error messages, status updates
- Each memory must be ATOMIC \u2014 one concept per memory
- Be specific: "Use MUNINN_LISTEN_HOST=0.0.0.0 for Docker" not "Configure networking"
- For user messages: extract implicit knowledge ("I prefer X", "We decided Y", "X doesn't work")
- For agent responses: extract only the key takeaway, not the full response
- Set confidence 0.0-1.0: how important is this to remember? 0.0 = trivial, 1.0 = critical project knowledge

Respond with JSON only, no explanation:
{"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering, respond: {"memories": []}`;
async function extractMemories(userMessage, agentResponse) {
  const conversation = `USER: ${userMessage}

ASSISTANT: ${agentResponse}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: conversation }
        ],
        stream: false,
        options: {
          temperature: 0.1,
          // Low temperature for consistent extraction
          num_predict: 512
          // Short response — just JSON
        }
      })
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";
    if (!content) return [];
    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}
async function extractUserMemories(userMessage) {
  const prompt = `Analyze this user message and extract ONLY knowledge worth remembering long-term. Skip questions, commands, and chitchat. Focus on implicit decisions, preferences, constraints, and facts the user reveals.

Rules:
- "I always use X" \u2192 preference
- "We decided on Y" \u2192 decision
- "X doesn't work with Y" \u2192 issue
- "The project uses Z" \u2192 fact
- If it's just a question or command with no knowledge, return empty array

Respond with JSON only: {"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering: {"memories": []}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage }
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 512
        }
      })
    });
    clearTimeout(timeout);
    if (!response.ok) return [];
    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";
    if (!content) return [];
    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}
function parseExtractionResponse(content) {
  let json = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(json);
    if (!parsed.memories || !Array.isArray(parsed.memories)) return [];
    return parsed.memories.filter((m) => m.concept && m.content && m.confidence >= 0.5).map((m) => ({
      concept: String(m.concept).slice(0, 512),
      content: String(m.content).slice(0, 16384),
      type: ["fact", "decision", "preference", "issue", "procedure"].includes(m.type) ? m.type : "fact",
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
      entities: Array.isArray(m.entities) ? m.entities.filter((e) => e.name && e.type).slice(0, 5).map((e) => ({ name: String(e.name), type: String(e.type) })) : [],
      confidence: Number(m.confidence) || 0.5
    }));
  } catch {
    const jsonMatch = json.match(/\{[\s\S]*"memories"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.memories && Array.isArray(parsed.memories)) {
          return parsed.memories.filter((m) => m.concept && m.content && m.confidence >= 0.5).map((m) => ({
            concept: String(m.concept).slice(0, 512),
            content: String(m.content).slice(0, 16384),
            type: ["fact", "decision", "preference", "issue", "procedure"].includes(m.type) ? m.type : "fact",
            tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
            entities: Array.isArray(m.entities) ? m.entities.filter((e) => e.name && e.type).slice(0, 5).map((e) => ({ name: String(e.name), type: String(e.type) })) : [],
            confidence: Number(m.confidence) || 0.5
          }));
        }
      } catch {
      }
    }
    return [];
  }
}
function isWorthExtracting(text) {
  if (!text || text.length < 20) return false;
  const noisePatterns = [
    /^(ok|done|sure|yes|no|thanks|thank you|got it|right|correct)\.?$/i,
    /^(error|warning|info|debug):/i,
    /^\s*\{/m,
    // raw JSON output
    /^\s*[\d.]+\s*$/m,
    // just numbers
    /^(Command exited|Process exited)/m
  ];
  for (const pattern of noisePatterns) {
    if (pattern.test(text.trim())) return false;
  }
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 5) return false;
  return true;
}

// src/extension.ts
function stableId(prefix, value) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function ensurePublicVault(vaultName) {
  return new Promise((resolve, reject) => {
    const muninnBin = process.env.MUNINN_BIN ?? findMuninnBinary();
    if (!muninnBin) return resolve();
    execFile(
      muninnBin,
      ["vault", "create", vaultName, "--public", "-u", "root", "-p"],
      { timeout: 5e3 },
      (err) => {
        if (err?.message?.includes("already exists")) return resolve();
        if (err) return reject(err);
        resolve();
      }
    );
  });
}
function findMuninnBinary() {
  const { PATH = "" } = process.env;
  const candidates = [
    ...PATH.split(":").map((d) => `${d}/muninn`),
    `${process.env.HOME}/bin/muninn`,
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
function mapIntentToProfile(prompt) {
  if (/\b(how|why|what causes|explain)\b/i.test(prompt)) return "causal";
  if (/\b(options|alternatives|what are the|recommend)\b/i.test(prompt)) return "confirmatory";
  if (/\b(problem|issue|contradiction|risk|downside|disadvantage|error|bug|failure)\b/i.test(prompt)) return "adversarial";
  if (/\b(related|connected|show me all|project structure|architecture|components)\b/i.test(prompt)) return "structural";
  return "balanced";
}
function registerLifecycleHooks(pi) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes = [];
  let sseAbort = null;
  let lastUserMessage = "";
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    ctx.ui.notify(
      `MuninnDB: Running in ${client.getEnvironment().toUpperCase()} mode`,
      "info"
    );
    try {
      await ensurePublicVault(currentVault);
    } catch {
    }
    sseAbort = new AbortController();
    startSSESubscription(client, currentVault, sseAbort.signal, (push) => {
      pendingPushes.push(push);
    });
    try {
      const recent = await client.getRecentActivity(currentVault);
      if (recent.length > 0) {
        ctx.ui.notify(
          `MuninnDB: ${recent.length} recent memories from vault "${currentVault}"`,
          "info"
        );
      } else {
        ctx.ui.notify(
          `MuninnDB: Connected to vault "${currentVault}" \u2014 no prior memories`,
          "info"
        );
      }
    } catch {
      ctx.ui.notify(
        `MuninnDB: Could not connect to vault "${currentVault}"`,
        "warning"
      );
    }
  });
  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
  });
  pi.on("before_agent_start", async (event) => {
    if (!event.prompt) return;
    lastUserMessage = event.prompt;
    try {
      const profile = mapIntentToProfile(event.prompt);
      const memories = await client.recall({
        vault: currentVault,
        query: event.prompt,
        maxResults: 5,
        mode: "balanced",
        profile
      });
      if (memories.length > 0) {
        let memoryBlock = memories.map((m) => `[${m.type}] ${m.concept} (score: ${m.score.toFixed(3)}): ${m.content}`).join("\n");
        if (memoryBlock.length > MAX_CONTEXT_CHARS) {
          memoryBlock = memoryBlock.slice(0, MAX_CONTEXT_CHARS) + "\n[...truncated]";
        }
        return {
          message: {
            customType: "muninn_memory",
            content: `Relevant memories from previous sessions:
${memoryBlock}`,
            display: true
          }
        };
      }
    } catch {
    }
    if (isWorthExtracting(event.prompt)) {
      extractUserMemories(event.prompt).then((memories) => {
        for (const mem of memories) {
          if (mem.confidence < 0.6) continue;
          client.remember({
            vault: currentVault,
            concept: mem.concept,
            content: mem.content,
            type: mem.type,
            tags: mem.tags,
            entities: mem.entities,
            idempotentId: stableId("user", mem.concept)
          }).catch(() => {
          });
        }
      });
    }
  });
  pi.on("context", async (event) => {
    if (pendingPushes.length === 0) return;
    const relevant = pendingPushes.filter((p) => p.trigger === "new_write" && p.engram).slice(0, 3);
    if (relevant.length === 0) return;
    const content = relevant.map((p) => `[Memory Update: ${p.trigger}] ${p.engram?.concept}: ${p.engram?.content}`).join("\n");
    pendingPushes = [];
    return {
      message: {
        customType: "muninn_memory",
        content,
        display: true
      }
    };
  });
  const noisyTools = /* @__PURE__ */ new Set([
    "ask_user_question",
    "bash",
    "read",
    "edit",
    "write",
    "todo",
    "advisor",
    "Agent",
    "get_subagent_result",
    "steer_subagent",
    "muninn_env",
    "remember",
    "recall",
    "decide"
  ]);
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName || noisyTools.has(event.toolName)) return;
    const resultStr = typeof event.result === "string" ? event.result : JSON.stringify(event.result).slice(0, 1e3);
    if (!isWorthExtracting(resultStr)) return;
    const idempotentId = stableId(
      "tool",
      `${event.toolName}:${resultStr.slice(0, 200)}`
    );
    try {
      await client.remember({
        vault: currentVault,
        concept: `tool:${event.toolName}`,
        content: `Called ${event.toolName} with result: ${resultStr}`,
        type: "fact",
        tags: ["tool-call", event.toolName],
        idempotentId
      });
    } catch {
    }
  });
  pi.on("agent_end", async (event) => {
    const lastMessage = event.messages?.[event.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;
    const agentText = typeof lastMessage.content === "string" ? lastMessage.content : JSON.stringify(lastMessage.content);
    if (!isWorthExtracting(agentText)) return;
    if (!lastUserMessage) return;
    try {
      const memories = await extractMemories(lastUserMessage, agentText);
      for (const mem of memories) {
        if (mem.confidence < 0.5) continue;
        await client.remember({
          vault: currentVault,
          concept: mem.concept,
          content: mem.content,
          type: mem.type,
          tags: mem.tags,
          entities: mem.entities,
          idempotentId: stableId("llm", mem.concept)
        });
      }
    } catch {
    }
  });
}

// src/tools.ts
import { Type } from "typebox";
function registerMemoryTools(pi) {
  const getVault = () => resolveVaultName(process.cwd());
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Store a memory in MuninnDB for future recall",
    parameters: Type.Object({
      concept: Type.String({
        description: "Short label for this memory (max 512 chars)"
      }),
      content: Type.String({
        description: "The actual information to remember (max 16KB)"
      }),
      memoryType: Type.Optional(
        Type.Enum(
          {
            fact: "fact",
            decision: "decision",
            preference: "preference",
            observation: "observation",
            issue: "issue",
            task: "task"
          },
          { description: "Type of memory (default: fact)" }
        )
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags for categorization"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.remember({
          vault: getVault(),
          concept: params.concept,
          content: params.content,
          type: params.memoryType ?? "fact" /* Fact */,
          tags: params.tags
        });
        return {
          content: [
            { type: "text", text: `Memory stored. ID: ${result.id}` }
          ],
          details: { engramId: result.id }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to store memory: ${message}`
            }
          ],
          details: { error: message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Search for relevant memories using semantic understanding",
    parameters: Type.Object({
      query: Type.String({
        description: "What to search for \u2014 use natural language describing what you want to find"
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: "Maximum results (default: 5, max: 20)"
        })
      ),
      mode: Type.Optional(
        Type.Enum(
          {
            balanced: "balanced",
            semantic: "semantic",
            recent: "recent",
            deep: "deep"
          },
          { description: "Search mode (default: balanced)" }
        )
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const results = await client.recall({
          vault: getVault(),
          query: params.query,
          maxResults: Math.min(params.maxResults ?? 5, 20),
          mode: params.mode ?? "balanced"
        });
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No relevant memories found."
              }
            ],
            details: { count: 0 }
          };
        }
        const text = results.map(
          (r, i) => `${i + 1}. [${r.type}] ${r.concept} (score: ${r.score.toFixed(3)})
   ${r.content}`
        ).join("\n\n");
        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} memories:

${text}`
            }
          ],
          details: { count: results.length, results }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Recall failed: ${message}` }
          ],
          details: { error: message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "decide",
    label: "Decide",
    description: "Record a decision with rationale and alternatives considered",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision made" }),
      rationale: Type.String({
        description: "Why this decision was made"
      }),
      alternatives: Type.Optional(
        Type.Array(Type.String(), {
          description: "Alternatives that were considered"
        })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.remember({
          vault: getVault(),
          concept: `decision: ${params.decision.slice(0, 80)}`,
          content: `Decision: ${params.decision}
Rationale: ${params.rationale}
Alternatives considered: ${(params.alternatives ?? []).join(", ") || "None"}`,
          type: "decision" /* Decision */,
          tags: ["decision"]
        });
        return {
          content: [
            {
              type: "text",
              text: `Decision recorded. ID: ${result.id}`
            }
          ],
          details: { engramId: result.id }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to record decision: ${message}`
            }
          ],
          details: { error: message },
          isError: true
        };
      }
    }
  });
  pi.registerTool({
    name: "muninn_env",
    label: "MuninnDB Environment",
    description: "Switch between dev (CLI) and prod (container) MuninnDB environments, or show the current environment. Writes always go to both; reads come from the active one.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("show", { description: "Show current environment and status" }),
          Type.Literal("switch", { description: "Switch to a different environment" })
        ],
        { description: "Action to perform" }
      ),
      environment: Type.Optional(
        Type.Union(
          [
            Type.Literal("dev", { description: "Local CLI instance (ports 8475/8750)" }),
            Type.Literal("prod", { description: "Container instance (ports 8575/8850)" })
          ],
          { description: "Target environment (required for 'switch')" }
        )
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.action === "show") {
          const env = client.getEnvironment();
          const cfg = ENVIRONMENTS[env];
          return {
            content: [
              {
                type: "text",
                text: `Current environment: ${env.toUpperCase()}
REST: ${cfg.restUrl}
MCP:  ${cfg.mcpUrl}`
              }
            ],
            details: { environment: env, restUrl: cfg.restUrl, mcpUrl: cfg.mcpUrl }
          };
        }
        if (params.action === "switch") {
          const target = params.environment;
          if (!target) {
            return {
              content: [
                {
                  type: "text",
                  text: "You must specify 'environment' (dev or prod) when using 'switch'."
                }
              ],
              isError: true,
              details: { error: "Missing environment parameter" }
            };
          }
          client.setEnvironment(target);
          const cfg = ENVIRONMENTS[target];
          return {
            content: [
              {
                type: "text",
                text: `Switched to ${target.toUpperCase()}
REST: ${cfg.restUrl}
MCP:  ${cfg.mcpUrl}`
              }
            ],
            details: { environment: target, restUrl: cfg.restUrl, mcpUrl: cfg.mcpUrl }
          };
        }
        return {
          content: [
            { type: "text", text: `Unknown action: ${params.action}` }
          ],
          isError: true,
          details: {}
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text", text: `Environment operation failed: ${message}` }
          ],
          isError: true,
          details: { error: message }
        };
      }
    }
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
function index_default(pi) {
  registerLifecycleHooks(pi);
  registerMemoryTools(pi);
  registerVaultInjection(pi);
}
export {
  index_default as default
};
