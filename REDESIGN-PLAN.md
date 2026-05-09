# Revised Plan: Single-Client Architecture with MCP-Derived Configuration

## Core Insight

**The MCP config is the single source of truth.** Our REST client derives its URL from it. No separate URL configuration. No dual clients.

```
mcp.json (source of truth)
    │
    ├──► pi-mcp-adapter reads it → connects MCP tools to :8750/mcp or :8850/mcp
    │
    └──► our extension reads it → derives REST URL → creates MuninnClient
         (MCP :8750/mcp → REST :8475)
         (MCP :8850/mcp → REST :8575)
```

The port relationship is a MuninnDB convention:
- MCP port = REST port + 275
- Derive: strip `/mcp`, subtract 275 from port, strip any path

## Architecture Change

### BEFORE (DualMuninnClient)
```
DualMuninnClient
  ├── devClient  (MuninnClient → :8475)  ─┐
  │                                        ├─ Promise.allSettled for writes
  └── prodClient (MuninnClient → :8575)  ─┘
  currentEnv: "dev" | "prod"
  remember() → dual-write both
  recall()   → read from current
  subscribe()→ subscribe to current
```

### AFTER (MuninnClient, config-driven)
```
mcp.json
  └── "url": "http://127.0.0.1:8750/mcp"  (or :8850/mcp for prod)
        │
        ▼
  readMcpConfig()  →  deriveRestUrl()
        │
        ▼
  MuninnClient(baseUrl: "http://127.0.0.1:8475")
        │
        ├── remember()  → single write
        ├── recall()    → single read
        ├── decide()    → single write (NEW endpoint)
        └── subscribe() → single stream

muninn_env tool:
  show  → read mcp.json, display current config
  switch → write new URL to mcp.json → ctx.reload()
           (extension reinitializes, reads updated mcp.json)
```

## Files to Change

| File | Action | Detail |
|------|--------|--------|
| `src/dual-client.ts` | **DELETE** | Entire file removed |
| `src/client.ts` | **ADD** `decide()` method, **ADD** `setBaseUrl()` for future use | No other changes needed |
| `src/shared-client.ts` | **REWRITE** | Read mcp.json → derive REST URL → create MuninnClient singleton |
| `src/vault.ts` | **SIMPLIFY** | Remove `ENVIRONMENTS`, `DEFAULT_ENV`, `Environment` type. Add `readMcpConfig()` and `deriveRestUrl()`. Keep `resolveVaultName`, `MemoryType`, `ActivationPush`, `MuninnConfig`, `DEFAULT_CONFIG`, `MAX_CONTEXT_CHARS`. |
| `src/tools.ts` | **REWRITE `muninn_env`** | `show`: reads mcp.json, displays current config. `switch`: rewrites mcp.json with new URL, calls `ctx.reload()`. Add `decide` tool param for `evidenceIds`. |
| `src/subscribe.ts` | **CHANGE type** | Accept `MuninnClient` instead of `DualMuninnClient`. Remove dead `client` import. |
| `src/extension.ts` | **SIMPLIFY** | Remove all DualMuninnClient references. Remove dual-write logic. Use `Promise.all` for batch storage (G1). Enhance contradiction push (G3). |
| `src/mcp-bridge.ts` | **CLEAN UP** | Remove dead `client` import |
| `DEV-PROD-PLAN.md` | **DELETE** | No longer relevant |

## Detailed Implementation

### 1. `src/vault.ts` — Config Reading + URL Derivation

```typescript
// REMOVE:
type Environment = "dev" | "prod";
const ENVIRONMENTS = { ... };
const DEFAULT_ENV = "prod";

// ADD:
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MCP_CONFIG_PATH = join(homedir(), ".config/mcp/mcp.json");

const KNOWN_ENVIRONMENTS = {
  dev: {
    name: "dev",
    mcpUrl: "http://127.0.0.1:8750/mcp",
    restUrl: "http://127.0.0.1:8475",
  },
  prod: {
    name: "prod",
    mcpUrl: "http://127.0.0.1:8850/mcp",
    restUrl: "http://127.0.0.1:8575",
  },
};

interface McpConfig {
  mcpServers: Record<string, { url?: string; [key: string]: unknown }>;
}

/** Read the current MCP config to find the MuninnDB server URL. */
export function readMcpConfig(): McpConfig | null {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write the MCP config back to disk. */
export function writeMcpConfig(config: McpConfig): void {
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/** Derive the REST URL from the MCP URL.
 *  MuninnDB convention: REST port = MCP port - 275, strip /mcp path.
 *  e.g. http://host:8750/mcp → http://host:8475
 */
export function deriveRestUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const restPort = parseInt(url.port) - 275;
  url.port = String(restPort);
  // Strip /mcp path suffix
  url.pathname = url.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "") || "/";
  if (url.pathname === "/") url.pathname = "";
  return url.toString().replace(/\/+$/, "");
}

/** Get the current MuninnDB REST URL by reading mcp.json. */
export function getMuninnRestUrl(): string {
  const config = readMcpConfig();
  const server = config?.mcpServers?.muninndb;
  if (server?.url) {
    return deriveRestUrl(server.url);
  }
  // Fallback: dev instance
  return KNOWN_ENVIRONMENTS.dev.restUrl;
}

/** Get the current MuninnDB MCP URL by reading mcp.json. */
export function getMuninnMcpUrl(): string {
  const config = readMcpConfig();
  return config?.mcpServers?.muninndb?.url ?? KNOWN_ENVIRONMENTS.dev.mcpUrl;
}
```

### 2. `src/shared-client.ts` — Config-Driven Singleton

```typescript
import { MuninnClient } from "./client";
import { getMuninnRestUrl } from "./vault";

export const client = new MuninnClient({ restUrl: getMuninnRestUrl() });
```

That's it. 3 lines. No environment enum, no dual clients, no ENVIRONMENTS.

### 3. `src/client.ts` — Add decide() and setBaseUrl()

```typescript
// ADD to MuninnClient class:

/** Update the REST API URL at runtime. */
setBaseUrl(url: string): void {
  this.config.restUrl = url.replace(/\/+$/, "");
}

/** Record a decision with optional evidence linking. */
async decide(params: {
  vault: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  evidence_ids?: string[];
}): Promise<{ id: string }> {
  const response = await fetch(
    `${this.baseUrl}/api/decide?vault=${encodeURIComponent(params.vault)}`,
    {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        decision: params.decision,
        rationale: params.rationale,
        alternatives: params.alternatives,
        evidence_ids: params.evidence_ids,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`MuninnDB decide failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
```

### 4. `src/tools.ts` — muninn_env Rewrite

```typescript
// muninn_env tool:

case "show": {
  const config = readMcpConfig();
  const mcpUrl = getMuninnMcpUrl();
  const restUrl = getMuninnRestUrl();
  const currentEnv = Object.entries(KNOWN_ENVIRONMENTS).find(
    ([_, e]) => e.mcpUrl === mcpUrl
  )?.[0] ?? "custom";

  return {
    content: [{
      type: "text" as const,
      text: `MuninnDB Environment: ${currentEnv}\nREST: ${restUrl}\nMCP: ${mcpUrl}\nVault: ${resolveVaultName(process.cwd())}`,
    }],
  };
}

case "switch": {
  if (!environment) return errorResult("environment parameter required for switch");
  const env = KNOWN_ENVIRONMENTS[environment as keyof typeof KNOWN_ENVIRONMENTS];
  if (!env) return errorResult(`Unknown environment: ${environment}`);

  // 1. Update REST client URL immediately
  client.setBaseUrl(env.restUrl);

  // 2. Update mcp.json with new MCP URL
  const config = readMcpConfig() ?? { mcpServers: {} };
  config.mcpServers.muninndb = {
    ...config.mcpServers.muninndb,
    url: env.mcpUrl,
  };
  writeMcpConfig(config);

  // 3. Trigger Pi reload to reconnect MCP
  ctx.reload();

  return {
    content: [{
      type: "text" as const,
      text: `Switched to ${env.name} environment.\nREST: ${env.restUrl}\nMCP: ${env.mcpUrl}\n\nPi will reload to reconnect MCP tools.`,
    }],
  };
}
```

### 5. `src/extension.ts` — Simplified Hooks

All `client.remember()` calls become single writes (no more `Promise.allSettled`).

Batch storage (G1):
```typescript
// agent_end — store all extracted memories in parallel
await Promise.all(
  memories.map(m => client.remember({ vault, ...m }))
);
```

Contradiction suggestions (G3):
```typescript
if (push.trigger === "contradiction_detected" && push.engram) {
  const suggestion = `[⚠️ Contradiction]: "${push.engram.concept}" conflicts with existing memory. `
    + `Use muninn_evolve(id="${push.engram.id}", ...) to update, `
    + `or muninn_consolidate to merge them.`;
  pendingPushes.push({ ...push, formatted: suggestion });
}
```

Extraction retry (G5):
```typescript
let memories = parseExtractionResponse(content);
if (memories.length === 0 && isWorthExtracting(conversation)) {
  // Retry with higher temperature
  const retry = await callOllama(conversation, { temperature: 0.3, num_predict: 768 });
  memories = parseExtractionResponse(retry);
}
```

### 6. Delete `src/dual-client.ts`

Entire file (116 lines) deleted. All dual-write logic gone.

### 7. Clean Up Dead Imports

- `subscribe.ts`: remove `import { client } from "./shared-client"` (unused), change type from `DualMuninnClient` to `MuninnClient`
- `mcp-bridge.ts`: remove `import { client } from "./shared-client"` (unused)
- `tools.ts`: remove `import { DualMuninnClient } from "./dual-client"` (type-only, unused)

## Gap Closures

| Gap | Fix | File |
|-----|-----|------|
| **G1** Batch storage | `Promise.all` for parallel writes instead of sequential | `extension.ts` |
| **G2** Decide with evidence | Add `decide()` REST method + `evidenceIds` param to tool | `client.ts`, `tools.ts` |
| **G3** Contradiction suggestions | Enhance push formatting with actionable tool call suggestions | `extension.ts` |
| **G5** Extraction retry | Retry with `temperature: 0.3` if first attempt returns 0 memories | `knowledge-extractor.ts` |

## What's Removed

- `src/dual-client.ts` — entire file
- `ENVIRONMENTS`, `DEFAULT_ENV`, `Environment` type — from `vault.ts`
- All dual-write `Promise.allSettled` patterns
- `sync()` method — never called
- `read()`, `link()` on DualMuninnClient — never called externally
- `DEV-PROD-PLAN.md` — design doc for removed architecture
- Dead imports in `subscribe.ts`, `mcp-bridge.ts`, `tools.ts`

## What's Added

- `readMcpConfig()`, `writeMcpConfig()`, `deriveRestUrl()`, `getMuninnRestUrl()`, `getMuninnMcpUrl()` — in `vault.ts`
- `KNOWN_ENVIRONMENTS` — named presets for dev/prod URL pairs
- `MuninnClient.setBaseUrl()` — hot URL switching (used by muninn_env)
- `MuninnClient.decide()` — REST endpoint for decisions with evidence
- `muninn_env switch` — writes mcp.json + ctx.reload()
- `evidenceIds` param on `decide` tool
- Contradiction push formatting with actionable suggestions
- Extraction retry with higher temperature
- `Promise.all` for batch memory storage in hooks