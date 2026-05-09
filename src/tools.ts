import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { DualMuninnClient } from "./dual-client";
import { client } from "./shared-client";
import { MemoryType, resolveVaultName, DEFAULT_ENV, ENVIRONMENTS } from "./vault";

/**
 * Registers custom Pi tools that wrap MuninnDB operations.
 * The LLM can call these tools directly for explicit memory ops,
 * complementing the automatic lifecycle hooks in extension.ts.
 */
export function registerMemoryTools(pi: ExtensionAPI) {
  const getVault = () => resolveVaultName(process.cwd());

  // ----------------------------------------------------------
  // remember: Store a fact, preference, or observation
  // ----------------------------------------------------------
  pi.registerTool({
    name: "remember",
    label: "Remember",
    description: "Store a memory in MuninnDB for future recall",
    parameters: Type.Object({
      concept: Type.String({
        description: "Short label for this memory (max 512 chars)",
      }),
      content: Type.String({
        description: "The actual information to remember (max 16KB)",
      }),
      memoryType: Type.Optional(
        Type.Enum(
          {
            fact: "fact",
            decision: "decision",
            preference: "preference",
            observation: "observation",
            issue: "issue",
            task: "task",
          },
          { description: "Type of memory (default: fact)" },
        ),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tags for categorization",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.remember({
          vault: getVault(),
          concept: params.concept,
          content: params.content,
          type: params.memoryType ?? MemoryType.Fact,
          tags: params.tags,
        });
        return {
          content: [
            { type: "text" as const, text: `Memory stored. ID: ${result.id}` },
          ],
          details: { engramId: result.id },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to store memory: ${message}`,
            },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  // ----------------------------------------------------------
  // recall: Semantic search for relevant memories
  // ----------------------------------------------------------
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Search for relevant memories using semantic understanding",
    parameters: Type.Object({
      query: Type.String({
        description:
          "What to search for — use natural language describing what you want to find",
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: "Maximum results (default: 5, max: 20)",
        }),
      ),
      mode: Type.Optional(
        Type.Enum(
          {
            balanced: "balanced",
            semantic: "semantic",
            recent: "recent",
            deep: "deep",
          },
          { description: "Search mode (default: balanced)" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const results = await client.recall({
          vault: getVault(),
          query: params.query,
          maxResults: Math.min(params.maxResults ?? 5, 20),
          mode: (params.mode as "semantic" | "recent" | "balanced" | "deep" | undefined) ?? "balanced",
        });

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No relevant memories found.",
              },
            ],
            details: { count: 0 },
          };
        }

        const text = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.type}] ${r.concept} (score: ${r.score.toFixed(3)})\n   ${r.content}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} memories:\n\n${text}`,
            },
          ],
          details: { count: results.length, results },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Recall failed: ${message}` },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  // ----------------------------------------------------------
  // decide: Record a decision with rationale
  // ----------------------------------------------------------
  pi.registerTool({
    name: "decide",
    label: "Decide",
    description:
      "Record a decision with rationale and alternatives considered",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision made" }),
      rationale: Type.String({
        description: "Why this decision was made",
      }),
      alternatives: Type.Optional(
        Type.Array(Type.String(), {
          description: "Alternatives that were considered",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await client.remember({
          vault: getVault(),
          concept: `decision: ${params.decision.slice(0, 80)}`,
          content: `Decision: ${params.decision}\nRationale: ${params.rationale}\nAlternatives considered: ${(params.alternatives ?? []).join(", ") || "None"}`,
          type: MemoryType.Decision,
          tags: ["decision"],
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Decision recorded. ID: ${result.id}`,
            },
          ],
          details: { engramId: result.id },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to record decision: ${message}`,
            },
          ],
          details: { error: message },
          isError: true,
        };
      }
    },
  });

  // ----------------------------------------------------------
  // env: Switch or query the MuninnDB environment (dev/prod)
  // ----------------------------------------------------------
  pi.registerTool({
    name: "muninn_env",
    label: "MuninnDB Environment",
    description:
      "Switch between dev (CLI) and prod (container) MuninnDB environments, or show the current environment. Writes always go to both; reads come from the active one.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("show", { description: "Show current environment and status" }),
          Type.Literal("switch", { description: "Switch to a different environment" }),
        ],
        { description: "Action to perform" },
      ),
      environment: Type.Optional(
        Type.Union(
          [
            Type.Literal("dev", { description: "Local CLI instance (ports 8475/8750)" }),
            Type.Literal("prod", { description: "Container instance (ports 8575/8850)" }),
          ],
          { description: "Target environment (required for 'switch')" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.action === "show") {
          const env = client.getEnvironment();
          const cfg = ENVIRONMENTS[env];
          return {
            content: [
              {
                type: "text" as const,
                text: `Current environment: ${env.toUpperCase()}\nREST: ${cfg.restUrl}\nMCP:  ${cfg.mcpUrl}`,
              },
            ],
            details: { environment: env, restUrl: cfg.restUrl, mcpUrl: cfg.mcpUrl },
          };
        }

        if (params.action === "switch") {
          const target = params.environment;
          if (!target) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "You must specify 'environment' (dev or prod) when using 'switch'.",
                },
              ],
              isError: true,
              details: { error: "Missing environment parameter" },
            };
          }
          client.setEnvironment(target);
          const cfg = ENVIRONMENTS[target];
          return {
            content: [
              {
                type: "text" as const,
                text: `Switched to ${target.toUpperCase()}\nREST: ${cfg.restUrl}\nMCP:  ${cfg.mcpUrl}`,
              },
            ],
            details: { environment: target, restUrl: cfg.restUrl, mcpUrl: cfg.mcpUrl },
          };
        }

        return {
          content: [
            { type: "text" as const, text: `Unknown action: ${params.action}` },
          ],
          isError: true,
          details: {},
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Environment operation failed: ${message}` },
          ],
          isError: true,
          details: { error: message },
        };
      }
    },
  });
}

/**
 * MCP Bridge Configuration
 *
 * The MCP bridge is automatically registered during session_start in index.ts.
 * It discovers all 38 MuninnDB MCP tools and exposes them as native Pi tools.
 *
 * Required: MuninnDB must be running.
 *   $ muninn start
 *   or download from: https://github.com/scrypster/muninndb/releases
 *
 * MCP server endpoint: http://127.0.0.1:8750/mcp (JSON-RPC 2.0)
 * REST API endpoint: http://127.0.0.1:8475/api
 */
