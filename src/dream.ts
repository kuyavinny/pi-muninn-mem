import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_VAULT, MUNINN_REST_URL } from "./vault";

export interface DreamOptions {
  vault: string;
  restUrl: string;
  sessionDir: string;
  sessionFile: string;
  dryRun: boolean;
  extractOnly: boolean;
  showPrompt: boolean;
  showCreated: boolean;
  verbose: boolean;
}

export interface SessionUserMessage {
  turn: number;
  text: string;
}
export interface SessionAssistantMessage {
  turn: number;
  text: string;
}
export interface SessionThinkingBlock {
  turn: number;
  text: string;
}
export interface SessionMuninnCall {
  turn: number;
  tool: string;
  arguments: Record<string, unknown>;
}
export interface SessionCustomMessage {
  type: string;
  content: string;
}

export interface SessionSignal {
  sessionId: string;
  cwd: string;
  parentSession?: string | null;
  timestamp: string;
  entryCount: number;
  compactionCount: number;
  compactionSummaries: string[];
  userMessages: SessionUserMessage[];
  assistantMessages: SessionAssistantMessage[];
  thinkingBlocks: SessionThinkingBlock[];
  muninnCalls: SessionMuninnCall[];
  customMuninn: SessionCustomMessage[];
}

export interface ActionBase {
  action: string;
}

export interface RememberAction extends ActionBase {
  action: "remember";
  concept: string;
  content: string;
  type?: "fact" | "decision" | "preference" | "issue" | "procedure" | "observation";
  rationale?: string;
  evidence?: string | string[];
  source_turns?: number[];
  tags?: string[];
}

export interface DecideAction extends ActionBase {
  action: "decide";
  decision: string;
  rationale: string;
  alternatives?: string[];
  evidence?: string | string[];
  source_turns?: number[];
  tags?: string[];
}

export interface EvolveAction extends ActionBase {
  action: "evolve";
  id: string;
  new_content: string;
  reason: string;
  evidence?: string | string[];
  source_turns?: number[];
  tags?: string[];
}

export type ParsedAction = RememberAction | DecideAction | EvolveAction;

export type CandidateAction = ParsedAction | Record<string, unknown>;

export interface ValidationRejection {
  action: string;
  reason: string;
  concept?: string;
  decision?: string;
  id?: string;
}

export interface ValidationResult {
  valid: ParsedAction[];
  rejections: ValidationRejection[];
}

export interface ManifestSession {
  path: string;
  lastDreamed?: string;
  entryCount?: number;
  compactionCount?: number;
  parentSession?: string | null;
  mtime?: number;
}

export interface DreamManifest {
  version: number;
  sessions: Record<string, ManifestSession>;
  archived: Record<string, ManifestSession & { archivedAt?: string }>;
}

const DEFAULTS: DreamOptions = {
  vault: DEFAULT_VAULT,
  restUrl: process.env.MUNINN_REST_URL || MUNINN_REST_URL,
  sessionDir: `${process.env.HOME || ""}/.pi/agent/sessions`,
  sessionFile: "",
  dryRun: false,
  extractOnly: false,
  showPrompt: false,
  showCreated: false,
  verbose: false,
};

export async function runDream(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const opt = parseArgs(argv, cwd);
  const manifestPath = join(cwd, ".muninn", "dream-log.json");
  const manifest = await loadManifest(manifestPath);
  const jsonl = await discoverSessionPaths(opt);

  if (jsonl.length === 0) {
    if (opt.sessionFile) {
      console.log(`No JSONL file found at ${opt.sessionFile}`);
    } else {
      console.log(`No JSONL files found in ${opt.sessionDir}`);
    }
    return;
  }

  let processed = 0;
  let createdTotal = 0;

  for (const path of jsonl) {
    try {
      const meta = await stat(path)
        .then((s) => Math.floor(s.mtimeMs))
        .catch(() => 0);
      const sessionId = deriveSessionId(path);
      if (!opt.dryRun && manifest.sessions[sessionId] && (manifest.sessions[sessionId].mtime || 0) === meta) {
        continue;
      }

      const signal = await extractSignal(path);
      console.log(`\n=== Session ${sessionId} ===`);
      console.log(`file=${path}`);
      console.log(
        `entries=${signal.entryCount} users=${signal.userMessages.length} assistants=${signal.assistantMessages.length} compactions=${signal.compactionCount}`,
      );

      if (opt.extractOnly) {
        console.log("extract-only: no synthesis, no memory writes");
        updateManifest(manifest, sessionId, path, signal, meta, opt.sessionDir);
        processed++;
        continue;
      }

      const enrichUrl = process.env.MUNINN_ENRICH_URL || "";
      if (!enrichUrl) {
        console.warn(
          "MUNINN_ENRICH_URL not set; refusing to create raw-copy memories. Use --extract-only for parse-only runs.",
        );
        continue;
      }

      const existing = await recallExisting(signal, opt.restUrl, opt.vault);
      const prompt = buildSynthesisPrompt(signal, existing);

      if (opt.showPrompt) {
        console.log(`\n=== SYNTHESIS PROMPT ===\n${prompt}\n`);
      }

      const [raw, llmError] = await callLlm(enrichUrl, prompt);
      if (llmError) {
        console.warn(`LLM synthesis failed for ${path}: ${llmError}`);
        console.log(`\n=== LLM SYNTHESIS ERROR ===\n${llmError}\n`);
        printSessionSummary(signal, "", [], [], [], 0, opt.dryRun);
        processed++;
        continue;
      }

      const synthesis = raw ?? "";
      console.log(`\n=== RAW SYNTHESIS OUTPUT ===\n${synthesis}`);

      const parsed = parseActions(synthesis);
      const validated = validateActions(parsed, signal);
      const valid = validated.valid;
      const rejections = validated.rejections;
      console.log(`\n=== PARSED ACTIONS ===\n${prettyJson(valid)}`);
      if (rejections.length > 0) {
        console.log(`\n=== VALIDATION REJECTIONS ===\n${prettyJson(rejections)}`);
      }

      let created = 0;
      if (opt.dryRun) {
        console.log("dry-run: no writes");
      } else {
        created = await executeActions(valid, opt.restUrl, opt.vault, opt.showCreated);
        updateManifest(manifest, sessionId, path, signal, meta, opt.sessionDir);
      }

      printSessionSummary(signal, synthesis, parsed, valid, rejections, created, opt.dryRun);
      createdTotal += created;
      processed++;
    } catch (error) {
      console.warn(`Session ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      processed++;
    }
  }

  if (!opt.dryRun) {
    await saveManifest(manifestPath, manifest);
  }

  console.log(`\nProcessed sessions: ${processed}`);
  if (!opt.dryRun) {
    console.log(`Created/updated memories: ${createdTotal}`);
  }
  console.log(`Manifest: ${manifestPath}`);
}

export function parseArgs(argv: string[], cwd: string): DreamOptions {
  const opt: DreamOptions = {
    ...DEFAULTS,
    sessionDir: `${process.env.HOME || ""}/.pi/agent/sessions`,
  };

  if (cwd) {
    opt.vault = DEFAULT_VAULT;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    const next = argv[i + 1];

    if (arg === "--vault" && next) {
      opt.vault = next;
      i++;
    } else if (arg.startsWith("--vault=")) {
      opt.vault = arg.slice("--vault=".length);
    } else if (arg === "--rest-url" && next) {
      opt.restUrl = next;
      i++;
    } else if (arg.startsWith("--rest-url=")) {
      opt.restUrl = arg.slice("--rest-url=".length);
    } else if (arg === "--session-dir" && next) {
      opt.sessionDir = next;
      i++;
    } else if (arg.startsWith("--session-dir=")) {
      opt.sessionDir = arg.slice("--session-dir=".length);
    } else if (arg === "--session-file" && next) {
      opt.sessionFile = next;
      i++;
    } else if (arg.startsWith("--session-file=")) {
      opt.sessionFile = arg.slice("--session-file=".length);
    } else if (arg === "--dry-run") {
      opt.dryRun = true;
    } else if (arg === "--extract-only") {
      opt.extractOnly = true;
    } else if (arg === "--show-prompt") {
      opt.showPrompt = true;
    } else if (arg === "--show-created") {
      opt.showCreated = true;
    } else if (arg === "--verbose") {
      opt.verbose = true;
    } else if (arg === "--with-llm") {
      opt.extractOnly = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return opt;
}

function printUsage(): void {
  console.log(`Usage: muninn-dream [OPTIONS]
  --vault=NAME             Vault name (default: default)
  --rest-url=URL           MuninnDB REST URL (default: http://127.0.0.1:8475)
  --session-dir=PATH       Pi session directory (default: ~/.pi/agent/sessions)
  --dry-run                Run extraction + LLM synthesis, but do not write
  --extract-only           Parse JSONL only; do not call LLM or write memories
  --show-prompt            Print the prompt sent to the synthesis LLM
  --show-created           Print write payloads and REST responses
  --session-file=PATH      Process a single JSONL file instead of scanning a directory
  --verbose                Print extra details
  --help                   Show this help`);
}

async function discoverSessionPaths(opt: DreamOptions): Promise<string[]> {
  if (opt.sessionFile) {
    try {
      await stat(opt.sessionFile);
      return [opt.sessionFile];
    } catch {
      return [];
    }
  }

  const out: string[] = [];
  await walkJsonlFiles(opt.sessionDir, out);
  out.sort();
  return out;
}

async function walkJsonlFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkJsonlFiles(full, out);
    } else if (entry.isFile() && full.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

export async function extractSignal(path: string): Promise<SessionSignal> {
  const signal: SessionSignal = {
    sessionId: "",
    cwd: "",
    parentSession: undefined,
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

  let turn = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    signal.entryCount++;
    const type = typeof entry.type === "string" ? entry.type : "";

    if (type === "session") {
      signal.sessionId = stringValue(entry.id);
      signal.cwd = stringValue(entry.cwd);
      signal.parentSession = entry.parentSession == null ? undefined : String(entry.parentSession);
      signal.timestamp = stringValue(entry.timestamp);
    } else if (type === "compaction") {
      signal.compactionCount++;
      if (typeof entry.summary === "string") signal.compactionSummaries.push(entry.summary);
    } else if (type === "custom_message") {
      const customType = stringValue(entry.customType);
      if (customType.startsWith("muninn")) {
        signal.customMuninn.push({ type: customType, content: stringValue(entry.content) });
      }
    } else if (type === "message") {
      const msg = isRecord(entry.message) ? entry.message : {};
      const role = stringValue(msg.role);
      const texts = extractTextBlocks(msg.content);
      if (role === "user") {
        for (const text of texts) {
          if (text.startsWith("<skill name=")) continue;
          turn++;
          if (text.length > 5) signal.userMessages.push({ turn, text });
        }
      } else if (role === "assistant") {
        for (const text of texts) {
          if (text.length > 5) signal.assistantMessages.push({ turn: turn || 0, text });
        }
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!isRecord(block)) continue;
            const blockType = stringValue(block.type);
            if (blockType === "thinking") {
              const thinking = stringValue(block.thinking);
              if (thinking.length > 20) {
                signal.thinkingBlocks.push({ turn: turn || 0, text: thinking });
              }
            } else if (blockType === "toolCall") {
              const name = stringValue(block.name);
              if (name.startsWith("muninndb_muninn_")) {
                signal.muninnCalls.push({
                  turn: turn || 0,
                  tool: name,
                  arguments: isRecord(block.arguments) ? (block.arguments as Record<string, unknown>) : {},
                });
              }
            }
          }
        }
      }
    }
  }

  return signal;
}

function extractTextBlocks(content: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (stringValue(block.type) !== "text") continue;
      const text = stringValue(block.text).trim();
      if (text) out.push(text);
    }
  } else if (typeof content === "string") {
    const text = content.trim();
    if (text) out.push(text);
  }
  return out;
}

async function recallExisting(
  signal: SessionSignal,
  restUrl: string,
  vault: string,
): Promise<Array<{ id?: string; concept?: string; content?: string }>> {
  const context = signal.userMessages.map((m) => m.text).slice(0, 8);
  if (context.length === 0) return [];
  const res = await postJson(`${trimTrailingSlash(restUrl)}/api/activate?vault=${encodeURIComponent(vault)}`, {
    context,
    limit: 5,
  });
  if (!res.ok) return [];
  try {
    const body = JSON.parse(res.body || "{}") as Record<string, unknown>;
    return Array.isArray(body.activations)
      ? (body.activations as Array<{ id?: string; concept?: string; content?: string }>)
      : [];
  } catch {
    return [];
  }
}

function buildSynthesisPrompt(
  signal: SessionSignal,
  existing: Array<{ id?: string; concept?: string; content?: string }>,
): string {
  const json = prettyJson({
    session: {
      id: signal.sessionId,
      cwd: signal.cwd,
      timestamp: signal.timestamp,
      entryCount: signal.entryCount,
      compactionCount: signal.compactionCount,
    },
    compactionSummaries: trimArray(signal.compactionSummaries, 4, 600),
    userMessages: trimTurns(signal.userMessages, 15, 300),
    assistantMessages: trimTurns(signal.assistantMessages, 15, 400),
    thinkingBlocks: trimTurns(signal.thinkingBlocks, 6, 300),
    muninnCalls: signal.muninnCalls,
    customMuninn: signal.customMuninn,
    existingMemories: trimExistingMemories(existing),
  });

  return `You are muninn-dream, an offline memory synthesizer for Pi coding-agent sessions.

Your task: read the JSON session signal and produce durable MuninnDB memory actions.

Rules:
- DO NOT copy individual user prompts verbatim.
- DO NOT create "Session note 1" / "Session note N" concepts.
- Synthesize durable specifics: what was decided, preferred, learned, fixed, constrained, or discovered to be stable.
- Durable specifics may describe the user, the project, the code, functions, the technology stack, workflows, issues, risks, or decisions.
- If evidence only supports a one-off detail, generalize it into the stable pattern or return [] instead of storing the literal detail.
- Use assistant responses and compaction summaries when available; user text alone is not enough.
- Skip weak, transient, or unclear content. Returning [] is acceptable.
- Prefer updating/evolving existing memories over duplicates when an existing memory is clearly outdated.
- Return at most 4 actions.
- Content should be one or two clear sentences with context and rationale.
- For remember actions, type must be exactly one of: fact, decision, preference, issue, procedure, observation. Use a concrete type like "observation" if unsure.

Return ONLY a JSON array. Valid actions:
[
  {"action":"remember","concept":"short durable label","content":"synthesized memory","type":"observation","rationale":"why save this","evidence":"why it is durable","source_turns":[1,2],"tags":["dream"]},
  {"action":"decide","decision":"decision made","rationale":"why","alternatives":["optional"]},
  {"action":"evolve","id":"existing-memory-id","new_content":"updated content","reason":"why it changed"}
]

Good examples are durable patterns like:
- user has recurring commitments or routines
- project uses specific technologies or architecture choices
- a function validates/transforms/loads some stable data flow
- the workflow prefers zero writes over low-quality memories

Illustrative examples (not exhaustive):
[
  {"action":"remember","concept":"User has recurring commitments","content":"The session suggests the user deals with recurring commitments or routines, so future replies should favor stable patterns over one-off reminders.","type":"observation","rationale":"This is a durable pattern, not a literal reminder.","evidence":"Seen across multiple turns in the session arc.","source_turns":[9,12],"tags":["dream"]},
  {"action":"remember","concept":"Project uses stable stack","content":"The work appears to rely on a stable technology stack and containerized environment, so future summaries should preserve project-level facts and architecture choices.","type":"fact","rationale":"This is a durable project fact category.","evidence":"Confirmed by the current testing and setup flow.","source_turns":[1,2],"tags":["dream"]},
  {"action":"remember","concept":"muninn-dream abstracts durable specifics","content":"The script should capture stable user, project, and function facts rather than raw transcript details or one-off lists.","type":"observation","rationale":"This describes the intended memory abstraction policy.","evidence":"Repeatedly clarified in this session.","source_turns":[1,2,3],"tags":["dream"]},
  {"action":"decide","decision":"Prefer durable abstractions over literal reminders","rationale":"This keeps the memory stream focused on reusable facts rather than one-off details.","alternatives":["Store raw times and lists"],"evidence":"The user clarified that stable meaning matters more than literal specifics.","source_turns":[1,2,3],"tags":["dream"]}
]

Bad examples are literal reminders, exact times, grocery item lists, raw prompt copies, and placeholder text.

SESSION_SIGNAL_JSON:
${json}`;
}

async function callLlm(enrichUrl: string, prompt: string): Promise<[string | undefined, string | undefined]> {
  const match = enrichUrl.match(/^ollama:\/\/([^/]+)\/(.+)$/);
  if (!match) return [undefined, `unsupported MUNINN_ENRICH_URL: ${enrichUrl}`];
  const [, host, model] = match;
  const url = `http://${host}/api/chat`;
  const body = {
    model,
    stream: false,
    messages: [
      { role: "system", content: "You output only valid JSON arrays for memory synthesis." },
      { role: "user", content: prompt },
    ],
    options: { temperature: 0.1 },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await postJson(url, body);
    if (!res.ok) {
      if (attempt < 3) await sleep((attempt - 1) * 1000);
      continue;
    }
    try {
      const parsed = JSON.parse(res.body || "{}");
      if (
        parsed &&
        typeof parsed === "object" &&
        isRecord(parsed.message) &&
        typeof parsed.message.content === "string"
      ) {
        return [parsed.message.content as string, undefined];
      }
      if (typeof parsed?.message?.content === "string") {
        return [parsed.message.content as string, undefined];
      }
      return [res.body, undefined];
    } catch {
      if (attempt < 3) await sleep((attempt - 1) * 1000);
    }
  }

  return [undefined, "LLM synthesis failed after 3 attempts"];
}

function parseActions(raw: string): CandidateAction[] {
  const text = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? (arr as CandidateAction[]) : [];
  } catch {
    return [];
  }
}

export function validateActions(actions: CandidateAction[], signal: SessionSignal): ValidationResult {
  const rawUser = new Set(signal.userMessages.map((m) => m.text));
  const valid: ParsedAction[] = [];
  const rejections: ValidationRejection[] = [];

  for (const a of actions) {
    if (!isRecord(a)) {
      rejections.push({ action: "unknown", reason: "unsupported action" });
      continue;
    }
    const action = stringValue(a.action);
    if (action === "remember") {
      const concept = stringValue(a.concept);
      const content = stringValue(a.content);
      if (!concept || !content) {
        rejections.push({ action, reason: "missing concept/content" });
        continue;
      }
      if (/^Session note\b/i.test(concept)) {
        rejections.push({ action, concept, reason: "Session note concept" });
        continue;
      }
      if (
        /short durable label|synthesized memory|existing-memory-id|save this for future reference/i.test(concept) ||
        /short durable label|synthesized memory|existing-memory-id|save this for future reference/i.test(content)
      ) {
        rejections.push({ action, concept, reason: "placeholder text" });
        continue;
      }
      if (rawUser.has(content)) {
        rejections.push({ action, concept, reason: "raw user prompt copy" });
        continue;
      }
      if (content.length < 40) {
        rejections.push({ action, concept, reason: "content too short" });
        continue;
      }
      const allowed = new Set(["fact", "decision", "preference", "issue", "procedure", "observation"]);
      const type = stringValue(a.type) || "observation";
      if (!allowed.has(type)) {
        rejections.push({ action, concept, reason: "invalid type" });
        continue;
      }
      const remember: RememberAction = {
        action: "remember",
        concept,
        content,
        type: type as RememberAction["type"],
        rationale: stringValue(a.rationale) || undefined,
        evidence: normalizeEvidence(a.evidence),
        source_turns: normalizeTurns(a.source_turns),
        tags: normalizeTags(a.tags),
      };
      if (!remember.tags) remember.tags = ["dream"];
      valid.push(remember);
    } else if (action === "decide") {
      const decision = stringValue(a.decision);
      const rationale = stringValue(a.rationale);
      if (!decision || !rationale) {
        rejections.push({ action, reason: "missing decision/rationale" });
        continue;
      }
      if (
        /^(project uses|user has|this work is|the session suggests|this is a stable)/i.test(decision) ||
        /\b(decision made|simple memory helper|simple task|for now|updated content)\b/i.test(decision) ||
        /\b(consider the options and alternatives|minimal effort|save this for future reference)\b/i.test(rationale)
      ) {
        rejections.push({ action, decision, reason: "generic decision" });
        continue;
      }
      const decide: DecideAction = {
        action: "decide",
        decision,
        rationale,
        alternatives: normalizeStrings(a.alternatives),
        evidence: normalizeEvidence(a.evidence),
        source_turns: normalizeTurns(a.source_turns),
        tags: normalizeTags(a.tags),
      };
      valid.push(decide);
    } else if (action === "evolve") {
      const id = stringValue(a.id);
      const newContent = stringValue(a.new_content);
      const reason = stringValue(a.reason);
      if (!id || !newContent || !reason) {
        rejections.push({ action, reason: "missing id/new_content/reason" });
        continue;
      }
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id) || id === "existing-memory-id") {
        rejections.push({ action, id, reason: "invalid id" });
        continue;
      }
      if (rawUser.has(newContent)) {
        rejections.push({ action, id, reason: "raw user prompt copy" });
        continue;
      }
      const evolve: EvolveAction = {
        action: "evolve",
        id,
        new_content: newContent,
        reason,
        evidence: normalizeEvidence(a.evidence),
        source_turns: normalizeTurns(a.source_turns),
        tags: normalizeTags(a.tags),
      };
      valid.push(evolve);
    } else {
      rejections.push({ action: action || "unknown", reason: "unsupported action" });
    }
  }

  return { valid, rejections };
}

async function executeActions(
  actions: ParsedAction[],
  restUrl: string,
  vault: string,
  showCreated: boolean,
): Promise<number> {
  const engrams: Array<Record<string, unknown>> = [];
  let count = 0;

  for (const action of actions) {
    if (action.action === "remember") {
      pushEngrams(engrams, {
        concept: action.concept,
        content: action.content,
        type: action.type ?? "observation",
        tags: action.tags ?? ["dream"],
      });
    } else if (action.action === "decide") {
      pushEngrams(engrams, {
        concept: `Decision: ${action.decision}`,
        content: `${action.decision}\nRationale: ${action.rationale}`,
        type: "decision",
        tags: ["dream", "decision"],
      });
    } else if (action.action === "evolve") {
      const res = await postJson(
        `${trimTrailingSlash(restUrl)}/api/engrams/${encodeURIComponent(action.id)}/evolve?vault=${encodeURIComponent(vault)}`,
        { content: action.new_content, reason: action.reason },
      );
      if (showCreated && res.ok) {
        console.log(`\n=== EVOLVE RESPONSE ${action.id} ===\n${res.body}`);
      }
      if (!res.ok) {
        console.warn(`Evolve failed for ${action.id}: ${res.error}`);
      } else {
        count++;
      }
    }
  }

  if (engrams.length > 0) {
    if (showCreated) console.log(`\n=== WRITE PAYLOAD ===\n${prettyJson(engrams)}`);
    const res = await postJson(`${trimTrailingSlash(restUrl)}/api/engrams/batch?vault=${encodeURIComponent(vault)}`, {
      engrams,
    });
    if (res.ok) {
      count += engrams.length;
      if (showCreated) console.log(`\n=== WRITE RESPONSE ===\n${res.body}`);
    } else {
      console.warn(`Batch write failed: ${res.error}`);
    }
  }

  return count;
}

function printSessionSummary(
  signal: SessionSignal,
  raw: string,
  parsedActions: CandidateAction[],
  valid: ParsedAction[],
  rejections: ValidationRejection[],
  created: number,
  dryRun: boolean,
): void {
  const counts = { remember: 0, decide: 0, evolve: 0 };
  for (const action of valid) counts[action.action]++;

  console.log("\n=== SESSION SUMMARY ===");
  console.log(`session=${signal.sessionId}`);
  console.log(
    `entries=${signal.entryCount} users=${signal.userMessages.length} assistants=${signal.assistantMessages.length} compactions=${signal.compactionCount}`,
  );
  console.log(
    `raw_synthesis_chars=${raw.length} parsed_actions=${parsedActions.length} valid_actions=${valid.length} rejected_actions=${rejections.length}`,
  );
  console.log(
    `remember=${counts.remember} decide=${counts.decide} evolve=${counts.evolve} created=${created} dry_run=${dryRun ? "yes" : "no"}`,
  );
}

async function loadManifest(path: string): Promise<DreamManifest> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as DreamManifest;
    if (parsed && typeof parsed === "object" && typeof parsed.version === "number") return parsed;
    console.warn(`Manifest at ${path} has invalid structure; starting fresh.`);
  } catch {
    // manifest does not exist yet — starting fresh
  }
  return { version: 1, sessions: {}, archived: {} };
}

async function saveManifest(path: string, manifest: DreamManifest): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmp, path);
}

function updateManifest(
  manifest: DreamManifest,
  sessionId: string,
  path: string,
  signal: SessionSignal,
  mtime: number,
  sessionDir: string,
): void {
  manifest.sessions[sessionId] = {
    path: relPath(path, sessionDir),
    lastDreamed: isoNow(),
    entryCount: signal.entryCount,
    compactionCount: signal.compactionCount,
    parentSession: signal.parentSession ?? null,
    mtime,
  };
}

function deriveSessionId(path: string): string {
  const match = path.match(/_([0-9a-zA-Z-]{12,})\.jsonl$/);
  return match?.[1] || path;
}

function relPath(path: string, base: string): string {
  const prefix = base.replace(/\/+$/, "");
  return path.startsWith(prefix) ? path.slice(prefix.length).replace(/^\/?/, "") : path;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function postJson(url: string, payload: unknown): Promise<{ ok: boolean; body: string; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, body: text, error: `${res.status} ${res.statusText} ${text}` };
    return { ok: true, body: text };
  } catch (error) {
    return { ok: false, body: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function trimArray(arr: string[], max: number, chars: number): string[] {
  return arr.slice(0, max).map((x) => (x.length > chars ? x.slice(0, chars) : x));
}

function trimTurns<T extends { text: string }>(arr: T[], max: number, chars: number): T[] {
  return arr
    .slice(0, max)
    .map((item) => ({ ...item, text: item.text.length > chars ? item.text.slice(0, chars) : item.text }));
}

function trimExistingMemories(
  existing: Array<{ id?: string; concept?: string; content?: string }>,
): Array<{ id?: string; concept?: string; content?: string }> {
  const out: Array<{ id?: string; concept?: string; content?: string }> = [];
  for (const mem of existing) {
    if (typeof mem.concept === "string" && /^Session note\b/i.test(mem.concept)) continue;
    out.push({
      id: mem.id,
      concept: mem.concept,
      content: mem.content ? (mem.content.length > 350 ? mem.content.slice(0, 350) : mem.content) : mem.content,
    });
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeEvidence(value: unknown): string | string[] | undefined {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeTurns(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns = value.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  return turns.length > 0 ? turns : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.map((v) => String(v)).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function normalizeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((v) => String(v)).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 3);
}

function pushEngrams(engrams: Array<Record<string, unknown>>, item: Record<string, unknown>): void {
  engrams.push(item);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runDream().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

export default runDream;
