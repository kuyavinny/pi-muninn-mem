# Plan: Close Gaps G1/G2/G3/G5 + Redesign Client Architecture

## Part 1: Redesign DualMuninnClient → Single MuninnClient

### Problem
`DualMuninnClient` maintains two `MuninnClient` instances (dev + prod), dual-writes to both, and reads from the "active" one. This is:
- Over-engineered for the actual use case (switch between servers, not write to both simultaneously)
- Broken: SSE subscription doesn't reconnect on env switch (G4, excluded from fixes)
- Asymmetric: `remember` dual-writes, but `recall`/`subscribe` only read from one
- Has dead code: `sync()`, `read()`, `link()` are never called
- Has dead imports: `mcp-bridge.ts` and `subscribe.ts` import `client` but don't use it

### New Architecture

```
BEFORE (DualMuninnClient):
┌─────────────────────────────┐
│     DualMuninnClient        │
│  ┌─────────┐ ┌───────────┐  │
│  │devClient│ │prodClient │  │
│  │:8475    │ │:8575      │  │
│  └────┬────┘ └────┬──────┘  │
│       │  dual-write │       │
│       ▼             ▼       │
│   Promise.allSettled       │
└─────────────────────────────┘

AFTER (MuninnClient with hot-reconfigurable URL):
┌─────────────────────────┐
│     MuninnClient         │
│  baseUrl: configurable   │
│  setBaseUrl(url) → void  │
│  ┌───────────────────┐   │
│  │ single REST client│   │
│  │ pointing to one    │   │
│  │ MuninnDB server    │   │
│  └───────────────────┘   │
└─────────────────────────┘
```

### Files to Change

| File | Action | Detail |
|------|--------|--------|
| `src/dual-client.ts` | **DELETE** | Replace entirely with simpler `MuninnClient` changes |
| `src/client.ts` | **MODIFY** | Add `setBaseUrl()` method for hot URL switching |
| `src/shared-client.ts` | **SIMPLIFY** | Import `MuninnClient` directly, create singleton with env-configured URL |
| `src/vault.ts` | **SIMPLIFY** | Remove `ENVIRONMENTS`, `DEFAULT_ENV`, `Environment` type. Add `MUNINN_REST_URL` and `MUNINN_MCP_URL` env vars |
| `src/tools.ts` | **MODIFY** | Change `muninn_env` to update REST client URL + rewrite `mcp.json` + call `ctx.reload()`. Remove `DualMuninnClient` import. Remove dead import. |
| `src/subscribe.ts` | **SIMPLIFY** | Accept `MuninnClient` instead of `DualMuninnClient`. Remove dead `client` import. |
| `src/mcp-bridge.ts` | **SIMPLIFY** | Remove dead `client` import. |
| `src/extension.ts` | **MODIFY** | Remove all `DualMuninnClient` references. SSE re-subscribes automatically on reconnect. `ensurePublicVault` uses REST API directly. |
| `DEV-PROD-PLAN.md` | **DELETE** | No longer relevant |

### Detailed Changes

#### 1. `src/vault.ts` — Simplified Config

```typescript
// REMOVE:
type Environment = "dev" | "prod";
const ENVIRONMENTS = { dev: {...}, prod: {...} };
const DEFAULT_ENV = "prod";

// ADD:
const MUNINN_REST_URL = process.env.MUNINN_REST_URL ?? "http://127.0.0.1:8475";
const MUNINN_MCP_URL = process.env.MUNINN_MCP_URL ?? "http://127.0.0.1:8750/mcp";
// Default ports match dev (CLI) instance. For prod, override via env vars
// or use muninn_env switch which updates both REST client and mcp.json.

// KEEP unchanged:
// resolveVaultName, MemoryType, ActivationPush, MuninnConfig, DEFAULT_CONFIG, MAX_CONTEXT_CHARS
```

#### 2. `src/client.ts` — Add `setBaseUrl()`

Add a method to allow hot URL switching:
```typescript
class MuninnClient {
  // ... existing code ...
  
  /** Switch the REST API URL at runtime (e.g., when changing environments). */
  setBaseUrl(url: string): void {
    this.config.restUrl = url.replace(/\/+$/, ""); // strip trailing slashes
  }
}
```

No other changes needed. `MuninnClient` already works perfectly as a single-server client.

#### 3. `src/shared-client.ts` — Singleton of MuninnClient

```typescript
import { MuninnClient } from "./client";
import { MUNINN_REST_URL } from "./vault";

export const client = new MuninnClient({ restUrl: MUNINN_REST_URL });
```

Single client, single URL. Done.

#### 4. `src/dual-client.ts` — DELETE

Entire file deleted. All dual-write logic (`Promise.allSettled`) gone. All dual-read logic gone. All environment switching logic gone.

#### 5. `src/tools.ts` — New `muninn_env` Implementation

The `muninn_env` tool now:
- **`show`**: Displays current REST URL, MCP URL, and vault name
- **`switch`**: 
  1. Updates `client.setBaseUrl(newRestUrl)` — instant REST redirect
  2. Reads `~/.config/mcp/mcp.json`, updates the muninndb URL to `newMcpUrl`
  3. Writes the updated JSON back
  4. Calls `ctx.reload()` — triggers Pi reload which reconnects MCP

This means:
- REST client switches immediately (no reload needed for REST)
- MCP tools switch after reload (Pi reconnects MCP to new URL)
- SSE subscription reconnects automatically (MuninnClient.subscribe has auto-reconnect)

```typescript
// muninn_env switch action
case "switch": {
  const newRestUrl = action === "switch" && environment === "dev" 
    ? "http://127.0.0.1:8475" 
    : "http://127.0.0.1:8575";
  const newMcpUrl = environment === "dev"
    ? "http://127.0.0.1:8750/mcp"
    : "http://127.0.0.1:8850/mcp";
  
  client.setBaseUrl(newRestUrl);
  updateMcpConfig(newMcpUrl);
  // ctx.reload() triggers MCP reconnection
  break;
}
```

#### 6. `src/subscribe.ts` — Accept MuninnClient

```typescript
export async function startSSESubscription(
  client: MuninnClient,  // was: DualMuninnClient
  vault: string,
  signal: AbortSignal,
  onPush: (push: ActivationPush) => void,
): Promise<void> {
  // ... identical logic, just uses MuninnClient.subscribe() directly ...
}
```

#### 7. `src/extension.ts` — Simplified Hooks

- Remove all `DualMuninnClient` references
- `session_start`: same logic, but using `MuninnClient` directly
- `ensurePublicVault`: use REST API (`client.recall` or `fetch`) instead of CLI binary, since we have a REST client already
- `before_agent_start`: same logic, no dual-write (single write)
- `agent_end`: same logic, no dual-write (single write)
- SSE: works the same, auto-reconnects on its own

#### 8. `src/mcp-bridge.ts` — Remove Dead Import

Remove `import { client } from "./shared-client"` — it's never used.

### What Gets Removed

- `src/dual-client.ts` — entire file (116 lines)
- `DualMuninnClient` class — dual-write, dual-read, env switching, sync
- `ENVIRONMENTS` constant — hardcoded dev/prod configs
- `DEFAULT_ENV` constant — "prod" default
- `Environment` type — "dev" | "prod"
- `DEV-PROD-PLAN.md` — design doc for the removed dual architecture
- Dead imports in `tools.ts`, `subscribe.ts`, `mcp-bridge.ts`

### What Gets Added

- `MuninnClient.setBaseUrl()` method — hot URL switching
- `MUNINN_REST_URL` / `MUNINN_MCP_URL` env vars in `vault.ts`
- `updateMcpConfig()` function in `tools.ts` — writes new URL to `mcp.json`
- Environment name → URL mapping in `tools.ts` (simple object, not a class)

---

## Part 2: Close Gap G1 — Batch Storage in Hooks

### Problem
`agent_end` and `before_agent_start` call `client.remember()` individually for each extracted memory. If Ollama extracts 3 memories, that's 3 separate HTTP requests. Should use `muninn_remember_batch`.

### Fix
Add `rememberBatch()` method to `MuninnClient`:
```typescript
async rememberBatch(items: RememberParams[]): Promise<{ id: string }[]> {
  const results = [];
  for (const item of items) {
    const result = await this.remember(item);
    results.push(result);
  }
  return results;
}
```

Wait — MuninnDB has a REST API endpoint for batch? Let me check...

Actually, looking at the MCP tools, `muninn_remember_batch` exists. But the REST API may not have a batch endpoint. The simplest approach: since we're using the REST client, we can either:
1. Add a REST batch endpoint call if MuninnDB supports it
2. Just call `remember()` in a loop (sequential is fine for 2-3 memories)
3. Use `Promise.all` for parallel calls

The real gap is that we should be **using the MCP batch tool** via the bridge, not adding a REST batch method. But since the extension hooks run in the Pi process (not via MCP), we need REST.

**Decision**: Use `Promise.all` for parallel storage of extracted memories. Not a true batch endpoint, but achieves the same latency improvement for the typical 1-3 memories per extraction.

```typescript
// In agent_end:
const results = await Promise.all(
  memories.map(m => client.remember({ vault, ...m }))
));
```

---

## Part 3: Close Gap G2 — Decide with Evidence IDs

### Problem
Custom `decide` tool stores a decision as `type: "decision"` via `client.remember()`, but doesn't support `evidence_ids` linking to supporting memories. The MCP `muninn_decide` tool does this.

### Fix
Upgrade the `decide` tool to call `muninn_decide` via the REST API. First, check if MuninnDB has a REST endpoint for this...

Looking at the MuninnDB REST API, the `decide` endpoint is `POST /api/decide?vault=...` with body `{ decision, rationale, alternatives?, evidence_ids? }`.

Add a `decide()` method to `MuninnClient`:
```typescript
async decide(params: {
  vault: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  evidence_ids?: string[];
}): Promise<{ id: string }> {
  const response = await fetch(`${this.baseUrl}/api/decide?vault=${params.vault}`, {
    method: "POST",
    headers: this.headers,
    body: JSON.stringify(params),
  });
  // ... error handling ...
}
```

Then update `tools.ts` `decide` tool to accept optional `evidenceIds` parameter and call `client.decide()`.

---

## Part 4: Close Gap G3 — Auto-Evolve on Contradiction Detection

### Problem
SSE pushes `contradiction_detected` events and the context hook injects them as warnings, but nothing calls `muninn_evolve` or `muninn_consolidate` to resolve them.

### Fix
Add contradiction resolution to the `context` hook:

1. When a `contradiction_detected` push arrives with an `evolution` or `superseding` memory
2. The context hook injects the warning AND suggests a resolution action
3. Store the contradiction details as a pending action
4. The next time the agent is about to respond, the context message includes: "A contradiction was detected: [details]. Consider using muninn_evolve or muninn_consolidate to resolve it."

Actually, auto-evolving is risky — we shouldn't automatically modify memories without user confirmation. Instead:

**Approach**: Enhance the contradiction push notification to include actionable suggestions that the LLM can act on:

```typescript
if (push.trigger === "contradiction_detected") {
  // Enrich the push with actionable context
  const suggestion = push.engram 
    ? `[⚠️ Contradiction detected]: "${push.concept}" conflicts with existing memory. `
      + `Consider using muninn_evolve(id="${push.engram.id}", ...) to update it, `
      + `or muninn_consolidate to merge them.`
    : `[⚠️ Contradiction detected]: ${push.concept || "Unknown"}`;
  pendingPushes.push({ ...push, formatted: suggestion });
}
```

This way, the LLM sees the contradiction and has the specific tool calls it can make. No automatic mutation — the agent decides whether to act.

---

## Part 5: Close Gap G5 — Extraction Retry on Empty Result

### Problem
`llama3.2:1b` sometimes produces malformed JSON that the parser can't handle. When `isWorthExtracting()` returns true but the parser returns 0 memories, we silently give up.

### Fix
Add a single retry with higher temperature:

```typescript
// In extractMemories:
let memories = parseExtractionResponse(content);
if (memories.length === 0 && isWorthExtracting(userMessage + " " + agentResponse)) {
  // Retry with higher temperature for more creative extraction
  const retryResponse = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    // ... same params but temperature: 0.3 and num_predict: 768 ...
  });
  const retryData = await retryResponse.json();
  const retryContent = retryData?.message?.content?.trim() ?? "";
  if (retryContent) memories = parseExtractionResponse(retryContent);
}
```

Also add the same pattern to `extractUserMemories`.

---

## Implementation Order

1. **Redesign client architecture** (Part 1) — biggest change, do first
   - Delete `dual-client.ts`
   - Modify `client.ts` (add `setBaseUrl`)
   - Simplify `shared-client.ts`
   - Simplify `vault.ts`
   - Update `tools.ts` (muninn_env rewrite)
   - Update `subscribe.ts` (type change)
   - Update `extension.ts` (remove dual references)
   - Clean up `mcp-bridge.ts`
   - Delete `DEV-PROD-PLAN.md`

2. **Add batch storage** (Part 2) — use `Promise.all` in hooks

3. **Add decide with evidence_ids** (Part 3) — add `decide()` to MuninnClient + update tool

4. **Add contradiction suggestions** (Part 4) — enhance context hook

5. **Add extraction retry** (Part 5) — retry with higher temperature

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|-----------|
| Delete DualMuninnClient | Medium — large code removal | Compile check + manual test |
| muninn_env switch updates mcp.json | Low — straightforward JSON write | Backup mcp.json before writing |
| ctx.reload() after env switch | Medium — disrupts current session | Document that env switch reloads session |
| Decide via REST API | Low — well-defined endpoint | Test with curl first |
| Contradiction suggestions | Low — read-only enrichment | No mutation of memories |
| Extraction retry | Low — adds one more Ollama call | Only retries when worthwhile |