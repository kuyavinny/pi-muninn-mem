# MuninnDB Memory Provider for Pi

Persistent memory provider for the [Pi coding agent](https://github.com/badlogic/pi-mono) using [MuninnDB](https://github.com/scrypster/muninndb) as the backend.

## Overview

This extension gives Pi persistent memory across sessions using three complementary layers:

1. **Automatic lifecycle hooks** — Store and restore memories automatically as you work
2. **Custom Pi tools** — `remember`, `recall`, `decide` for explicit memory operations (LLM-callable)
3. **MCP integration** — All 39 `muninn_*` tools exposed via Pi's native MCP adapter (configured in `mcp.json`)

Per-project vaults provide memory isolation, so memories from one project never leak into another.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                        Pi                            │
│                                                      │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  │
│  │ Custom Tools  │  │ Lifecycle     │  │ Vault     │  │
│  │ remember      │  │ Hooks         │  │ Injection │  │
│  │ recall        │  │ session_start │  │ (tool_call│  │
│  │ decide        │  │ before_agent  │  │  hook)    │  │
│  └──────┬───────┘  │ tool_exec_end │  └─────┬────┘  │
│         │          │ agent_end     │        │        │
│         │          │ SSE push      │        │        │
│         │          └──────┬────────┘        │        │
│         │                 │                 │        │
│  ┌──────▼─────────────────▼─────────────────▼─────┐ │
│  │            MuninnClient (REST API)               │ │
│  │            + SSE Subscription                    │ │
│  └──────────────────────┬──────────────────────────┘ │
│                          │                            │
│  ┌───────────────────────▼──────────────────────────┐ │
│  │    pi-mcp-adapter (via ~/.config/mcp/mcp.json)    │ │
│  │    muninn_recall, muninn_remember, muninn_link,   │ │
│  │    muninn_entities, muninn_decide, ...            │ │
│  └───────────────────────┬──────────────────────────┘ │
└──────────────────────────┼────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────┐
│                    MuninnDB                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │  Vault   │  │  REST API│  │  MCP Server         │  │
│  │(per-     │  │  :8475   │  │  :8750/mcp           │  │
│  │ project) │  │  +SSE    │  │  (JSON-RPC 2.0)     │  │
│  └──────────┘  └──────────┘  └────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐ │
│  │  ACTIVATE Pipeline (6-phase semantic search)     │ │
│  └───────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

**How MCP tools reach Pi:**
- Pi's `pi-mcp-adapter` package reads `~/.config/mcp/mcp.json`
- Discovers the `muninndb` server config with `"url": "http://127.0.0.1:8750/mcp"`
- Registers all 39 `muninn_*` tools as native Pi tools (lazy by default)
- The extension's `tool_call` hook auto-injects the `vault` parameter when omitted

## Installation

### Prerequisites

- [Pi coding agent](https://github.com/badlogic/pi-mono) v0.72+
- `pi-mcp-adapter` package installed (`pi install npm:pi-mcp-adapter`)
- [MuninnDB](https://github.com/scrypster/muninndb) running locally

### Start MuninnDB

Using the CLI:

```bash
muninn start
```

Or using Docker:

```bash
docker run -d -p 8475:8475 -p 8750:8750 scrypster/muninndb
```

Verify it's running:

```bash
curl http://127.0.0.1:8475/api/health
```

### Install the extension

```bash
cd ~/.pi/agent/extensions/muninn-memory
npm install
```

### Configure MCP

Add MuninnDB to `~/.config/mcp/mcp.json`:

```json
{
  "mcpServers": {
    "muninndb": {
      "url": "http://127.0.0.1:8750/mcp",
      "lifecycle": "keep-alive",
      "directTools": true
    }
  }
}
```

Restart Pi (or run `/reload` if it supports extension reloading).

## Configuration

### Extension configuration

The extension uses sensible defaults — no configuration is required.

| Setting | Default | Description |
|---------|---------|-------------|
| `restUrl` | `http://127.0.0.1:8475` | MuninnDB REST API base URL |
| `mcpUrl` | `http://127.0.0.1:8750/mcp` | MuninnDB MCP server URL (used by mcp.json) |
| `apiKey` | (none) | API key for authentication |
| `sseThreshold` | `0.7` | SSE push event score threshold |
| `pushOnWrite` | `true` | Enable push notifications on new writes |

### MCP tools (via pi-mcp-adapter)

All 39 MuninnDB MCP tools are automatically available through Pi's native MCP adapter. The extension adds a `tool_call` hook that injects the per-project `vault` parameter when the LLM omits it, so you get project-scoped memory isolation automatically.

## Features

### Automatic memory (no user intervention)

| Trigger | What happens |
|---------|-------------|
| **Session start** | Restores recent memories from the project's vault; starts SSE subscription for real-time updates |
| **Before agent start** | Injects top 5 relevant memories matching the user's prompt |
| **Tool execution** | Logs tool calls and their results as facts |
| **Agent response** | Records assistant responses as events |
| **SSE push** | Real-time memory updates injected into context |
| **Vault injection** | Auto-injects vault in all `muninn_*` MCP tool calls |

### Explicit memory (on-demand)

| Tool | Description | Parameters |
|------|-------------|------------|
| `remember` | Store a fact, preference, or observation | `concept`, `content`, `memoryType`, `tags` |
| `recall` | Search for relevant memories | `query`, `maxResults`, `mode` |
| `decide` | Record a decision with rationale | `decision`, `rationale`, `alternatives` |

### MCP tools (via pi-mcp-adapter)

All 39 MuninnDB MCP tools are automatically available through Pi's MCP adapter. Key categories:

| Category | Key Tools |
|----------|----------|
| **Memory** | `muninn_remember`, `muninn_remember_batch`, `muninn_recall`, `muninn_read`, `muninn_forget`, `muninn_evolve`, `muninn_consolidate` |
| **Decisions** | `muninn_decide`, `muninn_state`, `muninn_trust` |
| **Links** | `muninn_link`, `muninn_traverse` |
| **Entity Graph** | `muninn_entities`, `muninn_entity`, `muninn_entity_clusters`, `muninn_find_by_entity`, `muninn_entity_state`, `muninn_entity_timeline`, `muninn_similar_entities`, `muninn_merge_entity`, `muninn_export_graph` |
| **Trees** | `muninn_remember_tree`, `muninn_recall_tree`, `muninn_add_child` |
| **Enrichment** | `muninn_retry_enrich`, `muninn_replay_enrichment`, `muninn_get_enrichment_candidates`, `muninn_apply_enrichment` |
| **Meta** | `muninn_status`, `muninn_guide`, `muninn_session`, `muninn_where_left_off`, `muninn_contradictions`, `muninn_explain`, `muninn_provenance`, `muninn_feedback`, `muninn_list_deleted`, `muninn_restore`, `muninn_entity_state_batch` |

### Per-project vaults

Vault names are derived from the project directory basename. Working in `~/projects/my-app` creates/uses vault `my-app`. This keeps memories isolated between projects.

## Error handling

All MuninnDB operations are wrapped in try/catch blocks. If MuninnDB is unavailable:

- **Session start**: Warning notification ("is the server running?")
- **All other hooks**: Silent skip — Pi continues normally
- **Custom tools**: Error message returned as tool output (`isError: true`)
- **MCP tools**: Handled by pi-mcp-adapter (connection error returned as tool output)

This ensures the extension never blocks or crashes Pi.

## Development

### Project structure

```
~/.pi/agent/extensions/muninn-memory/
├── index.ts           # Entry point — wires lifecycle + tools + vault injection
├── package.json       # Package metadata
├── README.md          # This file
└── src/
    ├── vault.ts       # Types, constants, vault resolution
    ├── client.ts      # REST API client (remember, recall, link, read, subscribe)
    ├── extension.ts   # Pi lifecycle hooks (session, context, tool, agent)
    ├── subscribe.ts   # SSE subscription handler
    ├── tools.ts       # Custom Pi tools (remember, recall, decide)
    └── mcp-bridge.ts  # Vault injection hook for muninn_* MCP tool calls
```

### Building

The extension is written in TypeScript and loaded directly by Pi (which handles transpilation). No build step needed.

## Troubleshooting

### "Could not connect to vault" on startup

1. Verify MuninnDB is running: `curl http://127.0.0.1:8475/api/health`
2. Ensure Docker container is running: `docker ps | grep muninndb`
3. If using a non-default port, update `DEFAULT_CONFIG.restUrl` in `src/vault.ts`

### No memories injected

1. The vault is empty for new projects — memories accumulate over time
2. Ensure MuninnDB is accessible at the configured URL
3. Check you're in your project directory (vault name = directory name)

### MCP tools not appearing

1. Verify MuninnDB is running: `curl http://127.0.0.1:8475/api/health`
2. Check the MCP endpoint: `curl -X POST http://127.0.0.1:8750/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`
3. Verify `muninndb` is configured in `~/.config/mcp/mcp.json`
4. Run `/mcp` in Pi to check server connection status
5. Try `/mcp reconnect muninndb` to force tool discovery

### Vault not auto-injected

1. The `tool_call` hook only injects vault for `muninn_*` prefixed tools
2. If you use MCP tools directly (not through the LLM), you may need to specify `vault` manually
3. Check that `muninn-memory` extension is loaded: `pi extensions list`

### Extension not loading

1. Check Pi logs for errors on startup
2. Verify `~/.pi/agent/extensions/muninn-memory/package.json` has valid `pi.extensions` pointing to `./index.ts`
3. Run `npm install` in the extension directory

## License

MIT