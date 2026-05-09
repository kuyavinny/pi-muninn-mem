#!/usr/bin/env bash
# muninn-setup.sh — Interactive setup for MuninnDB + Pi Extension
#
# This script is called by the Pi extension on first load or via /muninn-setup.
# It handles MuninnDB installation, embedding configuration, and MCP setup.
#
# Usage:
#   ./muninn-setup.sh                # Interactive setup
#   ./muninn-setup.sh --check        # Check current status only
#   ./muninn-setup.sh --uninstall    # Remove everything
#
# Design principles:
#   - Never destructive on AGENTS.md (additive only)
#   - Never auto-pull Ollama models (too expensive)
#   - MuninnDB works without Ollama (bundled ONNX embedder)
#   - If Ollama is available, suggest models
#   - Support: Ollama, LM Studio, llama.cpp, vLLM, OpenAI, Voyage
#
set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Paths ──────────────────────────────────────────────────────────
MCP_CONFIG="$HOME/.config/mcp/mcp.json"
AGENTS_MD="$HOME/.pi/agent/AGENTS.md"
EXTENSION_DIR="$HOME/.pi/agent/extensions/muninn-memory"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"
MUNINN_ENV="$HOME/.muninn/muninn.env"

# ─── Check Mode ─────────────────────────────────────────────────────
CHECK_ONLY=false
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)     CHECK_ONLY=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --check      Check status only, don't install"
      echo "  --uninstall  Remove MuninnDB extension and clean up"
      echo "  --help       Show this help"
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ─── Uninstall ──────────────────────────────────────────────────────
if [[ "$UNINSTALL" == true ]]; then
  echo ""
  echo -e "${RED}═══ MuninnDB Pi Extension — Uninstall ═══${NC}"
  echo ""

  # 1. Remove extension
  if [[ -d "$EXTENSION_DIR" ]]; then
    rm -rf "$EXTENSION_DIR"
    ok "Extension directory removed"
  fi

  # 2. Remove from settings.json
  if [[ -f "$SETTINGS_FILE" ]]; then
    python3 -c "
import json
with open('$SETTINGS_FILE', 'r') as f: data = json.load(f)
pkgs = data.get('packages', [])
data['packages'] = [p for p in pkgs if 'muninn-memory' not in p]
with open('$SETTINGS_FILE', 'w') as f: json.dump(data, f, indent=2)
" 2>/dev/null && ok "Removed from settings.json"
  fi

  # 3. Remove MCP config (muninndb entry only)
  if [[ -f "$MCP_CONFIG" ]]; then
    python3 -c "
import json
with open('$MCP_CONFIG', 'r') as f: data = json.load(f)
if 'muninndb' in data.get('mcpServers', {}):
    del data['mcpServers']['muninndb']
    with open('$MCP_CONFIG', 'w') as f: json.dump(data, f, indent=2); f.write('\n')
    print('  Removed muninndb from mcp.json')
" 2>/dev/null
  fi

  # 4. Remove MuninnDB section from AGENTS.md (non-destructive)
  if [[ -f "$AGENTS_MD" ]]; then
    python3 -c "
with open('$AGENTS_MD', 'r') as f: content = f.read()
# Remove MuninnDB section (starts with '# Memory: MuninnDB')
lines = content.split('\n')
output = []
skip = False
for line in lines:
    if line.startswith('# Memory: MuninnDB'):
        skip = True
        continue
    if skip and (line.startswith('# ') or line.startswith('## ')):
        skip = False
        output.append(line)
        continue
    if not skip:
        output.append(line)
result = '\n'.join(output).strip()
if result != content.strip():
    with open('$AGENTS_MD', 'w') as f: f.write(result + '\n')
    print('  Removed MuninnDB section from AGENTS.md')
" 2>/dev/null
    # Remove empty AGENTS.md
    if [[ -s "$AGENTS_MD" ]] && [[ $(wc -c < "$AGENTS_MD") -lt 5 ]]; then
      rm -f "$AGENTS_MD"
      ok "Empty AGENTS.md removed"
    fi
  fi

  echo ""
  read -p "Stop MuninnDB server? [y/N] " -r
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    command -v muninn &>/dev/null && muninn stop 2>/dev/null || true
    ok "MuninnDB stopped"
  fi

  echo ""
  read -p "Delete MuninnDB data (~/.muninn)? This destroys ALL memories! [y/N] " -r
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$HOME/.muninn"
    ok "MuninnDB data removed"
  else
    info "MuninnDB data preserved at ~/.muninn"
  fi

  echo ""
  ok "Uninstall complete. Restart Pi to apply changes."
  exit 0
fi

# ═══ Install ════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}═══ MuninnDB Pi Extension — Setup ═══${NC}"
echo ""

# ─── Step 1: Check MuninnDB ─────────────────────────────────────────
info "Step 1: Checking MuninnDB..."

MUNINN_RUNNING=false
MUNINN_CLI=false
REST_PORT=8475
MCP_PORT=8750

# Check if MuninnDB is already running
if curl -sf http://127.0.0.1:8475/api/health &>/dev/null; then
  MUNINN_RUNNING=true
  ok "MuninnDB is running (CLI, ports 8475/8750)"
elif curl -sf http://127.0.0.1:8575/api/health &>/dev/null; then
  MUNINN_RUNNING=true
  REST_PORT=8575
  MCP_PORT=8850
  ok "MuninnDB is running (Docker, ports 8575/8850)"
fi

# Check if muninn binary exists
if command -v muninn &>/dev/null; then
  MUNINN_CLI=true
  ok "MuninnDB CLI found at $(command -v muninn)"
fi

if [[ "$CHECK_ONLY" == true ]]; then
  echo ""
  if [[ "$MUNINN_RUNNING" == true ]]; then
    ok "MuninnDB: running on REST :${REST_PORT}, MCP :${MCP_PORT}"
  else
    warn "MuninnDB: not running"
  fi
  echo ""
  if command -v ollama &>/dev/null; then
    ok "Ollama: available"
    echo "  Models:"
    ollama list 2>/dev/null | tail -n +2 | while read -r line; do
      echo "    $line"
    done
  else
    warn "Ollama: not found (bundled ONNX embedder will be used)"
  fi
  echo ""
  if [[ -f "$MCP_CONFIG" ]]; then
    python3 -c "
import json
with open('$MCP_CONFIG', 'r') as f: data = json.load(f)
if 'muninndb' in data.get('mcpServers', {}):
    print('  MCP: configured at ' + data['mcpServers']['muninndb']['url'])
else:
    print('  MCP: not configured')
" 2>/dev/null
  else
    echo "  MCP: not configured"
  fi
  echo ""
  if [[ -f "$AGENTS_MD" ]] && grep -q "MuninnDB" "$AGENTS_MD" 2>/dev/null; then
    ok "AGENTS.md: MuninnDB section present"
  else
    warn "AGENTS.md: MuninnDB section not present"
  fi
  echo ""
  if [[ -d "$EXTENSION_DIR" ]]; then
    ok "Extension: installed at $EXTENSION_DIR"
  else
    warn "Extension: not installed"
  fi
  exit 0
fi

if [[ "$MUNINN_RUNNING" == false ]]; then
  if [[ "$MUNINN_CLI" == true ]]; then
    info "Starting MuninnDB..."
    muninn start 2>/dev/null || true
    for i in $(seq 1 10); do
      if curl -sf http://127.0.0.1:8475/api/health &>/dev/null; then
        MUNINN_RUNNING=true
        ok "MuninnDB started"
        break
      fi
      sleep 1
    done
  else
    echo ""
    echo -e "${YELLOW}MuninnDB is not installed or not running.${NC}"
    echo ""
    echo "Install MuninnDB first:"
    echo ""
    echo "  Option 1: Binary (recommended)"
    echo "    curl -sSL https://github.com/scrypster/muninndb/releases/latest/download/muninn_linux_amd64 -o ~/bin/muninn"
    echo "    chmod +x ~/bin/muninn"
    echo "    muninn init --tool manual --no-token --yes --yes"
    echo "    muninn start"
    echo ""
    echo "  Option 2: Docker"
    echo "    docker run -d --name muninndb \\"
    echo "      -p 8474-8477:8474-8477 -p 8750:8750 \\"
    echo "      -v muninndb-data:/data \\"
    echo "      ghcr.io/scrypster/muninndb:latest"
    echo ""
    echo "  Option 3: Podman"
    echo "    podman run -d --name muninndb \\"
    echo "      -p 8474-8477:8474-8477 -p 8750:8750 \\"
    echo "      -v muninndb-data:/data \\"
    echo "      ghcr.io/scrypster/muninndb:latest"
    echo ""
    echo "Then re-run this setup script."
    echo ""
    echo -e "${YELLOW}Note: MuninnDB includes a bundled ONNX embedder that works${NC}"
    echo -e "${YELLOW}without any external service. Semantic search works out of the box.${NC}"
    echo ""
    exit 1
  fi
fi

# ─── Step 2: Embedding Configuration ─────────────────────────────────
info "Step 2: Configuring embedding..."

echo ""
echo -e "${BOLD}MuninnDB uses embeddings for semantic search and memory activation.${NC}"
echo ""
echo "  Default: Bundled ONNX model (all-MiniLM-L6-v2, 384-dim)"
echo "           Works without any external service. No API key needed."
echo "           Good for getting started. 80MB bundled in the binary."
echo ""

if command -v ollama &>/dev/null; then
  echo -e "  ${GREEN}✓ Ollama detected${NC} — better embedding models available:"
  echo "    • nomic-embed-text (768-dim) — better quality, free, local"
  echo "    • qwen3-embedding:0.6b — fast, good quality, free, local"
  echo ""
  OLLAMA_MODELS=$(ollama list 2>/dev/null | tail -n +2 || true)
  if echo "$OLLAMA_MODELS" | grep -q "nomic-embed-text"; then
    echo "    nomic-embed-text: ${GREEN}✓ installed${NC}"
  else
    echo "    nomic-embed-text: (not installed — run: ollama pull nomic-embed-text)"
  fi
  if echo "$OLLAMA_MODELS" | grep -q "qwen3-embedding"; then
    echo "    qwen3-embedding: ${GREEN}✓ installed${NC}"
  else
    echo "    qwen3-embedding: (not installed — run: ollama pull qwen3-embedding:0.6b)"
  fi
  echo ""
  echo -e "  Also available for ${BOLD}enrichment${NC} (summaries, entities, contradiction detection):"
  echo "    • llama3.2:1b — fast enrichment, free, local"
  echo "    • llama3.2:3b — better quality, still fast"
  echo ""
  if echo "$OLLAMA_MODELS" | grep -q "llama3.2:1b"; then
    echo "    llama3.2:1b: ${GREEN}✓ installed${NC}"
  else
    echo "    llama3.2:1b: (not installed — run: ollama pull llama3.2:1b)"
  fi
  if echo "$OLLAMA_MODELS" | grep -q "llama3.2:3b"; then
    echo "    llama3.2:3b: ${GREEN}✓ installed${NC}"
  else
    echo "    llama3.2:3b: (not installed — run: ollama pull llama3.2:3b)"
  fi
  echo ""
  echo "  Other options (manual configuration in ~/.muninn/muninn.env):"
  echo "    • LM Studio — MUNINN_OLLAMA_URL or MUNINN_OPENAI_URL"
  echo "    • llama.cpp — MUNINN_OPENAI_URL=http://localhost:8080/v1"
  echo "    • vLLM — MUNINN_OPENAI_URL=http://localhost:8000/v1"
  echo "    • OpenAI — MUNINN_OPENAI_KEY=sk-..."
  echo "    • Voyage AI — MUNINN_VOYAGE_KEY=pa-..."
fi

# Write muninn.env with Ollama config if available
mkdir -p "$HOME/.muninn"
if [[ -f "$MUNINN_ENV" ]]; then
  info "muninn.env already exists — preserving existing configuration"
else
  cat > "$MUNINN_ENV" << 'ENVEOF'
# MuninnDB Configuration
# ── Embedder (bundled ONNX by default, override with Ollama for better quality) ──
# MUNINN_OLLAMA_URL=ollama://localhost:11434/qwen3-embedding:0.6b

# ── Enricher (optional: LLM summaries, entities, contradiction detection) ──
# MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b
# MUNINN_ENRICH_TIMEOUT=120s
ENVEOF
  ok "Created ~/.muninn/muninn.env (bundled embedder, Ollama commented out)"
fi

# ─── Step 3: Create vault ───────────────────────────────────────────
info "Step 3: Creating vault..."

if command -v muninn &>/dev/null; then
  muninn vault create muninndb --public -u root -p 2>/dev/null || true
  ok "Vault 'muninndb' created (public)"
else
  # Vault will be auto-created on first write
  info "Vault 'muninndb' will be created on first write"
fi

# ─── Step 4: Configure MCP ──────────────────────────────────────────
info "Step 4: Configuring MCP..."

MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"
mkdir -p "$(dirname "$MCP_CONFIG")"

if [[ -f "$MCP_CONFIG" ]]; then
  python3 -c "
import json
with open('$MCP_CONFIG', 'r') as f: data = json.load(f)
if 'mcpServers' not in data: data['mcpServers'] = {}
data['mcpServers']['muninndb'] = {
    'url': '$MCP_URL',
    'lifecycle': 'keep-alive',
    'directTools': True
}
with open('$MCP_CONFIG', 'w') as f: json.dump(data, f, indent=2); f.write('\n')
print('  Updated mcp.json')
" 2>/dev/null || warn "Could not edit mcp.json — add manually:"
  echo "    Add to $MCP_CONFIG:"
  echo '    {"mcpServers":{"muninndb":{"url":"'"$MCP_URL"'","lifecycle":"keep-alive","directTools":true}}}'
else
  cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "muninndb": {
      "url": "$MCP_URL",
      "lifecycle": "keep-alive",
      "directTools": true
    }
  }
}
EOF
  ok "Created $MCP_CONFIG"
fi

ok "MCP configured: $MCP_URL"

# ─── Step 5: Configure AGENTS.md (non-destructive) ──────────────────
info "Step 5: Configuring AGENTS.md..."

AGENTS_SECTION='# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Always

Before beginning any work, call `muninndb_muninn_where_left_off` (via mcp) to load context from the previous session.
This is unconditional — not "if relevant" but "always, before beginning any work."

## During Every Session

- **Save continuously** — this is a mindset, not a checklist.
- Anything the user shares or that emerges from the work should be saved immediately.
- Do not evaluate whether it is "important enough" — when in doubt, save it.
- Do not wait to be asked. If you discover something useful, write it to memory.

### What to Save

- **Decisions**: "We chose X because Y" → `muninndb_muninn_decide`
- **Preferences**: "I prefer tabs over spaces" → `muninndb_muninn_remember` type=preference
- **Issues**: "Service X fails on port 8080" → `muninndb_muninn_remember` type=issue
- **Procedures**: "To deploy, run these steps..." → `muninndb_muninn_remember` type=procedure
- **Facts**: "The API returns 429 on rate limits" → `muninndb_muninn_remember` type=fact
- **Batch saves**: Use `muninndb_muninn_remember_batch` when storing multiple memories at once

### What NOT to Save

- Greetings, acknowledgments, "let me check", "I'll do that"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you're not confident about

## Tools Available

All 39 MuninnDB tools are available via the `mcp` gateway with prefix `muninndb_muninn_*`.
Call them using the `mcp` function, e.g.: `mcp({ tool: "muninndb_muninn_where_left_off", args: "{\"vault\": \"muninndb\"}" })`

| Tool | Purpose |
|------|---------|
| `muninndb_muninn_where_left_off` | Restore context from last session — **call this first** |
| `muninndb_muninn_recall` | Semantic search for relevant memories |
| `muninndb_muninn_remember` | Store a fact, decision, preference, or observation |
| `muninndb_muninn_decide` | Record a decision with rationale and evidence |
| `muninndb_muninn_remember_batch` | Store multiple memories at once (max 50) |
| `muninndb_muninn_evolve` | Update a memory with new information |
| `muninndb_muninn_consolidate` | Merge related memories |
| `muninndb_muninn_contradictions` | Check for known contradictions |
| `muninndb_muninn_guide` | Get vault-specific usage instructions |

## Vault Strategy

Each project gets its own vault (derived from the directory basename). The vault is injected automatically — you don'\''t need to specify it.

## Contradiction Detection

When you see a `[⚠️ Contradiction detected]` message, use `muninndb_muninn_evolve` to update the older memory or `muninndb_muninn_consolidate` to merge them.'

if [[ -f "$AGENTS_MD" ]]; then
  if grep -q "# Memory: MuninnDB" "$AGENTS_MD" 2>/dev/null; then
    # Update existing section (replace only MuninnDB section)
    python3 -c "
with open('$AGENTS_MD', 'r') as f:
    content = f.read()
lines = content.split('\n')
output = []
skip = False
for line in lines:
    if line.startswith('# Memory: MuninnDB'):
        skip = True
        continue
    if skip and (line.startswith('# ') or line.startswith('## ')):
        skip = False
        output.append(line)
        continue
    if not skip:
        output.append(line)
result = '\n'.join(output).strip()
result = result + '\n\n' + '''$AGENTS_SECTION''' + '\n'
with open('$AGENTS_MD', 'w') as f:
    f.write(result)
print('  Updated MuninnDB section in AGENTS.md')
" 2>/dev/null || warn "Could not update AGENTS.md"
  else
    # Append (non-destructive)
    echo "" >> "$AGENTS_MD"
    echo "$AGENTS_SECTION" >> "$AGENTS_MD"
    ok "Added MuninnDB section to AGENTS.md"
  fi
else
  echo "$AGENTS_SECTION" > "$AGENTS_MD"
  ok "Created AGENTS.md with MuninnDB instructions"
fi

# ─── Step 6: Verify ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══ Setup Summary ═══${NC}"
echo ""

if curl -sf "http://127.0.0.1:${REST_PORT}/api/health" &>/dev/null; then
  ok "MuninnDB: REST :${REST_PORT}, MCP :${MCP_PORT}"
else
  err "MuninnDB: not responding on :${REST_PORT}"
fi

if command -v ollama &>/dev/null; then
  ok "Ollama: available (see ~/.muninn/muninn.env for configuration)"
else
  info "Ollama: not found (bundled ONNX embedder will be used)"
fi

ok "MCP config: $MCP_CONFIG"
ok "AGENTS.md: $AGENTS_MD"

echo ""
echo -e "${BOLD}Embedding configuration:${NC}"
if [[ -f "$MUNINN_ENV" ]] && grep -q "MUNINN_OLLAMA_URL=.*ollama" "$MUNINN_ENV" 2>/dev/null && ! grep -q "^#" "$MUNINN_ENV" 2>/dev/null | grep -q "MUNINN_OLLAMA_URL"; then
  ok "Using Ollama embedding (see ~/.muninn/muninn.env)"
else
  info "Using bundled ONNX embedder (all-MiniLM-L6-v2, 384-dim)"
  echo "  To upgrade: uncomment MUNINN_OLLAMA_URL in ~/.muninn/muninn.env"
  echo "  Recommended: ollama pull nomic-embed-text"
fi

echo ""
echo -e "${GREEN}═══ Next Steps ═══${NC}"
echo ""
echo "1. Restart Pi to load the extension"
echo "2. The first turn will show: 'MuninnDB memory is connected'"
echo "3. Call muninndb_muninn_where_left_off to restore context"
echo ""
echo "To enable better embedding (optional):"
echo "  ollama pull nomic-embed-text        # Better embeddings"
echo "  # Then uncomment MUNINN_OLLAMA_URL in ~/.muninn/muninn.env"
echo "  # And restart: muninn restart"
echo ""
echo "To enable enrichment (optional):"
echo "  ollama pull llama3.2:1b             # Summaries, entities, contradictions"
echo "  # Then uncomment MUNINN_ENRICH_URL in ~/.muninn/muninn.env"
echo "  # And restart: muninn restart"
echo ""