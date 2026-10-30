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
   - Output starts with `ABORT <reason>`: run `node refresh/cli.mjs fail '<reason>'` and stop looping. Pass the reason as ONE single-quoted shell argument. The reason can contain data-derived text (quotes, `$`, backticks), so replace each `'` in it with `'\''` (or drop quote characters). Example for reason `can't parse $x`: `node refresh/cli.mjs fail 'can'\''t parse $x'`.
   - Any other output from `begin` or `next` (a Node crash, usage error, empty output): run `node refresh/cli.mjs fail 'unexpected CLI output'` once and stop. This rule does NOT apply to `finish`: if `finish` prints anything other than a `DONE` or `FAILED` line (e.g. a Node crash), reply with `FAILED finish crashed — check _Refresh_Log: <first line of output>` and run no further CLI command (the commit may already have happened, and `fail` would write a false FAILED log row).
   - Each CLI response triggers at most one action. An action is one CLI command; a `RUN_SQL` response means one connector call followed by `node refresh/cli.mjs next`.
3. After any `DONE ...` or `FAILED ...` line, reply with that line verbatim as the report and run NO further CLI command. Never re-run `begin`, `finish` or `fail`. In particular `FAILED commit status unknown — check _Refresh_Log` must not be retried: a retry could duplicate a run.

## Rules

- Run all commands in bash (POSIX shell); the `'''` quoting below assumes it.
- Never read, summarise or re-type result rows. Do not open capture files, run files or tool-result files.
- Run no other Snowflake query during the run (any other call breaks the pending-SQL check).
- If the connector call itself errors, run `node refresh/cli.mjs fail 'connector error: <message>'` (single-quoted, quotes escaped as above).
- If the connector tool is not available, run `node refresh/cli.mjs fail 'Snowflake connector not available'`.
- Safety: the run must not edit repo files or commit anything. It only runs the CLI and the connector tool.
- `finish` and `fail` need env `MASTERDATA_WEBAPP_URL` and `MASTERDATA_TOKEN` (set in the cloud environment).
