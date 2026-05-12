import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We must import vault lazily so that process.env.HOME changes take effect.
let originalHome: string | undefined;
let tempHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = join(tmpdir(), `muninn-test-${Date.now()}`);
  mkdirSync(tempHome, { recursive: true });
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tempHome, { recursive: true });
  } catch {
    /* ignore */
  }
});

describe("vault resolution", async () => {
  it("falls back to default for non-project directories", async () => {
    const { resolveVaultName, DEFAULT_VAULT } = await import("../src/vault.js");
    const dir = join(tempHome, "no-project");
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(resolveVaultName(dir), DEFAULT_VAULT);
  });

  it("derives vault name from directory basename for project directories", async () => {
    const { resolveVaultName } = await import("../src/vault.js");
    const dir = join(tempHome, "my-project");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    assert.strictEqual(resolveVaultName(dir), "my-project");
  });

  it("reads explicit vault mapping", async () => {
    const { resolveVaultName } = await import("../src/vault.js");
    const dir = join(tempHome, "mapped");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tempHome, ".muninn"), { recursive: true });
    writeFileSync(join(tempHome, ".muninn", "vaults.json"), JSON.stringify({ [dir]: "custom-vault" }));
    assert.strictEqual(resolveVaultName(dir), "custom-vault");
  });

  it("writes and re-reads vault mapping atomically", async () => {
    const { readVaultMapping, writeVaultMapping } = await import("../src/vault.js");
    const dir = join(tempHome, "to-map");
    mkdirSync(dir, { recursive: true });
    writeVaultMapping({ [dir]: "written-vault" });
    const mapping = readVaultMapping();
    assert.strictEqual(mapping[dir], "written-vault");
  });
});

describe("isProjectDirectory", async () => {
  it("returns true when a marker exists", async () => {
    const { isProjectDirectory } = await import("../src/vault.js");
    const dir = join(tempHome, "proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), "");
    assert.strictEqual(isProjectDirectory(dir), true);
  });

  it("returns false when no markers exist", async () => {
    const { isProjectDirectory } = await import("../src/vault.js");
    const dir = join(tempHome, "empty");
    mkdirSync(dir, { recursive: true });
    assert.strictEqual(isProjectDirectory(dir), false);
  });
});
