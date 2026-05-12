# @kuyavinny/pi-muninn-mem

Persistent memory for [Pi](https://pi.dev) via [MuninnDB](https://github.com/scrypster/muninndb).

Gives Pi semantic memory across sessions — decisions, preferences, facts, procedures — that survives restarts. Uses an MCP-first architecture: all 39 MuninnDB tools are exposed through `pi-mcp-adapter`, and the extension provides only what MCP cannot (SSE push, context injection, setup automation).

## Install

```bash
pi install npm:pi-mcp-adapter        # required dependency
pi install npm:@kuyavinny/pi-muninn-mem
```

Then reload Pi and run:

```
/muninn-setup
```

This single command handles everything:

1. Checks that `pi-mcp-adapter` is installed
2. Downloads and installs MuninnDB binary (with SHA-256 verification) if not found
3. Starts MuninnDB
4. Writes MCP config to `~/.config/mcp/mcp.json`
5. Adds MuninnDB instructions to `~/.pi/agent/AGENTS.md` (non-destructive)
6. Verifies the setup

If MuninnDB isn't running when Pi starts, you'll see:

```
⚠️ MuninnDB is not running. Run /muninn-setup to install and configure it.
```

## How It Works

### Extension (what this package provides)

| Hook                          | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `session_start`               | Health-check MuninnDB, start SSE subscription, notify user       |
| `before_agent_start`          | On first turn: tell LLM to call `muninndb_muninn_where_left_off` |
| `context`                     | Push contradiction alerts and relevant memory updates via SSE    |
| `session_shutdown`            | Clean up SSE connection                                          |
| `/muninn-setup`               | Install MuninnDB, configure MCP + AGENTS.md                      |
| `/muninn-remove`              | Unregister extension, remove MCP config, clean AGENTS.md         |
| `/muninn-vault status`        | Show current vault and mapping                                   |
| `/muninn-vault create [name]` | Link current directory to a vault                                |
| `/muninn-vault unlink`        | Remove vault mapping for current directory                       |
| `/muninn-dream`               | Run dream protocol: consolidate, evolve, enrich memories         |
| `tool_call`                   | Auto-inject `vault` parameter into MuninnDB MCP tool calls       |

### MCP tools (provided by MuninnDB via pi-mcp-adapter)

The LLM calls these directly through the `mcp` gateway:

| Tool                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `muninndb_muninn_where_left_off` | Restore context from last session — **call this first** |
| `muninndb_muninn_recall`         | Semantic search for relevant memories                   |
| `muninndb_muninn_remember`       | Store a fact, decision, preference, or observation      |
| `muninndb_muninn_decide`         | Record a decision with rationale and evidence           |
| `muninndb_muninn_remember_batch` | Store multiple memories at once (max 50)                |
| `muninndb_muninn_evolve`         | Update a memory with new information                    |
| `muninndb_muninn_consolidate`    | Merge related memories                                  |
| `muninndb_muninn_contradictions` | Check for known contradictions                          |
| `muninndb_muninn_guide`          | Get vault-specific usage instructions                   |

Plus 30 more — see `muninndb_muninn_guide` for the full list.

### Architecture

```
┌──────────────────────────────────────────────┐
│              Pi Extension                    │
│                                              │
│  session_start  → Health check, start SSE   │
│  before_agent_start (1st turn) → Inject     │
│  context        → Push contradictions       │
│  session_shutdown → Clean up SSE            │
│  tool_call      → Auto-inject vault param   │
│  /muninn-setup  → Install + configure        │
│  /muninn-remove → Uninstall                  │
└──────────────┬───────────────────┬───────────┘
               │                   │
          SSE subscription     MCP tools
          (REST :8475)      (:8750/mcp)
               │                   │
               └───────┬───────────┘
                       ▼
                    MuninnDB
```

All LLM operations go through MCP. The extension only provides SSE subscription (which MCP cannot do), context injection, and setup automation.

## Embedding Configuration

MuninnDB ships with a **bundled ONNX embedder** (all-MiniLM-L6-v2, 384-dim) that works offline with zero configuration. This is the default.

For better embeddings, edit `~/.muninn/muninn.env` and restart MuninnDB:

| Provider                 | Config                                                        | Quality                |
| ------------------------ | ------------------------------------------------------------- | ---------------------- |
| **Ollama** (recommended) | `MUNINN_OLLAMA_URL=ollama://localhost:11434/nomic-embed-text` | 768-dim, free, local   |
| LM Studio                | `MUNINN_OPENAI_URL=http://localhost:1234/v1`                  | Any model              |
| OpenAI                   | `MUNINN_OPENAI_KEY=sk-...`                                    | text-embedding-3-small |
| Voyage AI                | `MUNINN_VOYAGE_KEY=pa-...`                                    | voyage-3               |

For **enrichment** (summaries, entities, contradiction detection):

```bash
MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b
MUNINN_ENRICH_TIMEOUT=120s
```

Models are never auto-pulled — you must install them explicitly.

## Security

- Downloaded binaries are verified with SHA-256 checksums before execution
- Docker/Podman ports bound to `127.0.0.1` only (no network exposure)
- Docker image pinned to `v0.5.1` (no `:latest`)
- MuninnDB initialized with a generated authentication token
- MCP config URLs validated as localhost-only with known ports
- File writes are atomic (temp + rename)
- All command execution uses argument arrays (no shell interpolation)
- SSE reconnection uses exponential backoff (5s → 5min cap)
- Tool calls validated against an allowlist of 18 known MuninnDB tools
- Vault names sanitized and length-limited (64 chars)

## Uninstall

```
/muninn-remove
```

This removes the MCP config, AGENTS.md section, and Pi extension registration. MuninnDB data (`~/.muninn/`) is preserved — delete it manually if desired.

## Manual MuninnDB Install

If you prefer not to use `/muninn-setup`, you can install MuninnDB manually:

```bash
# Binary (Linux/macOS/Windows, amd64/arm64)
curl -sSL https://github.com/scrypster/muninndb/releases/latest/download/muninn-linux-amd64 -o ~/bin/muninn
chmod +x ~/bin/muninn
muninn init --tool manual --token YOUR_TOKEN --yes --yes
muninn start

# Docker (localhost only)
docker run -d --name muninndb \
  -p 127.0.0.1:8474:8474 -p 127.0.0.1:8475:8475 \
  -p 127.0.0.1:8476:8476 -p 127.0.0.1:8477:8477 \
  -p 127.0.0.1:8750:8750 \
  -v muninndb-data:/data \
  ghcr.io/scrypster/muninndb:v0.5.1
```

## Configuration Files

| File                     | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `~/.config/mcp/mcp.json` | MCP server URL for MuninnDB                     |
| `~/.pi/agent/AGENTS.md`  | LLM instructions for MuninnDB (non-destructive) |
| `~/.muninn/muninn.env`   | MuninnDB embedder/enricher settings             |
| `~/.muninn/data/`        | MuninnDB data (Pebble DB)                       |

## License

MIT
