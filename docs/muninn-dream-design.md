# Muninn-Dream Design

## Overview

`muninn-dream` is a TypeScript-based CLI for Pi session replay and memory synthesis. It reads Pi JSONL logs, extracts durable signals, asks an LLM to synthesize stable memories, validates the result, and writes acceptable memories to MuninnDB.

The goal is not transcript copying. The goal is to capture durable specifics: user routines, project facts, code/function behavior, technologies, workflows, constraints, issues, decisions, and other stable patterns that help future sessions.

## Durable Specifics / Abstraction Policy

Muninn-dream should preserve stable meaning, not literal detail.

Good candidates:
- recurring user routines or preferences
- project/repo facts and architecture choices
- technologies, dependencies, runtime constraints
- what a function or module does
- workflows, procedures, risks, blockers, and decisions
- newly discovered stable specifics not pre-enumerated by the prompt author

If the evidence only supports a one-off detail, either generalize it into the stable pattern or return `[]`.

Bad candidates:
- raw transcript copies
- exact appointment times or grocery lists
- placeholder text
- weak, generic, or speculative memories

## Pipeline

1. Parse CLI args and load env from `~/.muninn/muninn.env`
2. Resolve vault name
3. Load `.muninn/dream-log.json`
4. Locate JSONL sessions for the cwd or use `--session-file`
5. Extract session signal:
   - session header
   - user messages
   - assistant messages
   - thinking blocks
   - compaction summaries
   - custom Muninn messages
   - Muninn MCP tool calls
6. Recall overlapping memories from MuninnDB
7. Build a synthesis prompt
8. Call the configured LLM backend
9. Print raw synthesis output for visibility
10. Parse and validate actions
11. Write valid actions through MuninnDB REST unless `--dry-run`
12. Print a compact summary and update the manifest

## Integration

The Pi slash command `/muninn-dream` should invoke the bundled CLI binary from this package. The extension command is a user-facing wrapper; the TypeScript CLI is the actual processor.

## MuninnDB Compatibility

The written memories should be useful to MuninnDB enrichment:
- name stable entities clearly
- keep each memory atomic
- prefer facts/decisions/observations over raw lists
- link or evolve memories when new evidence changes earlier statements

## Acceptable Output

A successful dry run can still yield zero writes if the evidence is weak. That is a valid result.

A useful dry run should also show:
- raw synthesis output
- parsed actions
- validation rejections
- the final set of candidate memories that would be written
