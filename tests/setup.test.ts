import { describe, it } from "node:test";
import assert from "node:assert";
import { validateMcpUrl, removeMuninnSection, verifyChecksum } from "../src/setup.js";

describe("validateMcpUrl", () => {
  it("accepts localhost with known port", () => {
    assert.strictEqual(validateMcpUrl("http://127.0.0.1:8750/mcp"), true);
    assert.strictEqual(validateMcpUrl("http://localhost:8475"), true);
  });

  it("rejects non-localhost hostnames", () => {
    assert.strictEqual(validateMcpUrl("http://example.com:8750/mcp"), false);
  });

  it("rejects unknown ports", () => {
    assert.strictEqual(validateMcpUrl("http://127.0.0.1:9999/mcp"), false);
  });

  it("rejects malformed URLs", () => {
    assert.strictEqual(validateMcpUrl("not-a-url"), false);
  });
});

describe("removeMuninnSection", () => {
  it("removes the MuninnDB section from AGENTS.md", () => {
    const content = "# Agent Instructions\n\n# Memory: MuninnDB\nSome content here.\n\n# Other Section\nMore text.";
    const result = removeMuninnSection(content);
    assert.ok(!result.includes("Memory: MuninnDB"));
    assert.ok(result.includes("Agent Instructions"));
    assert.ok(result.includes("Other Section"));
  });

  it("returns content unchanged if marker absent", () => {
    const content = "Just some text.";
    assert.strictEqual(removeMuninnSection(content), content);
  });
});

describe("verifyChecksum", () => {
  it("succeeds for matching SHA-256", () => {
    const buf = Buffer.from("hello");
    const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert.doesNotThrow(() => verifyChecksum(buf, expected));
  });

  it("throws for mismatching SHA-256", () => {
    const buf = Buffer.from("hello");
    assert.throws(() => verifyChecksum(buf, "0000"), /Integrity check failed/);
  });
});
