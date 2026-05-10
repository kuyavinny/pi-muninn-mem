import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MuninnClient } from "./client";
import { resolveVaultName, isProjectDirectory, readVaultMapping, writeVaultMapping, MUNINN_REST_URL, PROJECT_MARKERS } from "./vault";
import type { ActivationPush } from "./vault";

// ─── Shared client singleton ──────────────────────────────────────────

const client = new MuninnClient(MUNINN_REST_URL);

// ─── SSE subscription filter ──────────────────────────────────────────

function startSSESubscription(vault: string, signal: AbortSignal, onPush: (push: ActivationPush) => void): void {
  (async () => {
    try {
      for await (const push of client.subscribe(vault, signal)) {
        if (push.trigger === "contradiction_detected") {
          onPush(push);
        } else if (push.trigger === "new_write" && push.engram && push.score != null && push.score >= 0.7) {
          onPush(push);
        }
      }
    } catch { /* subscription ended */ }
  })();
}

// ─── Lifecycle hooks ──────────────────────────────────────────────────

export default function registerLifecycleHooks(pi: ExtensionAPI) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;
  let isFirstTurn = true;
  let muninnUp = false;

  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());
    isFirstTurn = true;

    try {
      const res = await fetch(`${MUNINN_REST_URL}/api/health`);
      muninnUp = res.ok;
    } catch {
      muninnUp = false;
    }

    if (!muninnUp) {
      ctx.ui.notify("MuninnDB is not running. Run /muninn-setup to install and configure it.", "warning");
      return;
    }

    ctx.ui.notify(`MuninnDB: vault "${currentVault}"`, "info");

    sseAbort = new AbortController();
    startSSESubscription(currentVault, sseAbort.signal, (push) => pendingPushes.push(push));
  });

  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
    isFirstTurn = true;
  });

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
    return { message: { customType: "muninn_memory", content, display: true } };
  });
}