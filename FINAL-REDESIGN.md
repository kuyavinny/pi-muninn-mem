# MuninnDB Pi Extension — Final Redesign Plan

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Pi Extension                             │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ session_start    │  │ before_agent_     │  │ context hook  │ │
│  │ (side effects)   │  │ start (1st turn)  │  │ (SSE pushes)  │ │
│  │                  │  │                    │  │               │ │
│  │ • Start SSE      │  │ • Inject "call    │  │ • Contradict  │ │
│  │   subscription   │  │   muninn_where_   │  │   warnings    │ │
│  │ • Notify user    │  │   left_off"       │  │ • New writes  │ │
│  └────────┬─────────┘  └──────────────────┘  └───────┬───────┘ │
│           │                                           │         │
│  ┌────────┴───────────────────────────────────────────┘         │
│  │              MuninnClient (SSE only)                         │
│  │   subscribe() → GET /api/subscribe                          │
│  │   URL derived from mcp.json                                 │
│  └──────────────────────────────────────────────────────────────┘
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐ │
│  │ AGENTS.md        │  │ MCP Bridge (vault injection)         │ │
│  │ (system prompt)  │  │ injects vault into muninn_* calls    │ │
│  └──────────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │        mcp.json                │
              │  muninndb: http://host:8750/mcp│
              │  (source of truth)             │
              └───────────────┬───────────────┘
                              │
              ┌───────────────┴───────────────┐
              │         MuninnDB               │
              │  REST: /api/subscribe (SSE)     │
              │  MCP: /mcp (39 tools)           │
              └─────────────────────────────────┘
```

**All LLM-driven operations go through MCP.** The REST client exists solely for SSE subscription — the one thing MCP cannot do.

## What's Removed

| Component | Reason |
|-----------|--------|
| `src/dual-client.ts` | Entire file — single server, no dual-write |
| `src/knowledge-extractor.ts` | Entire file — LLM decides what to save |
| `src/tools.ts` | Entire file — `remember`/`recall`/`decide`/`muninn_env` all redundant with MCP |
| `src/shared-client.ts` | Replaced by simpler module |
| `DEV-PROD-PLAN.md` | No longer relevant |
| REST methods: `remember()`, `recall()`, `decide()`, `read()`, `link()`, `getRecentActivity()` | LLM uses MCP tools instead |
| Custom tools: `remember`, `recall`, `decide`, `muninn_env` | Redundant with `muninn_remember`, `muninn_recall`, `muninn_decide` |
| Lifecycle hooks: `tool_execution_end`, `agent_end` | Removed — LLM stores via MCP, Ollama extraction removed |
| `before_agent_start` recall | Removed — LLM calls `muninn_recall` when relevant |
| `before_agent_start` Ollama extraction | Removed — LLM stores via MCP + AGENTS.md prompting |
| `session_start` recall + guide | Removed — `before_agent_start` injects "call muninn_where_left_off" |
| `ENVIRONMENTS`, `DEFAULT_ENV`, `Environment` type | No environments — server URL from mcp.json |
| `ensurePublicVault()` via CLI binary | Removed — vault auto-created by first MCP write |
| Dual-write `Promise.allSettled` logic | Removed — single server |

## What's Kept (Modified)

| Component | Change |
|-----------|--------|
| `src/client.ts` | Stripped to `subscribe()` only + `setBaseUrl()`. Remove `remember`, `recall`, `decide`, `read`, `link`, `getRecentActivity`. |
| `src/vault.ts` | Remove `ENVIRONMENTS`/`DEFAULT_ENV`/`Environment`. Add `readMcpConfig()` + `deriveRestUrl()`. Keep `resolveVaultName`, `MemoryType`, `ActivationPush`, `MuninnConfig`. |
| `src/extension.ts` | Rewrite: `session_start` (SSE + notify), `before_agent_start` (first-turn context injection only), `context` (SSE pushes only), `session_shutdown`. Remove `tool_execution_end`, `agent_end`, `before_agent_start` recall + Ollama extraction. |
| `src/subscribe.ts` | Simplify — accept `MuninnClient` instead of `DualMuninnClient`. Remove dead import. |
| `src/mcp-bridge.ts` | Remove dead `client` import. Keep vault injection logic. |
| `src/shared-client.ts` | 3 lines: read mcp.json → derive REST URL → create MuninnClient |
| `index.ts` | Remove `registerMemoryTools()` call. Keep `registerLifecycleHooks()` and `registerVaultInjection()`. |
| `~/.pi/agent/AGENTS.md` | Update to reference MCP tools, remove `remember`/`recall`/`decide`/`muninn_env` references |

## New File Structure

```
src/
├── client.ts          # MuninnClient — subscribe() + setBaseUrl() only
├── extension.ts       # Lifecycle hooks (4 events, down from 6)
├── mcp-bridge.ts     # Vault injection (unchanged)
├── shared-client.ts  # 3-line singleton
├── subscribe.ts       # SSE subscription (simplified)
└── vault.ts           # Config, types, resolveVaultName, readMcpConfig, deriveRestUrl

DELETED:
├── dual-client.ts
├── knowledge-extractor.ts
├── tools.ts
└── DEV-PROD-PLAN.md
```

## Detailed File Changes

### 1. `src/vault.ts`

```typescript
// REMOVE:
type Environment = "dev" | "prod";
const ENVIRONMENTS = { ... };
const DEFAULT_ENV = "prod";
export const DEFAULT_CONFIG = { ... };

// ADD:
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MCP_CONFIG_PATH = join(homedir(), ".config/mcp/mcp.json");

export interface McpConfig {
  mcpServers: Record<string, { url?: string; [k: string]: unknown }>;
}

/** Read mcp.json to find MuninnDB server URL. */
export function readMcpConfig(): McpConfig | null {
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8"));
  } catch { return null; }
}

/** Derive REST URL from MCP URL.
 *  MuninnDB convention: REST port = MCP port - 275
 *  e.g. http://host:8750/mcp → http://host:8475
 */
export function deriveRestUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const restPort = parseInt(url.port) - 275;
  url.port = String(restPort);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "") || "";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

/** Get MuninnDB REST URL from mcp.json. */
export function getMuninnRestUrl(): string {
  const config = readMcpConfig();
  const mcpUrl = config?.mcpServers?.muninndb?.url;
  if (mcpUrl) return deriveRestUrl(mcpUrl);
  return "http://127.0.0.1:8475";  // fallback: dev instance
}

// KEEP unchanged:
// resolveVaultName, MemoryType, ActivationPush, MuninnConfig (simplified)
```

### 2. `src/client.ts` — Stripped to SSE-only

```typescript
import { MuninnConfig, ActivationPush } from "./vault";

export class MuninnClient {
  private config: MuninnConfig;

  constructor(config: Partial<MuninnConfig> = {}) {
    this.config = { restUrl: "http://127.0.0.1:8475", sseThreshold: 0.7, pushOnWrite: true, ...config };
  }

  /** Update the REST URL at runtime. */
  setBaseUrl(url: string): void {
    this.config.restUrl = url.replace(/\/+$/, "");
  }

  /**
   * Subscribe to real-time memory push events via SSE.
   * This is the ONLY REST operation we need — MCP has no equivalent.
   */
  async *subscribe(vault: string, signal?: AbortSignal): AsyncGenerator<ActivationPush> {
    const url = new URL(`${this.config.restUrl}/api/subscribe`);
    url.searchParams.set("vault", vault);
    url.searchParams.set("push_on_write", String(this.config.pushOnWrite));
    url.searchParams.set("threshold", String(this.config.sseThreshold));

    while (!signal?.aborted) {
      try {
        const response = await fetch(url.toString(), {
          headers: { Accept: "text/event-stream" },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`SSE: ${response.status}`);

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
              try { yield JSON.parse(line.slice(6)); } catch { /* skip */ }
            }
          }
        }
      } catch (err) {
        if (signal?.aborted) break;
        await new Promise(r => setTimeout(r, 5000)); // reconnect after 5s
      }
    }
  }
}
```

### 3. `src/shared-client.ts` — 3 lines

```typescript
import { MuninnClient } from "./client";
import { getMuninnRestUrl } from "./vault";

export const client = new MuninnClient({ restUrl: getMuninnRestUrl() });
```

### 4. `src/extension.ts` — Simplified to 4 events

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { client } from "./shared-client";
import { resolveVaultName, ActivationPush } from "./vault";
import { startSSESubscription } from "./subscribe";

export default function registerLifecycleHooks(pi: ExtensionAPI) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;
  let isFirstTurn = true;

  // ─── session_start: SSE subscription + user notification ───
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());

    ctx.ui.notify(`MuninnDB: vault "${currentVault}"`, "info");

    sseAbort = new AbortController();
    startSSESubscription(client, currentVault, sseAbort.signal, (push) => {
      pendingPushes.push(push);
    });
  });

  // ─── session_shutdown: Clean up SSE ───
  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
    isFirstTurn = true;
  });

  // ─── before_agent_start: Inject context on first turn only ───
  pi.on("before_agent_start", async (event) => {
    if (!isFirstTurn) return;
    isFirstTurn = false;

    return {
      message: {
        customType: "muninn_session_start",
        content:
          `MuninnDB memory is connected (vault: "${currentVault}"). ` +
          `Call muninn_where_left_off to restore context from your last session, ` +
          `then muninn_recall whenever you need relevant memories.`,
        display: false,
      },
    };
  });

  // ─── context: Inject SSE push events (contradictions + relevant writes) ───
  pi.on("context" as any, async (_event: any) => {
    if (pendingPushes.length === 0) return;

    const relevant = pendingPushes
      .filter(p => p.trigger === "new_write" || p.trigger === "contradiction_detected")
      .slice(0, 3);

    if (relevant.length === 0) return;

    const content = relevant
      .map(p => {
        if (p.trigger === "contradiction_detected" && p.engram) {
          return `[⚠️ Contradiction detected]: "${p.engram.concept}" — ${p.why ?? "New information conflicts with existing memory"}. ` +
            `Use muninn_evolve(id="${p.engram.id}", ...) to update it, or muninn_consolidate to merge.`;
        }
        return `[Memory Update]: ${p.engram?.concept}: ${p.engram?.content}`;
      })
      .join("\n");

    pendingPushes = [];
    return {
      message: {
        customType: "muninn_memory",
        content,
        display: true,
      },
    };
  });
}
```

### 5. `src/subscribe.ts` — Simplified type

```typescript
import { MuninnClient } from "./client";
import { ActivationPush } from "./vault";

export async function startSSESubscription(
  client: MuninnClient,
  vault: string,
  signal: AbortSignal,
  onPush: (push: ActivationPush) => void,
): Promise<void> {
  (async () => {
    try {
      for await (const push of client.subscribe(vault, signal)) {
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (
          push.trigger === "new_write" &&
          push.engram &&
          push.score != null &&
          push.score >= 0.7
        ) {
          onPush(push);
        }
      }
    } catch {
      // Subscription ended (expected on disconnect)
    }
  })();
}
```

### 6. `src/mcp-bridge.ts` — Remove dead import

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveVaultName } from "./vault";
// REMOVED: import { client } from "./shared-client";

export function registerVaultInjection(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (!event.toolName.startsWith("muninn_")) return;
    if (!event.input) return;
    const input = event.input as Record<string, unknown>;
    if (!input.vault) {
      input.vault = resolveVaultName(process.cwd());
    }
  });
}
```

### 7. `index.ts` — Remove registerMemoryTools

```typescript
import registerLifecycleHooks from "./src/extension";
import { registerVaultInjection } from "./src/mcp-bridge";
// REMOVED: import { registerMemoryTools } from "./src/tools";

export default function (pi: ExtensionAPI) {
  registerLifecycleHooks(pi);
  registerVaultInjection(pi);
  // REMOVED: registerMemoryTools(pi);
}
```

### 8. `~/.pi/agent/AGENTS.md` — Updated

```markdown
# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Always

Before beginning any work, call `muninn_where_left_off` to load context from the previous session.
This is unconditional — not "if relevant" but "always, before beginning any work."

## During Every Session

- **Save continuously** — this is a mindset, not a checklist.
- Anything the user shares or that emerges from the work should be saved immediately.
- Do not evaluate whether it is "important enough" — when in doubt, save it.
- Do not wait to be asked. If you discover something useful, write it to memory.

### What to Save

- **Decisions**: "We chose X because Y" → `muninn_decide`
- **Preferences**: "I prefer tabs over spaces" → `muninn_remember` type=preference
- **Issues**: "Service X fails on port 8080" → `muninn_remember` type=issue
- **Procedures**: "To deploy, run these steps..." → `muninn_remember` type=procedure
- **Facts**: "The API returns 429 on rate limits" → `muninn_remember` type=fact

### What NOT to Save

- Greetings, acknowledgments, "let me check", "I'll do that"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you're not confident about

## Tools Available

All 39 MuninnDB tools are available via MCP (prefixed `muninndb_muninn_*`).
Key tools:

| Tool | Purpose |
|------|---------|
| `muninn_where_left_off` | Restore context from last session |
| `muninn_recall` | Semantic search for relevant memories |
| `muninn_remember` | Store a fact, decision, preference, or observation |
| `muninn_decide` | Record a decision with rationale and evidence |
| `muninn_remember_batch` | Store multiple memories at once |
| `muninn_evolve` | Update a memory with new information |
| `muninn_consolidate` | Merge related memories |
| `muninn_contradictions` | Check for known contradictions |

## Vault Strategy

Each project gets its own vault (derived from the directory basename). The vault is injected automatically — you don't need to specify it.

## Contradiction Detection

When you see a `[⚠️ Contradiction detected]` message, use `muninn_evolve` to update the older memory or `muninn_consolidate` to merge them.
```

### 9. Deleted Files

- `src/dual-client.ts` — no longer needed
- `src/knowledge-extractor.ts` — LLM decides what to save
- `src/tools.ts` — custom tools redundant with MCP
- `DEV-PROD-PLAN.md` — dual-environment plan no longer relevant

## Comparison: Before vs After

| Metric | Before | After |
|--------|--------|-------|
| Source files | 8 + index.ts | 5 + index.ts |
| Total lines | ~650 | ~180 |
| REST methods | 6 (remember, recall, link, read, getRecentActivity, subscribe) | 1 (subscribe) |
| Custom tools | 4 (remember, recall, decide, muninn_env) | 0 |
| Lifecycle hooks | 6 (session_start, session_shutdown, before_agent_start, context, tool_execution_end, agent_end) | 4 (session_start, session_shutdown, before_agent_start, context) |
| Per-turn latency | ~200ms recall + 19-65s Ollama | ~0ms (SSE is background, context injection is instant) |
| External dependencies | Ollama (llama3.2:1b) for extraction | None |
| MCP config coupling | None (hardcoded URLs) | Reads mcp.json (single source of truth) |
| Dual-write logic | Yes (Promise.allSettled) | No (single server) |

## Latency Impact

| Operation | Before | After |
|-----------|--------|-------|
| Every user prompt | 200ms-1.1s (recall) | 0ms (context injection is instant) |
| Every agent response | 19-65s (Ollama extraction) | 0ms (LLM decides via MCP) |
| Every tool result | 23ms (remember) | 0ms (not stored automatically) |
| SSE push | ~0ms (background) | ~0ms (unchanged) |
| First turn | 200ms-1.1s (recall) | 0ms (LLM calls muninn_where_left_off) |

## Implementation Order

1. Rewrite `src/vault.ts` — add `readMcpConfig`, `deriveRestUrl`, `getMuninnRestUrl`; remove `ENVIRONMENTS`/`DEFAULT_ENV`/`Environment`
2. Rewrite `src/client.ts` — strip to `subscribe()` + `setBaseUrl()` only
3. Rewrite `src/shared-client.ts` — 3-line singleton from mcp.json
4. Rewrite `src/extension.ts` — 4 hooks, first-turn context injection only
5. Simplify `src/subscribe.ts` — `MuninnClient` type
6. Clean `src/mcp-bridge.ts` — remove dead import
7. Update `index.ts` — remove `registerMemoryTools`
8. Update `~/.pi/agent/AGENTS.md`
9. Delete `src/dual-client.ts`, `src/knowledge-extractor.ts`, `src/tools.ts`, `DEV-PROD-PLAN.md`
10. Compile, test, commit