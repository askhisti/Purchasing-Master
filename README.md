# Purchasing Master

Nightly job: a scheduled Claude session queries Snowflake through the MCP connector
(`mcp__claude_ai_Snowflake_-_ME_Data__sql`). A PostToolUse hook (`refresh/capture-hook.mjs`)
saves every result verbatim to `runs/<runId>/captures/<NNNN>.json` so Node scripts can process it.

- The hook is active only while `runs/CURRENT` exists (contains the run id).
- `npm test` runs the Node test suite; `npm run validate` type-checks the Apps Script sources.

Design: `docs/superpowers/specs/2026-10-30-purchasing-master-design.md`.
