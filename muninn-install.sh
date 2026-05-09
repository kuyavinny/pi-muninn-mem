#!/usr/bin/env bash
# muninn-install.sh — Install MuninnDB + Pi Extension
#
# Usage:
#   ./muninn-install.sh              # CLI install (default)
#   ./muninn-install.sh --docker     # Docker/Podman install
#   ./muninn-install.sh --podman     # Podman install
#   ./muninn-install.sh --uninstall  # Uninstall everything
#   ./muninn-install.sh --help       # Show help
#
# This script:
#   1. Installs MuninnDB (binary or container)
#   2. Configures Ollama embedding/enrichment
#   3. Installs the Pi extension
#   4. Configures MCP (writes mcp.json)
#   5. Sets up AGENTS.md (non-destructive, additive)
#   6. Verifies everything works
#
set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Defaults ──────────────────────────────────────────────────────
INSTALL_METHOD="cli"
MUNINN_VERSION="0.5.1"
MCP_CONFIG="$HOME/.config/mcp/mcp.json"
AGENTS_MD="$HOME/.pi/agent/AGENTS.md"
EXTENSION_DIR="$HOME/.pi/agent/extensions/muninn-memory"
MUNINN_DATA_DIR="$HOME/.muninn/data"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"

# Ports (CLI defaults)
REST_PORT=8475
MCP_PORT=8750
WEB_PORT=8476

# Ports (Docker offset)
DOCKER_REST_PORT=8575
DOCKER_MCP_PORT=8850
DOCKER_WEB_PORT=8576

# ─── Parse Arguments ───────────────────────────────────────────────
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)    INSTALL_METHOD="docker"; shift ;;
    --podman)   INSTALL_METHOD="podman"; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --docker     Install MuninnDB via Docker (offset ports: 8575/8850)"
      echo "  --podman     Install MuninnDB via Podman (offset ports: 8575/8850)"
      echo "  --uninstall  Remove MuninnDB extension and clean up"
      echo "  --help       Show this help message"
      echo ""
      echo "Default: CLI binary install on default ports (8475/8750)"
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ─── Uninstall ──────────────────────────────────────────────────────
if [[ "$UNINSTALL" == true ]]; then
  echo ""
  echo -e "${RED}═══ MuninnDB Pi Extension — Uninstall ═══${NC}"
  echo ""

  # 1. Remove Pi extension
  if [[ -d "$EXTENSION_DIR" ]]; then
    info "Removing Pi extension..."
    rm -rf "$EXTENSION_DIR"
    ok "Extension directory removed"
  else
    warn "Extension directory not found at $EXTENSION_DIR"
  fi

  # 2. Remove from settings.json
  if [[ -f "$SETTINGS_FILE" ]]; then
    info "Removing extension from Pi settings..."
    # Use python to safely edit JSON
    python3 -c "
import json, sys
with open('$SETTINGS_FILE', 'r') as f:
    data = json.load(f)
pkgs = data.get('packages', [])
original = len(pkgs)
data['packages'] = [p for p in pkgs if 'muninn-memory' not in p]
if len(data['packages']) < original:
    with open('$SETTINGS_FILE', 'w') as f:
        json.dump(data, f, indent=2)
    print('  Removed from settings.json')
else:
    print('  Not found in settings.json')
" 2>/dev/null || warn "Could not edit settings.json"
  fi

  # 3. Remove MCP config
  if [[ -f "$MCP_CONFIG" ]]; then
    info "Removing MuninnDB from MCP config..."
    python3 -c "
import json
with open('$MCP_CONFIG', 'r') as f:
    data = json.load(f)
if 'muninndb' in data.get('mcpServers', {}):
    del data['mcpServers']['muninndb']
    with open('$MCP_CONFIG', 'w') as f:
        json.dump(data, f, indent=2)
    print('  Removed muninndb from mcp.json')
else:
    print('  muninndb not found in mcp.json')
" 2>/dev/null || warn "Could not edit mcp.json"
  fi

  # 4. Remove AGENTS.md MuninnDB section (non-destructive)
  if [[ -f "$AGENTS_MD" ]]; then
    info "Removing MuninnDB section from AGENTS.md (preserving other content)..."
    python3 -c "
with open('$AGENTS_MD', 'r') as f:
    content = f.read()

# Find and remove the MuninnDB section (starts with '# Memory: MuninnDB' or '## Memory: MuninnDB')
lines = content.split('\n')
output = []
skip = False
for line in lines:
    if line.startswith('# Memory: MuninnDB') or line.startswith('## Memory: MuninnDB'):
        skip = True
        continue
    if skip and (line.startswith('# ') or line.startswith('## ') or line.strip() == ''):
        if line.startswith('# ') or line.startswith('## '):
            skip = False
            output.append(line)
        continue
    if not skip:
        output.append(line)

result = '\n'.join(output).strip()
if result != content.strip():
    with open('$AGENTS_MD', 'w') as f:
        f.write(result + '\n')
    print('  Removed MuninnDB section from AGENTS.md')
else:
    print('  No MuninnDB section found in AGENTS.md')
" 2>/dev/null || warn "Could not edit AGENTS.md"

    # Remove AGENTS.md if it's now empty
    if [[ ! -s "$AGENTS_MD" ]] || [[ $(wc -c < "$AGENTS_MD") -lt 5 ]]; then
      info "AGENTS.md is now empty, removing..."
      rm -f "$AGENTS_MD"
      ok "Empty AGENTS.md removed"
    fi
  fi

  # 5. Ask about MuninnDB data
  echo ""
  read -p "Stop MuninnDB server? [y/N] " -r
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if command -v muninn &>/dev/null; then
      muninn stop 2>/dev/null || true
      ok "MuninnDB stopped"
    elif [[ "$INSTALL_METHOD" == "docker" ]] && command -v docker &>/dev/null; then
      docker stop muninndb-prod 2>/dev/null || true
      ok "MuninnDB container stopped"
    elif [[ "$INSTALL_METHOD" == "podman" ]] && command -v podman &>/dev/null; then
      podman stop muninndb-prod 2>/dev/null || true
      ok "MuninnDB container stopped"
    fi
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

# ─── Install ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══ MuninnDB Pi Extension — Install ═══${NC}"
echo ""

# ─── Step 0: Check prerequisites ─────────────────────────────────────
info "Checking prerequisites..."

if ! command -v pi &>/dev/null; then
  err "Pi not found. Install pi-coding-agent first."
  exit 1
fi
ok "Pi found"

if ! command -v ollama &>/dev/null; then
  warn "Ollama not found. MuninnDB requires Ollama for embedding."
  echo "  Install Ollama: curl -fsSL https://ollama.com/install | sh"
fi

# ─── Step 1: Install MuninnDB ────────────────────────────────────────
if [[ "$INSTALL_METHOD" == "cli" ]]; then
  info "Installing MuninnDB CLI binary..."
  
  if command -v muninn &>/dev/null; then
    ok "MuninnDB binary already installed at $(command -v muninn)"
  else
    # Detect platform
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  MUNINN_ARCH="amd64" ;;
      aarch64) MUNINN_ARCH="arm64" ;;
      *)       err "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    
    MUNINN_URL="https://github.com/scrypster/muninndb/releases/download/v${MUNINN_VERSION}/muninn-linux-${MUNINN_ARCH}"
    
    info "Downloading MuninnDB v${MUNINN_VERSION} for ${MUNINN_ARCH}..."
    mkdir -p "$HOME/bin"
    curl -fSL "$MUNINN_URL" -o "$HOME/bin/muninn"
    chmod +x "$HOME/bin/muninn"
    
    # Add to PATH if needed
    if [[ ":$PATH:" != *":$HOME/bin:"* ]]; then
      info "Adding $HOME/bin to PATH..."
      echo 'export PATH="$HOME/bin:$PATH"' >> "$HOME/.bashrc"
      export PATH="$HOME/bin:$PATH"
    fi
    
    ok "MuninnDB installed to $HOME/bin/muninn"
  fi

  # Initialize and start
  info "Initializing MuninnDB..."
  muninn init --tool manual --no-token --yes --yes 2>/dev/null || true
  
  info "Starting MuninnDB..."
  muninn start 2>/dev/null || true
  
  # Wait for health
  for i in $(seq 1 10); do
    if curl -sf "http://127.0.0.1:${REST_PORT}/api/health" &>/dev/null; then
      ok "MuninnDB is running on REST :${REST_PORT}, MCP :${MCP_PORT}"
      break
    fi
    sleep 1
  done

elif [[ "$INSTALL_METHOD" == "docker" || "$INSTALL_METHOD" == "podman" ]]; then
  RUNTIME="$INSTALL_METHOD"
  
  if ! command -v "$RUNTIME" &>/dev/null; then
    err "$RUNTIME not found. Install $RUNTIME first."
    exit 1
  fi
  ok "$RUNTIME found"
  
  info "Pulling MuninnDB container..."
  $RUNTIME pull ghcr.io/scrypster/muninndb:latest 2>/dev/null || true
  
  info "Creating MuninnDB container..."
  $RUNTIME run -d \
    --name muninndb-prod \
    -p 8574:8474 \
    -p "${DOCKER_REST_PORT}:8475" \
    -p "${DOCKER_WEB_PORT}:8476" \
    -p 8577:8477 \
    -p "${DOCKER_MCP_PORT}:8750" \
    -e MUNINN_LISTEN_HOST="0.0.0.0" \
    -e MUNINN_MEM_LIMIT_GB="4" \
    -e MUNINN_LOCAL_EMBED="0" \
    -v muninndb-prod-data:/data \
    --add-host host.docker.internal:host-gateway \
    --health-cmd "curl -sf http://localhost:8750/mcp/health" \
    --health-interval 15s \
    --health-timeout 5s \
    --health-retries 5 \
    --cpus 2 \
    --memory 4g \
    ghcr.io/scrypster/muninndb:latest 2>/dev/null || true
  
  # Override ports for MCP config
  REST_PORT="$DOCKER_REST_PORT"
  MCP_PORT="$DOCKER_MCP_PORT"
  WEB_PORT="$DOCKER_WEB_PORT"
  
  # Wait for health
  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${REST_PORT}/api/health" &>/dev/null; then
      ok "MuninnDB container is running on REST :${REST_PORT}, MCP :${MCP_PORT}"
      break
    fi
    sleep 2
  done
fi

# ─── Step 2: Configure Ollama models ────────────────────────────────
info "Configuring Ollama models..."

# Pull embedding model
if command -v ollama &>/dev/null; then
  ollama pull qwen3-embedding:0.6b 2>/dev/null || warn "Could not pull qwen3-embedding:0.6b"
  ollama pull llama3.2:1b 2>/dev/null || warn "Could not pull llama3.2:1b"
  ok "Ollama models ready"
fi

# Write muninn.env
mkdir -p "$HOME/.muninn"
cat > "$HOME/.muninn/muninn.env" << 'ENVEOF'
# MuninnDB Configuration
# ── Embedder (Ollama local) ──
MUNINN_OLLAMA_URL=ollama://localhost:11434/qwen3-embedding:0.6b

# ── Enricher (Ollama local) ──
MUNINN_ENRICH_URL=ollama://localhost:11434/llama3.2:1b
MUNINN_ENRICH_TIMEOUT=120s
ENVEOF

# Docker/Podman needs host.docker.internal for Ollama
if [[ "$INSTALL_METHOD" == "docker" || "$INSTALL_METHOD" == "podman" ]]; then
  cat >> "$HOME/.muninn/muninn.env" << 'ENVEOF'

# ── Docker/Podman: use host.docker.internal for Ollama ──
MUNINN_OLLAMA_URL=ollama://host.docker.internal:11434/qwen3-embedding:0.6b
MUNINN_ENRICH_URL=ollama://host.docker.internal:11434/llama3.2:1b
ENVEOF
fi

ok "MuninnDB config written to ~/.muninn/muninn.env"

# Restart to pick up config
if [[ "$INSTALL_METHOD" == "cli" ]]; then
  muninn restart 2>/dev/null || true
fi

# ─── Step 3: Create vault ────────────────────────────────────────────
info "Creating 'muninndb' vault..."
if command -v muninn &>/dev/null; then
  muninn vault create muninndb --public -u root -p 2>/dev/null || true
  ok "Vault 'muninndb' created (public)"
else
  warn "muninn binary not found — create vault manually: muninn vault create muninndb --public -u root -p"
fi

# ─── Step 4: Install Pi extension ────────────────────────────────────
info "Installing Pi extension..."

if [[ -d "$EXTENSION_DIR" ]]; then
  warn "Extension directory already exists at $EXTENSION_DIR"
  read -p "Update existing extension? [Y/n] " -r
  if [[ $REPLY =~ ^[Nn]$ ]]; then
    info "Skipping extension update"
  else
    # Copy source files from this script's directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$SCRIPT_DIR/index.ts" ]]; then
      cp -r "$SCRIPT_DIR/src" "$EXTENSION_DIR/"
      cp "$SCRIPT_DIR/index.ts" "$EXTENSION_DIR/"
      cp "$SCRIPT_DIR/package.json" "$EXTENSION_DIR/"
      cp "$SCRIPT_DIR/tsconfig.json" "$EXTENSION_DIR/" 2>/dev/null || true
      ok "Extension files updated"
    else
      warn "Source files not found in $SCRIPT_DIR — skipping update"
    fi
  fi
else
  mkdir -p "$EXTENSION_DIR"
  
  # Copy source files from this script's directory
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cp -r "$SCRIPT_DIR/src" "$EXTENSION_DIR/"
  cp "$SCRIPT_DIR/index.ts" "$EXTENSION_DIR/"
  cp "$SCRIPT_DIR/package.json" "$EXTENSION_DIR/"
  cp "$SCRIPT_DIR/tsconfig.json" "$EXTENSION_DIR/" 2>/dev/null || true
  
  # Install dependencies
  cd "$EXTENSION_DIR" && npm install 2>/dev/null || true
  
  ok "Extension installed to $EXTENSION_DIR"
fi

# Add to Pi settings if not already there
if [[ -f "$SETTINGS_FILE" ]]; then
  python3 -c "
import json
with open('$SETTINGS_FILE', 'r') as f:
    data = json.load(f)
pkgs = data.get('packages', [])
if 'extensions/muninn-memory' not in pkgs:
    pkgs.append('extensions/muninn-memory')
    data['packages'] = pkgs
    with open('$SETTINGS_FILE', 'w') as f:
        json.dump(data, f, indent=2)
    print('  Added to Pi settings')
else:
    print('  Already in Pi settings')
" 2>/dev/null || warn "Could not edit Pi settings"
fi

# ─── Step 5: Configure MCP ───────────────────────────────────────────
info "Configuring MCP..."

mkdir -p "$(dirname "$MCP_CONFIG")"

MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"

if [[ -f "$MCP_CONFIG" ]]; then
  # Merge muninndb entry into existing config
  python3 -c "
import json
with open('$MCP_CONFIG', 'r') as f:
    data = json.load(f)

if 'mcpServers' not in data:
    data['mcpServers'] = {}

data['mcpServers']['muninndb'] = {
    'url': '$MCP_URL',
    'lifecycle': 'keep-alive',
    'directTools': True
}

with open('$MCP_CONFIG', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')

print('  Updated mcp.json')
" 2>/dev/null || warn "Could not edit mcp.json"
else
  # Create new config
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

# ─── Step 6: Set up AGENTS.md (non-destructive, additive) ───────────
info "Configuring AGENTS.md..."

AGENTS_SECTION="# Memory: MuninnDB

You have persistent memory via MuninnDB. Use it actively — never rely on local or session-only memory.

## Session Start — Always

Before beginning any work, call \`muninndb_muninn_where_left_off\` (via mcp) to load context from the previous session.
This is unconditional — not \"if relevant\" but \"always, before beginning any work.\"

## During Every Session

- **Save continuously** — this is a mindset, not a checklist.
- Anything the user shares or that emerges from the work should be saved immediately.
- Do not evaluate whether it is \"important enough\" — when in doubt, save it.
- Do not wait to be asked. If you discover something useful, write it to memory.

### What to Save

- **Decisions**: \"We chose X because Y\" → \`muninndb_muninn_decide\`
- **Preferences**: \"I prefer tabs over spaces\" → \`muninndb_muninn_remember\` type=preference
- **Issues**: \"Service X fails on port 8080\" → \`muninndb_muninn_remember\` type=issue
- **Procedures**: \"To deploy, run these steps...\" → \`muninndb_muninn_remember\` type=procedure
- **Facts**: \"The API returns 429 on rate limits\" → \`muninndb_muninn_remember\` type=fact
- **Batch saves**: Use \`muninndb_muninn_remember_batch\` when storing multiple memories at once

### What NOT to Save

- Greetings, acknowledgments, \"let me check\", \"I'll do that\"
- Raw tool output (bash, read, edit, write)
- Meta-discussion about the conversation itself
- Information you're not confident about

## Tools Available

All 39 MuninnDB tools are available via the \`mcp\` gateway with prefix \`muninndb_muninn_*\`.
Call them using the \`mcp\` function, e.g.: \`mcp({ tool: \"muninndb_muninn_where_left_off\", args: \"{\\\"vault\\\": \\\"muninndb\\\"}\" })\`

| Tool | Purpose |
|------|---------|
| \`muninndb_muninn_where_left_off\` | Restore context from last session — **call this first** |
| \`muninndb_muninn_recall\` | Semantic search for relevant memories |
| \`muninndb_muninn_remember\` | Store a fact, decision, preference, or observation |
| \`muninndb_muninn_decide\` | Record a decision with rationale and evidence |
| \`muninndb_muninn_remember_batch\` | Store multiple memories at once (max 50) |
| \`muninndb_muninn_evolve\` | Update a memory with new information |
| \`muninndb_muninn_consolidate\` | Merge related memories |
| \`muninndb_muninn_contradictions\` | Check for known contradictions |
| \`muninndb_muninn_guide\` | Get vault-specific usage instructions |

## Vault Strategy

Each project gets its own vault (derived from the directory basename). The vault is injected automatically — you don't need to specify it.

## Contradiction Detection

When you see a \`[⚠️ Contradiction detected]\` message, use \`muninndb_muninn_evolve\` to update the older memory or \`muninndb_muninn_consolidate\` to merge them."

if [[ -f "$AGENTS_MD" ]]; then
  # Check if MuninnDB section already exists
  if grep -q "# Memory: MuninnDB" "$AGENTS_MD" 2>/dev/null; then
    info "MuninnDB section already in AGENTS.md — updating..."
    # Remove old section and add new one
    python3 -c "
with open('$AGENTS_MD', 'r') as f:
    content = f.read()

# Remove old MuninnDB section
lines = content.split('\n')
output = []
skip = False
for line in lines:
    if line.startswith('# Memory: MuninnDB'):
        skip = True
        continue
    if skip and (line.startswith('# ') or line.startswith('## ')):
        skip = False
    if not skip:
        output.append(line)

result = '\n'.join(output).strip()
# Append new section
result = result + '\n\n' + '''$AGENTS_SECTION''' + '\n'

with open('$AGENTS_MD', 'w') as f:
    f.write(result)
print('  Updated MuninnDB section in AGENTS.md')
" 2>/dev/null || warn "Could not update AGENTS.md"
  else
    # Append new section (non-destructive)
    echo "" >> "$AGENTS_MD"
    echo "$AGENTS_SECTION" >> "$AGENTS_MD"
    ok "Added MuninnDB section to AGENTS.md"
  fi
else
  # Create new AGENTS.md
  echo "$AGENTS_SECTION" > "$AGENTS_MD"
  ok "Created AGENTS.md with MuninnDB instructions"
fi

# ─── Step 7: Verify ──────────────────────────────────────────────────
info "Verifying installation..."

echo ""
echo -e "${GREEN}═══ Installation Summary ═══${NC}"
echo ""

# Check MuninnDB health
if curl -sf "http://127.0.0.1:${REST_PORT}/api/health" &>/dev/null; then
  HEALTH=$(curl -sf "http://127.0.0.1:${REST_PORT}/api/health" 2>/dev/null)
  ok "MuninnDB REST API: http://127.0.0.1:${REST_PORT}"
else
  err "MuninnDB REST API not responding on :${REST_PORT}"
fi

# Check MCP
if curl -sf "http://127.0.0.1:${MCP_PORT}/mcp" -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' &>/dev/null; then
  ok "MuninnDB MCP: http://127.0.0.1:${MCP_PORT}/mcp"
else
  warn "MuninnDB MCP not responding — may need restart"
fi

# Check Ollama
if curl -sf http://localhost:11434/api/tags &>/dev/null; then
  ok "Ollama running"
else
  warn "Ollama not responding — start with: ollama serve"
fi

# Check extension
if [[ -f "$EXTENSION_DIR/index.ts" ]]; then
  ok "Pi extension installed: $EXTENSION_DIR"
else
  err "Pi extension not found at $EXTENSION_DIR"
fi

# Check AGENTS.md
if [[ -f "$AGENTS_MD" ]]; then
  ok "AGENTS.md configured: $AGENTS_MD"
else
  warn "AGENTS.md not found"
fi

# Check MCP config
if [[ -f "$MCP_CONFIG" ]]; then
  ok "MCP config: $MCP_CONFIG"
else
  warn "MCP config not found"
fi

echo ""
echo -e "${GREEN}═══ Next Steps ═══${NC}"
echo ""
echo "1. Restart Pi to load the extension:"
echo "   pi"
echo ""
echo "2. The first turn will show:"
echo "   'MuninnDB memory is connected (vault: \"muninndb\").'"
echo "   'Call muninndb_muninn_where_left_off to restore context.'"
echo ""
echo "3. To verify MCP tools:"
echo "   mcp({ tool: \"muninndb_muninn_status\", args: \"{\\\"vault\\\": \\\"muninndb\\\"}\" })"
echo ""
echo "4. To uninstall:"
echo "   ./muninn-install.sh --uninstall"
echo ""