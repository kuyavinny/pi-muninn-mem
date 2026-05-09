# MuninnDB Pi Extension — Architecture & Parity Analysis

## Extension Summary

The MuninnDB Pi extension is a **hybrid memory provider** that gives Pi persistent, semantic memory via MuninnDB. It combines automatic lifecycle hooks (for hands-off memory capture/injection) with custom tools (for on-demand LLM-driven operations) and an MCP bridge (for access to all 39 MuninnDB operations).

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Pi Extension Layer                        │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │  Lifecycle    │  │  Custom      │  │  MCP Bridge       │ │
│  │  Hooks       │  │  Tools       │  │  (vault inject)   │ │
│  │  (6 events)  │  │  (4 tools)   │  │                   │ │
│  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘ │
│         │                  │                    │            │
│  ┌──────┴──────────────────┴────────────────────┘            │
│  │           DualMuninnClient (singleton)                    │
│  │   devClient (8475)  ◄──────────►  prodClient (8575)      │
│  │   Writes: Promise.allSettled to BOTH                     │
│  │   Reads: from ACTIVE env only                            │
│  └───────────────────────────────────────────────────────────┘
│                              │                               │
│  ┌───────────────────────────┼────────────────────────────┐ │
│  │  Knowledge Extractor     │       SSE Subscriber        │ │
│  │  (Ollama llama3.2:1b)    │  (contradictions + writes) │ │
│  └───────────────────────────┼────────────────────────────┘ │
└──────────────────────────────┼──────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │   MuninnDB           │
                    │   REST: 8475/8575    │
                    │   MCP:  8750/8850    │
                    │   SSE:  8475/8575    │
                    └─────────────────────┘
```

### Component Breakdown

| Component | File | Purpose |
|-----------|------|---------|
| Entry point | `index.ts` | Wires all subsystems together |
| Lifecycle hooks | `src/extension.ts` | 6 Pi event handlers for automatic memory |
| Custom tools | `src/tools.ts` | `remember`, `recall`, `decide`, `muninn_env` |
| MCP bridge | `src/mcp-bridge.ts` | Injects per-project vault into `muninn_*` calls |
| REST client | `src/client.ts` | Low-level HTTP wrapper for MuninnDB REST API |
| Dual client | `src/dual-client.ts` | Dev+prod dual-write, active-env-read |
| Shared singleton | `src/shared-client.ts` | Single DualMuninnClient instance |
| Knowledge extractor | `src/knowledge-extractor.ts` | Ollama-based LLM extraction pipeline |
| SSE subscriber | `src/subscribe.ts` | Real-time push event handler |
| Config & types | `src/vault.ts` | Environment configs, types, vault resolution |
| System prompt | `~/.pi/agent/AGENTS.md` | "Always save" mindset instructions |

### Lifecycle Hooks — What Fires When

| Hook | What Happens | MuninnDB Operations |
|------|-------------|---------------------|
| `session_start` | Resolve vault → ensure public → subscribe SSE → recall guide → recall recent context | `vault create`, `recall(mode=recent)`, `recall(profile=confirmatory)` |
| `session_shutdown` | Abort SSE subscription | — |
| `before_agent_start` | Recall relevant memories (intent-mapped profile) → background extract user knowledge | `recall(mode=balanced, profile)`, `remember` (async via Ollama) |
| `context` | Inject SSE push events (contradictions, high-score writes) | SSE subscription output |
| `tool_execution_end` | Store non-noisy tool results as facts (idempotent) | `remember` |
| `agent_end` | Extract key takeaways from conversation (Ollama) → store | `remember` (batch via Ollama) |

### Custom Tools — Parameters & Logic

| Tool | Key Parameters | What It Does |
|------|---------------|-------------|
| `remember` | concept, content, memoryType?, tags? | Stores a memory via dual-client |
| `recall` | query, maxResults?, mode? | Semantic search with intent-mapped profiles |
| `decide` | decision, rationale, alternatives? | Stores a decision with reasoning |
| `muninn_env` | action (show/switch), environment? | Shows or switches dev/prod environment |

### 39 MCP Tools Available

All MuninnDB MCP tools are available via `pi-mcp-adapter` + vault injection bridge:
remember, remember_batch, recall, read, forget, link, contradictions, status, evolve, consolidate, session, decide, restore, traverse, explain, state, list_deleted, retry_enrich, get_enrichment_candidates, apply_enrichment, guide, where_left_off, find_by_entity, entity_state, entity_state_batch, remember_tree, recall_tree, entity_clusters, export_graph, add_child, similar_entities, merge_entity, replay_enrichment, provenance, entity_timeline, feedback, entity, entities, trust

---

## Parity Analysis: Pi Extension vs Claude Code + MuninnDB

### How Claude Code Connects to MuninnDB

Claude Code connects via MCP natively — a one-line config in `~/.claude.json`:
```json
{ "mcpServers": { "muninn": { "type": "http", "url": "http://127.0.0.1:8750/mcp" } } }
```

Plus a `CLAUDE.md` (or `AGENT.md`) system prompt that instructs the agent to:
1. Always recall at session start (`muninn_recall` / `muninn_where_left_off`)
2. Save continuously — "saving is a mindset, not a checklist"
3. Call `muninn_guide` on first connect

That's it. Claude Code has **no lifecycle hooks, no automatic extraction, no SSE subscription**. Everything is LLM-driven — the agent calls MCP tools when it decides to.

### Feature-by-Feature Comparison

| # | Feature | Claude Code | Pi Extension | Parity |
|---|---------|-------------|-------------|--------|
| 1 | **MCP tool access** | ✅ Native — all 39 tools | ✅ Via pi-mcp-adapter + vault injection | ✅ Parity |
| 2 | **System prompt / AGENTS.md** | ✅ CLAUDE.md pattern | ✅ `~/.pi/agent/AGENTS.md` | ✅ Parity |
| 3 | **muninn_guide on first connect** | ✅ LLM-driven (prompted) | ✅ Auto-called in session_start | ✅ Parity (Pi is better — automatic) |
| 4 | **muninn_where_left_off at session start** | ✅ LLM-driven (prompted) | ✅ Auto-called in session_start (recall mode=recent) | ✅ Parity (Pi is better — automatic) |
| 5 | **Recall relevant memories before response** | ✅ LLM-driven (prompted) | ✅ Auto-injected in before_agent_start (intent-mapped) | ✅ Parity (Pi is better — automatic + intent mapping) |
| 6 | **Per-project vault isolation** | ❌ Manual — LLM must specify vault | ✅ Automatic — vault derived from cwd, injected by bridge | ✅ Pi is better |
| 7 | **Continuous saving** | ✅ LLM-driven (prompted) | ✅ Automatic (tool_execution_end, agent_end) + LLM-driven (remember tool) | ✅ Parity (Pi has both automatic and explicit) |
| 8 | **LLM-based knowledge extraction** | ❌ Not available — relies on LLM choosing to save | ✅ Ollama extraction in before_agent_start + agent_end | ✅ Pi is better |
| 9 | **Batch storage (remember_batch)** | ✅ Available via MCP | ⚠️ Available via MCP but **not used in automatic hooks** | ❌ Gap — hooks store one-at-a-time |
| 10 | **Contradiction detection + handling** | ✅ Available via MCP | ⚠️ SSE subscription exists, context hook injects warnings, **but no muninn_evolve handler** | ❌ Gap — detection works, resolution is manual |
| 11 | **SSE push subscription** | ❌ Not available | ✅ Active SSE subscription with threshold filtering | ✅ Pi is better |
| 12 | **Dev/prod dual environment** | ❌ Not available | ✅ DualMuninnClient with dual-write, active-read | ✅ Pi is better |
| 13 | **Decide tool** | ✅ muninn_decide via MCP | ✅ Custom `decide` tool (simpler — stores as decision type) | ⚠️ Partial — custom tool doesn't use muninn_decide's full schema (no evidence_ids linking) |
| 14 | **Hierarchical memory (remember_tree)** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 15 | **Entity management** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 16 | **Graph traversal** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 17 | **Trust levels** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 18 | **Memory state transitions** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 19 | **Enrichment pipeline** | ✅ Available via MCP | ✅ Available via MCP | ✅ Parity |
| 20 | **Auto vault creation** | ❌ Manual — user must pre-create vaults | ✅ Automatic — ensurePublicVault() in session_start | ✅ Pi is better |
| 21 | **Knowledge extraction confidence gating** | ❌ N/A | ✅ User msgs ≥0.6, agent ≥0.5 | ✅ Pi is better |
| 22 | **Noise filtering** | ❌ N/A — LLM decides | ✅ isWorthExtracting() + noisyTools set | ✅ Pi is better |
| 23 | **Idempotent writes** | ❌ Not available — relies on LLM not duplicating | ✅ sha256-based idempotent keys on auto-stores | ✅ Pi is better |

### Gaps to Close

| # | Gap | Priority | Description | Fix |
|---|-----|----------|-------------|-----|
| G1 | **No batch storage in hooks** | Medium | `agent_end` and `before_agent_start` call `remember()` individually per extracted memory. Should use `muninn_remember_batch` for efficiency. | Add batch method to DualMuninnClient, use it in hooks when >1 memory extracted |
| G2 | **Decide tool doesn't use muninn_decide** | Low | Custom `decide` tool stores as a decision type via `remember`, but doesn't support `evidence_ids` linking. The MCP `muninn_decide` tool links decisions to supporting memories. | Upgrade `decide` tool to call `muninn_decide` via MCP, or add evidence_ids support |
| G3 | **No auto-evolve on contradiction** | Medium | SSE pushes `contradiction_detected` events and the context hook injects them as warnings, but there's no handler that calls `muninn_evolve` or `muninn_consolidate` to resolve them. | Add contradiction resolution logic: on `contradiction_detected`, call `muninn_evolve` to update the older memory |
| G4 | **SSE doesn't reconnect on env switch** | Low | `muninn_env switch` changes the active environment but the SSE subscription stays connected to the old one. Requires session restart. | Re-subscribe SSE when environment switches |
| G5 | **LLM extraction parser edge case** | Low | Very small models (llama3.2:1b) sometimes produce malformed JSON. The brace-depth parser handles most cases but could still miss edge cases. | Add fallback: if extraction returns 0 memories and isWorthExtracting was true, retry with temperature=0.3 |
| G6 | **No `muninn_remember_tree` usage** | Low | Available via MCP but never used in automatic hooks. Could be useful for storing structured conversation summaries. | Consider adding a hook that creates tree structures for complex multi-step tasks |

### What the Pi Extension Does Better Than Claude Code

1. **Automatic memory capture** — No reliance on LLM choosing to save. Tool results, agent responses, and user messages are automatically extracted and stored.
2. **Intent-mapped recall** — `before_agent_start` maps user intent to MuninnDB recall profiles (causal, confirmatory, adversarial, structural).
3. **SSE push subscription** — Real-time contradiction and high-relevance memory injection into context.
4. **Per-project vault isolation** — Automatic vault derivation from cwd with auto-creation.
5. **Dev/prod dual environment** — Resilient dual-write with environment switching.
6. **Idempotent auto-stores** — sha256 keys prevent duplicate tool result storage.
7. **Confidence gating** — Stricter threshold for user messages (0.6) vs agent responses (0.5).

### What Claude Code Does Better

1. **Simplicity** — One line of config + a system prompt. No extension code to maintain.
2. **Full MCP feature parity** — LLM has direct access to all 39 tools and can use them intelligently based on context.
3. **No extraction latency** — No 30-second Ollama call overhead on every conversation turn.
4. **No false positives** — LLM decides what's worth saving; heuristic/LLM extraction can store noise.
5. **Batch operations** — LLM can call `muninn_remember_batch` directly for efficiency.