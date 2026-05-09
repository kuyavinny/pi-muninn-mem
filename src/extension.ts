import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DualMuninnClient } from "./dual-client";
import { client } from "./shared-client";
import { resolveVaultName, Environment, DEFAULT_ENV, MAX_CONTEXT_CHARS, ENVIRONMENTS } from "./vault";
import { startSSESubscription } from "./subscribe";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import { ActivationPush } from "./vault";

/**
 * Check if a response is meta-conversation (about the chat itself).
 * These should not be stored as knowledge.
 */
function isMetaResponse(text: string): boolean {
  const metaPatterns = [
    /Relevant memories from previous sessions:/i,
    /Here's the (clean|organized) view/i,
    /The cleanup is working/i,
    /Perfect! Here's the/i,
    /Let me (check|verify|test)/i,
    /I'll (restart|reload|continue)/i,
    /=== (Test|Check|Verify)/i,
    /Total found:/i,
    /Top \d+ results:/i,
    /Forgotten:/i,
    /muninn already running/i,
    /Web UI →/i,
  ];
  return metaPatterns.some(pattern => pattern.test(text));
}

/**
 * Extract knowledge from agent response.
 */
function extractKnowledge(text: string) {
  // Extract concept (first sentence or first line)
  const conceptMatch = text.match(/^(.+?[.!?])/);
  const concept = conceptMatch ? conceptMatch[0].trim() : text.slice(0, 80);

  // Determine memory type
  let type = "fact";
  if (text.includes("how") || text.includes("steps") || text.includes("process")) type = "procedure";
  if (text.includes("should") || text.includes("choose") || text.includes("decision")) type = "decision";
  if (text.includes("problem") || text.includes("issue") || text.includes("contradiction")) type = "issue";
  if (text.includes("best practice") || text.includes("recommend")) type = "preference";

  // Extract tags (keywords)
  const tags = [];
  const tagPatterns = [
    { pattern: /TypeScript|JavaScript/i, tag: "typescript" },
    { pattern: /Pi Extension|ExtensionAPI/i, tag: "pi-coding-agent" },
    { pattern: /MCP|Model Context Protocol/i, tag: "mcp" },
    { pattern: /MuninnDB|Muninn/i, tag: "muninndb" },
    { pattern: /Ollama|embedding/i, tag: "ollama" },
    { pattern: /vault|memory/i, tag: "memory" },
    { pattern: /tool|hook|lifecycle/i, tag: "extension" },
    { pattern: /TypeBox|schema/i, tag: "typebox" },
  ];
  
  const tagSet = new Set<string>();
  for (const { pattern, tag } of tagPatterns) {
    if (pattern.test(text)) tagSet.add(tag);
  }
  
  // Add type as tag
  if (text.includes("how")) tagSet.add("how-to");
  if (text.includes("decision")) tagSet.add("decision");
  
  // Extract entities
  const entities = [];
  const codePatterns = [
    { pattern: /pi\.on\(\)/g, type: "api" },
    { pattern: /ExtensionAPI/g, type: "api" },
    { pattern: /TypeBox/g, type: "library" },
    { pattern: /MuninnClient/g, type: "class" },
    { pattern: /before_agent_start/g, type: "hook" },
  ];
  
  for (const { pattern, type } of codePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) entities.push({ name: match[0], type });
    }
  }
  
  const projectPatterns = [
    { pattern: /MuninnDB/g, type: "project" },
    { pattern: /Pi Extension/g, type: "project" },
    { pattern: /pi-mcp-adapter/g, type: "project" },
  ];
  
  for (const { pattern, type } of projectPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) entities.push({ name: match[0], type });
    }
  }

  return {
    concept,
    content: text,
    type,
    tags: Array.from(tagSet),
    entities,
  };
}

/**
 * Generate a stable idempotency key from prefix + value content.
 * Uses SHA-256 truncated to 32 hex chars for deterministic dedup.
 */
function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

/**
 * Extract entities from text using simple NER heuristics.
 */
function extractEntities(text: string): Array<{ name: string; type: string }> {
  const entities: Array<{ name: string; type: string }> = [];
  
  // Code/API entities
  const codePatterns = [
    { pattern: /pi\.on\(\)/g, type: "api" },
    { pattern: /ExtensionAPI/g, type: "api" },
    { pattern: /TypeBox/g, type: "library" },
    { pattern: /MuninnClient/g, type: "class" },
    { pattern: /before_agent_start/g, type: "hook" },
  ];
  
  for (const { pattern, type } of codePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) entities.push({ name: match[0], type });
    }
  }
  
  // Project entities
  const projectPatterns = [
    { pattern: /MuninnDB/g, type: "project" },
    { pattern: /Pi Extension/g, type: "project" },
    { pattern: /pi-mcp-adapter/g, type: "project" },
  ];
  
  for (const { pattern, type } of projectPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) entities.push({ name: match[0], type });
    }
  }
  
  return entities;
}

/**
 * Ensure a MuninnDB vault exists and is public (no API key required).
 * New vaults are locked by default — this uses the MuninnDB CLI
 * to create the vault as public if it doesn't exist yet.
 * Silently succeeds if the vault already exists.
 */
function ensurePublicVault(vaultName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Look for muninn binary in common locations
    const muninnBin =
      process.env.MUNINN_BIN ??
      findMuninnBinary();

    if (!muninnBin) {
      // CLI not available — REST calls will fail with VAULT_LOCKED for
      // non-default vaults. User must pre-create vaults manually:
      //   muninn vault create <project> --public
      return resolve();
    }

    execFile(
      muninnBin,
      ["vault", "create", vaultName, "--public", "-u", "root", "-p"],
      { timeout: 5000 },
      (err) => {
        if (err) {
          // "already exists" is not an error for our purposes
          if (err.message?.includes("already exists")) return resolve();
          return reject(err);
        }
        resolve();
      },
    );
  });
}

/**
 * Find the muninn binary on the system.
 * Checks PATH and ~/bin/muninn (common install location).
 */
function findMuninnBinary(): string | null {
  const { PATH = "" } = process.env;
  const pathDirs = PATH.split(":");
  const candidates = [
    ...pathDirs.map((d) => `${d}/muninn`),
    `${process.env.HOME}/bin/muninn`,
    "/usr/local/bin/muninn",
  ];
  // Synchronous check — execFile is fast and this only runs on session_start
  for (const candidate of candidates) {
    try {
      const { accessSync } = require("node:fs");
      accessSync(candidate, require("node:fs").constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Map user prompt to recall profile based on intent.
 */
function mapIntentToProfile(prompt: string): string {
  // Causal: "how", "why", "what causes"
  if (/\b(how|why|what causes|explain)\b/i.test(prompt)) return "causal";
  
  // Confirmatory: "options", "alternatives", "what are the"
  if (/\b(options|alternatives|what are the|recommend)\b/i.test(prompt)) return "confirmatory";
  
  // Adversarial: "problem", "issue", "contradiction", "risk"
  if (/\b(problem|issue|contradiction|risk|downside|disadvantage|error|bug|failure)\b/i.test(prompt)) return "adversarial";
  
  // Structural: "related", "connected", "show me all", "project structure"
  if (/\b(related|connected|show me all|project structure|architecture|components)\b/i.test(prompt)) return "structural";
  
  // Default: balanced
  return "balanced";
}

/**
 * Registers Pi lifecycle hooks for automatic memory management.
 *
 * @param pi     Pi extension API
 */
export default function registerLifecycleHooks(
  pi: ExtensionAPI,
) {
  let currentVault = resolveVaultName(process.cwd());
  let pendingPushes: ActivationPush[] = [];
  let sseAbort: AbortController | null = null;

  // Notify user about environment
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `MuninnDB: Running in ${client.getEnvironment().toUpperCase()} mode`,
      "info",
    );
  });

  // ----------------------------------------------------------
  // session_start: Ensure vault exists, restore context
  // ----------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    // Resolve vault from cwd — consistent with custom tools and MCP bridge
    currentVault = resolveVaultName(process.cwd());

    // Ensure the project vault exists and is accessible.
    // New vaults are locked by default — create as public via CLI.
    try {
      await ensurePublicVault(currentVault);
    } catch {
      // Vault may already exist or CLI unavailable — continue anyway
    }

    // Start SSE subscription for real-time pushes
    sseAbort = new AbortController();
    startSSESubscription(client, currentVault, sseAbort.signal, (push) => {
      pendingPushes.push(push);
    });

    // Restore recent session context (where_left_off equivalent)
    try {
      const recent = await client.getRecentActivity(currentVault);
      if (recent.length > 0) {
        ctx.ui.notify(
          `MuninnDB: Restored ${recent.length} recent memories from vault "${currentVault}"`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `MuninnDB: Connected to vault "${currentVault}" — no prior memories found`,
          "info",
        );
      }
    } catch {
      ctx.ui.notify(
        `MuninnDB: Could not connect to vault "${currentVault}" — is the server running?`,
        "warning",
      );
    }
  });

  // ----------------------------------------------------------
  // session_shutdown: Clean up SSE subscription
  // ----------------------------------------------------------
  pi.on("session_shutdown", async () => {
    sseAbort?.abort();
    sseAbort = null;
    pendingPushes = [];
  });

  // ----------------------------------------------------------
  // before_agent_start: Load relevant memories for user prompt
  // ----------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (!event.prompt) return;

    try {
      // Map user intent to recall profile
      const profile = mapIntentToProfile(event.prompt);

      const memories = await client.recall({
        vault: currentVault,
        query: event.prompt,
        maxResults: 5,
        mode: "balanced",
        profile,  // Intent-aware recall
      });

      if (memories.length > 0) {
        let memoryBlock = memories
          .map(
            (m) =>
              `[${m.type}] ${m.concept} (score: ${m.score.toFixed(3)}): ${m.content}`,
          )
          .join("\n");

        // Enforce context budget — truncate if exceeding MAX_CONTEXT_CHARS
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
      // No relevant memories found — nothing to inject, agent proceeds normally
    } catch {
      // Silently fail — memory is best-effort
    }
  });

  // ----------------------------------------------------------
  // context: Inject pending SSE pushes into message context
  // ----------------------------------------------------------
  pi.on("context" as any, async (event: any) => {
    if (pendingPushes.length === 0) return;

    const relevant = pendingPushes
      .filter((p) => p.trigger === "new_write" && p.engram)
      .slice(0, 3);

    if (relevant.length === 0) return;

    const content = relevant
      .map(
        (p) =>
          `[Memory Update: ${p.trigger}] ${p.engram?.concept}: ${p.engram?.content}`,
      )
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

  // Filter out noisy tools (bash, read, edit, write, etc.)
  const noisyTools = new Set([
    "ask_user_question",
    "bash",
    "read",
    "edit",
    "write",
    "todo",
    "advisor",
    "Agent",
    "get_subagent_result",
    "steer_subagent",
  ]);

  // ----------------------------------------------------------
  // tool_execution_end: Store tool call results as engrams
  // ----------------------------------------------------------
  pi.on("tool_execution_end", async (event) => {
    if (!event.toolName || noisyTools.has(event.toolName)) return;

    const idempotentId = stableId(
      "tool",
      `${event.toolName}:${typeof event.result === "string" ? event.result : JSON.stringify(event.result).slice(0, 200)}`,
    );

    try {
      const resultStr =
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result).slice(0, 1000);

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
  // agent_end: Extract and store structured knowledge
  // ----------------------------------------------------------
  pi.on("agent_end", async (event) => {
    const lastMessage = event.messages?.[event.messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    const textContent =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

    // Skip meta-responses about the conversation itself
    if (isMetaResponse(textContent)) return;

    // Extract structured knowledge from the response
    const { concept, content, type, tags, entities } =
      extractKnowledge(textContent);

    const idempotentId = stableId("agent", concept);

    try {
      await client.remember({
        vault: currentVault,
        concept,
        content,
        type,
        tags,
        entities,
        idempotentId,
      });
    } catch {
      // Silently fail
    }
  });
}
