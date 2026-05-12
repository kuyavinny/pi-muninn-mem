import { describe, it } from "node:test";
import assert from "node:assert";
import { registerVaultInjection } from "../src/mcp-bridge.js";

function createMockPi() {
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  return {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    async emit(event: string, ...args: unknown[]) {
      for (const h of handlers[event] || []) {
        const result = await h(...args);
        if (result !== undefined) return result;
      }
    },
  };
}

describe("mcp-bridge vault injection", () => {
  it("injects vault when tool input lacks one", async () => {
    const pi = createMockPi();
    (pi as unknown as Record<string, unknown>).on = pi.on;
    registerVaultInjection(pi as never);

    const event = { toolName: "muninndb_muninn_remember", input: { concept: "Test" } as Record<string, unknown> };
    await pi.emit("tool_call", event, {});
    assert.strictEqual(typeof event.input.vault, "string");
    assert.ok((event.input.vault as string).length > 0);
  });

  it("does not override an explicitly provided vault", async () => {
    const pi = createMockPi();
    (pi as unknown as Record<string, unknown>).on = pi.on;
    registerVaultInjection(pi as never);

    const event = { toolName: "muninndb_muninn_remember", input: { vault: "existing" } as Record<string, unknown> };
    await pi.emit("tool_call", event, {});
    assert.strictEqual(event.input.vault, "existing");
  });

  it("nudges batch after two individual remember calls", async () => {
    const pi = createMockPi();
    (pi as unknown as Record<string, unknown>).on = pi.on;
    registerVaultInjection(pi as never);

    await pi.emit("before_agent_start");

    await pi.emit("tool_call", { toolName: "muninndb_muninn_remember", input: {} }, {});
    const result = await pi.emit("tool_call", { toolName: "muninndb_muninn_remember", input: {} }, {});
    assert.strictEqual((result as { message?: { customType?: string } })?.message?.customType, "muninn_batch_nudge");
  });

  it("resets remember count on batch call", async () => {
    const pi = createMockPi();
    (pi as unknown as Record<string, unknown>).on = pi.on;
    registerVaultInjection(pi as never);

    await pi.emit("before_agent_start");

    await pi.emit("tool_call", { toolName: "muninndb_muninn_remember_batch", input: {} }, {});
    const result = await pi.emit("tool_call", { toolName: "muninndb_muninn_remember", input: {} }, {});
    assert.strictEqual(result, undefined);
  });
});
