import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { client } from "./shared-client";
import { resolveVaultName, ActivationPush } from "./vault";
import { startSSESubscription } from "./subscribe";

/**
 * Check if MuninnDB REST API is reachable.
 * Returns true if healthy, false if down.
 */
async function checkMuninnHealth(muninnClient: any): Promise<boolean> {
  try {
    const url = (muninnClient as any).config?.restUrl ?? "http://127.0.0.1:8475";
    const res = await fetch(`${url}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Registers Pi lifecycle hooks for MuninnDB memory integration.
 *
 * This extension takes a minimal, MCP-first approach:
 * - SSE subscription for real-time push (contradictions + relevant memories)
 * - First-turn context injection telling the LLM to call muninn_where_left_off
 * - All other operations (remember, recall, decide, etc.) go through MCP tools
 *
 * The LLM is guided by AGENTS.md to save continuously and recall at session start.
 */
export default function registerLifecycleHooks(pi: ExtensionAPI) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;
  let isFirstTurn = true;
  let muninnUp = false; // Set by session_start health check

  // ─── session_start: Start SSE subscription + notify user ───
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;

    // Check if MuninnDB is reachable
    const healthResult = await checkMuninnHealth(client);
    muninnUp = healthResult;

    if (!muninnUp) {
      ctx.ui.notify(
        "MuninnDB is not running. Run /muninn-setup to install and configure it.",
        "warning",
      );
      return; // Don't start SSE if MuninnDB is down
    }

    ctx.ui.notify(`MuninnDB: vault "${currentVault}"`, "info");

    // Start SSE subscription for real-time push events
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
  //
  // session_start cannot inject messages (it's side-effect only).
  // before_agent_start can inject messages but fires on every turn.
  // We use isFirstTurn to only inject the session-start instruction once.
  //
  // The LLM will call muninn_where_left_off via MCP, which restores
  // context from the previous session. On subsequent turns, the LLM
  // relies on AGENTS.md prompting to call muninn_recall when needed.
  pi.on("before_agent_start", async () => {
    if (!muninnUp || !isFirstTurn) return;
    isFirstTurn = false;

    return {
      message: {
        customType: "muninn_session_start",
        content:
          `MuninnDB memory is connected (vault: "${currentVault}"). ` +
          `Call muninndb_muninn_where_left_off (via mcp) to restore context from your last session, ` +
          `then muninndb_muninn_recall whenever you need relevant memories.`,
        display: false,
      },
    };
  });

  // ─── context: Inject SSE push events ───
  //
  // MuninnDB pushes two types of events we care about:
  // 1. contradiction_detected — new memory conflicts with existing one
  // 2. new_write (score >= 0.7) — relevant memory was just stored
  //
  // These are injected into the LLM's context as they arrive,
  // so the agent can act on contradictions immediately.
  pi.on("context" as any, async () => {
    if (pendingPushes.length === 0) return;

    const relevant = pendingPushes
      .filter((p) => p.trigger === "new_write" || p.trigger === "contradiction_detected")
      .slice(0, 3);

    if (relevant.length === 0) return;

    const content = relevant
      .map((p) => {
        if (p.trigger === "contradiction_detected" && p.engram) {
          return (
            `[⚠️ Contradiction detected]: "${p.engram.concept}" — ` +
            `${p.why ?? "New information conflicts with existing memory"}. ` +
            `Use muninndb_muninn_evolve(id="${p.engram.id}", ...) to update it, ` +
            `or muninndb_muninn_consolidate to merge.`
          );
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