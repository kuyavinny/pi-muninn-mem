# muninn-dream CLI Design

## Overview

`muninn-dream` is a standalone TypeScript CLI that reads Pi session JSONL files, synthesizes deliberate memory candidates from the full session signal, and writes those candidates to MuninnDB.

It uses only Node built-ins at runtime. Practical minimum: Node 18+ (for native `fetch`). No CPAN, no npm runtime dependencies, and no wrapper script are required.

Important: `muninn-dream` must not copy raw user prompts into `Session note N` memories. Raw extraction is only an intermediate signal. The default real run is synthesis-first: parse JSONL → ask the LLM to deliberate over durable specifics in the session arc → show the proposed actions → write the synthesized memories.

Durable specifics can describe user routines, project facts, function behavior, technologies, workflows, constraints, issues, and decisions — not just literal reminders.

## CLI Interface

```
Usage: muninn-dream [OPTIONS]

Options:
  --vault=NAME         Vault name (default: default)
  --rest-url=URL       MuninnDB REST URL (default: http://127.0.0.1:8475)
  --session-dir=PATH   Pi session directory (default: ~/.pi/agent/sessions)
  --session-file=PATH  Process a single JSONL file instead of scanning a directory
  --dry-run            Show extraction + synthesis output without saving
  --extract-only       Parse JSONL and update/preview manifest without LLM synthesis
  --show-prompt        Print the synthesis prompt sent to the LLM
  --show-created       Print created engram content after writes
  --verbose            Print detailed extraction info
  --with-llm          Compatibility no-op (kept for older runs)
  --help               Show this help
```

## Execution Flow

1. Parse CLI args, load env from `~/.muninn/muninn.env`
2. Resolve vault name
3. Load `./.muninn/dream-log.json`
4. Find JSONL files for the cwd, or use `--session-file`
5. For each unprocessed session:
   - parse JSONL into a `SessionSignal`
   - query MuninnDB for overlapping memories
   - build a synthesis prompt from the full session signal
   - call the LLM
   - parse candidate actions from JSON
   - validate them against the conservative memory policy
   - write accepted actions to MuninnDB unless `--dry-run`

## Validation Rules

The validator should reject:
- raw prompt copies
- placeholder concepts or content
- obvious self-referential boilerplate
- invalid action types
- obviously non-durable session-note style entries

The validator should prefer zero writes over low-quality writes.

## Extension Integration

The Pi extension registers `/muninn-dream` as a slash command and launches the bundled CLI binary with the current vault and working directory.

This keeps the user-facing entrypoint simple while leaving the actual session parsing and memory synthesis in the standalone TypeScript CLI.
