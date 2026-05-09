import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { client } from "./shared-client";
import { resolveVaultName, MAX_CONTEXT_CHARS, ENVIRONMENTS, ActivationPush } from "./vault";
import { startSSESubscription } from "./subscribe";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { extractMemories, extractUserMemories, isWorthExtracting } from "./knowledge-extractor";

/**
 * Generate a stable idempotency key from prefix + value content.
 */
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/**
 * Ensure a MuninnDB vault exists and is public.
 */
function ensurePublicVault(vaultName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const muninnBin = process.env.MUNINN_BIN ?? findMuninnBinary();
    if (!muninnBin) return resolve();
    execFile(
      muninnBin,
      ["vault", "create", vaultName, "--public", "-u", "root", "-p"],
      { timeout: 5000 },
      (err) => {
        if (err?.message?.includes("already exists")) return resolve();
        if (err) return reject(err);
        resolve();
      },
    );
  });
}

function findMuninnBinary(): string | null {
  const { PATH = "" } = process.env;
  const candidates = [
    ...PATH.split(":").map((d) => `${d}/muninn`),
    `${process.env.HOME}/bin/muninn`,
    "/usr/local/bin/muninn",
  ];
  for (const candidate of candidates) {
    try {
      require("node:fs").accessSync(candidate, require("node:fs").constants.X_OK);
      return candidate;
    } catch { continue; }
  }
  return null;
}

/**
 * Map user prompt to recall profile based on intent.
 */
function mapIntentToProfile(prompt: string): string {
  if (/\b(how|why|what causes|explain)\b/i.test(prompt)) return "causal";
  if (/\b(options|alternatives|what are the|recommend)\b/i.test(prompt)) return "confirmatory";
  if (/\b(problem|issue|contradiction|risk|downside|disadvantage|error|bug|failure)\b/i.test(prompt)) return "adversarial";
  if (/\b(related|connected|show me all|project structure|architecture|components)\b/i.test(prompt)) return "structural";
  return "balanced";
}

/**
 * Registers Pi lifecycle hooks for automatic memory management.
 */
export default function registerLifecycleHooks(pi: ExtensionAPI) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;
  let lastUserMessage = "";
  let guideShown = false; // Only call muninn_guide once per session

  // ----------------------------------------------------------
  // session_start: Ensure vault, restore context, subscribe SSE,
  //                call muninn_guide on first connect
  // ----------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    currentVault = resolveVaultName(process.cwd());

    ctx.ui.notify(
      `MuninnDB: ${client.getEnvironment().toUpperCase()} mode | vault: ${currentVault}`,
      "info",
    );

    try {
      await ensurePublicVault(currentVault);
    } catch {
      // Vault may already exist or CLI unavailable
    }

    // Start SSE subscription for real-time pushes
    sseAbort = new AbortController();
    startSSESubscription(client, currentVault, sseAbort.signal, (push) => {
      pendingPushes.push(push);
    });

    // Call muninn_guide on first connect to learn vault-specific best practices
    if (!guideShown) {
      try {
        const guide = await client.recall({
          vault: currentVault,
          query: "MuninnDB guide best practices vault instructions",
          maxResults: 1,
          mode: "balanced",
          profile: "confirmatory",
        });
        if (guide.length > 0) {
          ctx.ui.notify(
            `MuninnDB: ${guide[0].concept}`,
            "info",
          );
        }
        guideShown = true;
      } catch {
        // Silent — guide is optional
      }
    }

    // Restore context using muninn_where_left_off pattern
    try {
      const recent = await client.recall({
        vault: currentVault,
        query: "what was I working on last session recent activity",
        maxResults: 3,
        mode: "recent",
      });

      if (recent.length > 0) {
        const memoryBlock = recent
          .map((m) => `[${m.type}] ${m.concept}: ${m.content}`)
          .join("\n");

        ctx.ui.notify(
          `MuninnDB: Resumed from ${recent.length} memories in "${currentVault}"`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `MuninnDB: Connected to vault "${currentVault}" — no prior memories`,
          "info",
        );
      }
    } catch {
      ctx.ui.notify(
        `MuninnDB: Could not connect to vault "${currentVault}"`,
        "warning",
      );
    }
  });

  // ----------------------------------------------------------
  // session_shutdown: Clean up SSE
  // ----------------------------------------------------------
  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
  });

  // ----------------------------------------------------------
  // before_agent_start: Recall memories + extract user knowledge
  // ----------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (!event.prompt) return;

    // Save user message for later extraction in agent_end
    lastUserMessage = event.prompt;

    // Recall relevant memories
    try {
      const profile = mapIntentToProfile(event.prompt);
      const memories = await client.recall({
        vault: currentVault,
        query: event.prompt,
        maxResults: 5,
        mode: "balanced",
        profile,
      });

      if (memories.length > 0) {
        let memoryBlock = memories
          .map((m) => `[${m.type}] ${m.concept} (score: ${m.score.toFixed(3)}): ${m.content}`)
          .join("\n");

        if (memoryBlock.length > MAX_CONTEXT_CHARS) {
          memoryBlock = memoryBlock.slice(0, MAX_CONTEXT_CHARS) + "\n[...truncated]";
        }

        return {
          message: {
            customType: "muninn_memory",
            content: `Relevant memories from previous sessions:\n${memoryBlock}`,
            display: true,
          },
        };
      }
    } catch {
      // Silently fail
    }

    // Extract implicit knowledge from the user's message
    if (isWorthExtracting(event.prompt)) {
      extractUserMemories(event.prompt).then((memories) => {
        for (const mem of memories) {
          if (mem.confidence < 0.6) continue;
          client.remember({
            vault: currentVault,
            concept: mem.concept,
            content: mem.content,
            type: mem.type,
            tags: mem.tags,
            entities: mem.entities,
            idempotentId: stableId("user", mem.concept),
          }).catch(() => {});
        }
      });
    }
  });

  // ----------------------------------------------------------
  // context: Inject pending SSE pushes + handle contradictions
  // ----------------------------------------------------------
  pi.on("context" as any, async (event: any) => {
    if (pendingPushes.length === 0) return;

    const relevant = pendingPushes
      .filter((p) => p.trigger === "new_write" || p.trigger === "contradiction_detected")
      .slice(0, 3);

    if (relevant.length === 0) return;

    const content = relevant
      .map((p) => {
        if (p.trigger === "contradiction_detected") {
          return `[⚠️ Contradiction detected]: ${p.engram?.concept}: ${p.why ?? "New information conflicts with existing memory"}`;
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

  // Noisy tools whose output is not worth storing
  const noisyTools = new Set([
    "ask_user_question", "bash", "read", "edit", "write",
    "todo", "advisor", "Agent", "get_subagent_result", "steer_subagent",
    "muninn_env", "remember", "recall", "decide",
    "muninndb_muninn_remember", "muninndb_muninn_recall", "muninndb_muninn_decide",
    "muninndb_muninn_env",
  ]);

  // ----------------------------------------------------------
  // tool_execution_end: Store significant tool results
  // ----------------------------------------------------------
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName || noisyTools.has(event.toolName)) return;

    const resultStr = typeof event.result === "string"
      ? event.result
      : JSON.stringify(event.result).slice(0, 1000);

    if (!isWorthExtracting(resultStr)) return;

    const idempotentId = stableId(
      "tool",
      `${event.toolName}:${resultStr.slice(0, 200)}`,
    );

    try {
      await client.remember({
        vault: currentVault,
        concept: `tool:${event.toolName}`,
        content: `Called ${event.toolName} with result: ${resultStr}`,
        type: "fact",
        tags: ["tool-call", event.toolName],
        idempotentId,
      });
    } catch {
      // Silently fail
    }
  });

  // ----------------------------------------------------------
  // agent_end: Extract knowledge from conversation via LLM
  // ----------------------------------------------------------
  pi.on("agent_end", async (event) => {
    const lastMessage = event.messages?.[event.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    const agentText = typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

    if (!isWorthExtracting(agentText)) return;
    if (!lastUserMessage) return;

    // Use LLM to extract knowledge from the conversation turn
    try {
      const memories = await extractMemories(lastUserMessage, agentText);

      // Store each extracted memory via dual-write
      for (const mem of memories) {
        if (mem.confidence < 0.5) continue;

        await client.remember({
          vault: currentVault,
          concept: mem.concept,
          content: mem.content,
          type: mem.type,
          tags: mem.tags,
          entities: mem.entities,
          idempotentId: stableId("llm", mem.concept),
        });
      }
    } catch {
      // LLM extraction failed — silently skip
      // Better to store nothing than noise
    }
  });
}