---
name: nightly-refresh
description: Nightly Purchasing Master refresh. Drives refresh/cli.mjs and the Snowflake connector to fetch the six feeds and push them to the MasterData sheet. Use when asked to run the nightly refresh.
---

# Nightly refresh

Drive `node refresh/cli.mjs` and the Snowflake connector tool `mcp__claude_ai_Snowflake_-_ME_Data__sql`. A PostToolUse hook captures every result of that tool; the CLI checks the captured SQL against the SQL it asked for.

## Steps

1. Run `node refresh/cli.mjs begin`.
2. Loop on the CLI output:
   - Output starts with `RUN_SQL`: call `mcp__claude_ai_Snowflake_-_ME_Data__sql` with exactly the SQL that follows the first line. No edits, no added queries. Then run `node refresh/cli.mjs next`.
   - Output is `FETCHED`: run `node refresh/cli.mjs finish` and stop looping.
   - Output starts with `ABORT <reason>`: run `node refresh/cli.mjs fail "<reason>"` and stop looping.
3. Reply with the final CLI line (`DONE ...` or `FAILED ...`) as the report, nothing else.

## Rules

- Never read, summarise or re-type result rows. Do not open capture files, run files or tool-result files.
- Run no other Snowflake query during the run (any other call breaks the pending-SQL check).
- If the connector call itself errors, run `node refresh/cli.mjs fail "connector error: <message>"`.
- If the connector tool is not available, run `node refresh/cli.mjs fail "Snowflake connector not available"`.
- Safety: the run must not edit repo files or commit anything. It only runs the CLI and the connector tool.
- `finish` and `fail` need env `MASTERDATA_WEBAPP_URL` and `MASTERDATA_TOKEN` (set in the cloud environment).
