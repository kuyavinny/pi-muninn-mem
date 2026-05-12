import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, extractSignal, validateActions, type SessionSignal, type CandidateAction } from "../src/dream.js";

describe("parseArgs", () => {
  it("uses defaults when no args provided", () => {
    const opt = parseArgs([], "/home");
    assert.strictEqual(opt.vault, "default");
    assert.strictEqual(opt.dryRun, false);
    assert.strictEqual(opt.extractOnly, false);
  });

  it("parses --vault and --dry-run", () => {
    const opt = parseArgs(["--vault", "proj", "--dry-run"], "/tmp");
    assert.strictEqual(opt.vault, "proj");
    assert.strictEqual(opt.dryRun, true);
  });

  it("parses --vault=NAME syntax", () => {
    const opt = parseArgs(["--vault=special"], "/tmp");
    assert.strictEqual(opt.vault, "special");
  });
});

describe("extractSignal", () => {
  it("extracts session metadata and messages from JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dream-"));
    const file = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "session",
        id: "sess-123",
        cwd: "/tmp",
        timestamp: "2024-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello world" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi there" }],
        },
      }),
    ];
    writeFileSync(file, lines.join("\n"));
    try {
      const signal = await extractSignal(file);
      assert.strictEqual(signal.sessionId, "sess-123");
      assert.strictEqual(signal.userMessages.length, 1);
      assert.strictEqual(signal.assistantMessages.length, 1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("validateActions", () => {
  const emptySignal: SessionSignal = {
    sessionId: "",
    cwd: "",
    parentSession: null,
    timestamp: "",
    entryCount: 0,
    compactionCount: 0,
    compactionSummaries: [],
    userMessages: [],
    assistantMessages: [],
    thinkingBlocks: [],
    muninnCalls: [],
    customMuninn: [],
  };

  it("accepts a valid remember action", () => {
    const actions: CandidateAction[] = [
      {
        action: "remember",
        concept: "Stack choice",
        content: "This is a reasonably long memory content that passes validation rules easily.",
        type: "fact",
      },
    ];
    const result = validateActions(actions, emptySignal);
    assert.strictEqual(result.valid.length, 1);
    assert.strictEqual(result.rejections.length, 0);
  });

  it("rejects remember with short content", () => {
    const actions: CandidateAction[] = [
      {
        action: "remember",
        concept: "X",
        content: "short",
        type: "fact",
      },
    ];
    const result = validateActions(actions, emptySignal);
    assert.strictEqual(result.valid.length, 0);
    assert.strictEqual(result.rejections[0]?.reason, "content too short");
  });

  it("rejects remember with invalid type", () => {
    const actions: CandidateAction[] = [
      {
        action: "remember",
        concept: "X",
        content: "This is a reasonably long memory content that passes length validation.",
        type: "invalid",
      },
    ];
    const result = validateActions(actions, emptySignal);
    assert.strictEqual(result.valid.length, 0);
    assert.strictEqual(result.rejections[0]?.reason, "invalid type");
  });

  it("accepts a valid decide action", () => {
    const actions: CandidateAction[] = [
      {
        action: "decide",
        decision: "Use Node 22",
        rationale: "LTS requirements",
      },
    ];
    const result = validateActions(actions, emptySignal);
    assert.strictEqual(result.valid.length, 1);
  });

  it("rejects evolve with invalid id", () => {
    const actions: CandidateAction[] = [
      {
        action: "evolve",
        id: "invalid",
        new_content: "Updated memory content goes here for length.",
        reason: "Correction",
      },
    ];
    const result = validateActions(actions, emptySignal);
    assert.strictEqual(result.rejections.length, 1);
    assert.strictEqual(result.rejections[0]?.reason, "invalid id");
  });
});
