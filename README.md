# @kuyavinny/pi-muninn-mem

MuninnDB memory provider extension for [Pi](https://github.com/badlogic/pi-mono).

Connects Pi to [MuninnDB](https://github.com/scrypster/muninndb) for persistent, semantic memory across sessions. Uses an MCP-first architecture — all LLM operations go through MuninnDB's 39 MCP tools, with the extension providing only what MCP cannot: real-time SSE push notifications for contradiction detection.

## What It Does

- **SSE subscription** — Real-time push for contradictions and relevant memory updates (no MCP equivalent)
- **First-turn context injection** — Tells the LLM to call `muninndb_muninn_where_left_off` to restore session context
- **Vault auto-injection** — Automatically fills the `vault` parameter on `muninn_*` MCP tool calls based on the project directory
- **Contradiction alerts** — Formats SSE contradiction events with actionable suggestions (`muninndb_muninn_evolve`, `muninndb_muninn_consolidate`)

## What It Does NOT Do

- **No custom tools** — All 39 MCP tools (`muninn_remember`, `muninn_recall`, `muninn_decide`, etc.) are provided by MuninnDB via `pi-mcp-adapter`
- **No REST calls in request path** — Zero per-turn latency; the LLM calls MCP tools directly
- **No Ollama dependency** — Knowledge extraction is handled by the LLM itself via MCP + AGENTS.md prompting

## Install

```bash
# 1. Install the extension (requires pi-mcp-adapter)
pi install npm:pi-mcp-adapter
pi install npm:@kuyavinny/pi-muninn-mem

# 2. Run setup — installs MuninnDB, configures MCP, AGENTS.md
/muninn-setup
```

`/muninn-setup` handles everything: downloads MuninnDB if not found, starts it, configures MCP, writes AGENTS.md, creates the vault. No separate scripts needed.

If MuninnDB isn't running when the extension loads, you'll see:
```
⚠️ MuninnDB is not running. Run /muninn-setup to install and configure it.
```

### MuninnDB Prerequisites

None — `/muninn-setup` will install MuninnDB automatically. But if you prefer manual install:

```bash
# Option 1: Binary (recommended)
curl -sSL https://github.com/scrypster/muninndb/releases/latest/download/muninn_linux_amd64 -o ~/bin/muninn
chmod +x ~/bin/muninn
muninn init --tool manual --no-token --yes --yes
muninn start

# Option 2: Docker
docker run -d --name muninndb \
  -p 8474:8474 -p 8475:8475 -p 8476:8476 -p 8477:8477 -p 8750:8750 \
  -v muninndb-data:/data \
  ghcr.io/scrypster/muninndb:latest

# Option 3: Podman
podman run -d --name muninndb \
  -p 8474:8474 -p 8475:8475 -p 8476:8476 -p 8477:8477 -p 8750:8750 \
  -v muninndb-data:/data \
  ghcr.io/scrypster/muninndb:latest
```

### Embedding Configuration

MuninnDB includes a **bundled ONNX embedder** (all-MiniLM-L6-v2, 384-dim) that works without any external service. This is the default — no configuration needed.

For better quality, you can optionally configure:

| Provider | Config | Quality |
|----------|--------|---------|
| **Ollama** (recommended) | `MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text` | 768-dim, free, local |
| LM Studio | `MUNINN_OPENAI_URL=http://localhost:1234/v1` | Any model |
| llama.cpp | `MUNINN_OPENAI_URL=http://localhost:8080/v1` | Any model |
| vLLM | `MUNINN_OPENAI_URL=http://localhost:8000/v1` | Any model |
| OpenAI | `MUNINN_OPENAI_KEY=sk-...` | text-embedding-3-small |
| Voyage AI | `MUNINN_VOYAGE_KEY=pa-...` | voyage-3 |

For **enrichment** (summaries, entities, contradiction detection), add:

```bash
# In ~/.muninn/muninn.env
MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b
MUNINN_ENRICH_TIMEOUT=120s
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Extension                         │
│                                                         │
│  session_start  → Start SSE, notify user                │
│  before_agent_start (1st turn) → Inject context        │
│  context        → Push contradictions + relevant writes  │
│  session_shutdown → Clean up SSE                        │
│                                                         │
│  MCP Bridge → Auto-inject vault into muninn_* calls    │
│  /muninn-setup → Interactive setup command              │
└─────────────────────────────────────────────────────────┘
         │                              │
    SSE subscription              MCP tools
    (REST :8475)               (:8750/mcp)
         │                              │
         └──────────┐    ┌──────────────┘
                    ▼    ▼
                 MuninnDB
```

All LLM operations (`remember`, `recall`, `decide`, etc.) go through MCP tools. The extension only provides SSE subscription (which MCP cannot do) and context injection.

## Uninstall

```bash
# From command line
~/.pi/agent/extensions/muninn-mem/muninn-setup.sh --uninstall

# Or manually:
pi uninstall npm:@kuyavinny/pi-muninn-mem
# Then remove from ~/.config/mcp/mcp.json and ~/.pi/agent/AGENTS.md
```

## Configuration

- **MCP config**: `~/.config/mcp/mcp.json` — MuninnDB server URL
- **AGENTS.md**: `~/.pi/agent/AGENTS.md` — LLM instructions (non-destructive, additive)
- **MuninnDB config**: `~/.muninn/muninn.env` — Embedder/enricher settings
- **Extension**: `~/.pi/agent/extensions/muninn-mem/`

## License

MIT