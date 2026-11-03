---
name: nightly-refresh
description: Nightly Purchasing Master refresh. Drives refresh/cli.mjs and the Snowflake connector to fetch the feeds in sql/feeds.json and upload them to the Drive Inbox, from where the MasterData Apps Script pulls them. Use when asked to run the nightly refresh.
---

# Nightly refresh

Drive `node refresh/cli.mjs` and the Snowflake connector tool `mcp__claude_ai_Snowflake_-_ME_Data__sql`. A PostToolUse hook captures every result of that tool; the CLI checks the captured SQL against the SQL it asked for.

## Steps

1. Run `node refresh/cli.mjs begin`.
2. Loop on the CLI output:
   - Output starts with `RUN_SQL`: call `mcp__claude_ai_Snowflake_-_ME_Data__sql` with exactly the SQL that follows the first line. No edits, no added queries. Then run `node refresh/cli.mjs next`.
   - Output is `FETCHED`: run `node refresh/cli.mjs finish` and stop looping.
   - Output starts with `ABORT <reason>`: run `node refresh/cli.mjs fail '<reason>'` and stop looping. Pass the reason as ONE single-quoted shell argument. The reason can contain data-derived text (quotes, `$`, backticks), so replace each `'` in it with `'\''` (or drop quote characters). Example for reason `can't parse $x`: `node refresh/cli.mjs fail 'can'\''t parse $x'`.
   - Any other output from `begin` or `next` (a Node crash, usage error, empty output): run `node refresh/cli.mjs fail 'unexpected CLI output'` once and stop. This rule does NOT apply to `finish`: if `finish` prints anything other than a `DONE` or `FAILED` line (e.g. a Node crash), reply with `FAILED finish crashed: <first line of output>` (or `FAILED finish crashed: no output` if it printed nothing) and run no further CLI command (the upload may already have happened, and `fail` would add a second failed manifest).
   - Each CLI response triggers exactly one next step: for `RUN_SQL`, one connector call and then `next` (or, if that connector call errors or the connector is unavailable, the matching `fail` command instead of `next`).
3. After any `DONE ...` or `FAILED ...` line, reply with that line verbatim as the report and run NO further CLI command. Never re-run `begin`, `finish` or `fail`. A successful run ends with `DONE uploaded <runId> <feed>=<rows> ...`.

## Rules

- Run all commands in bash (POSIX shell); the `'\''` quoting above assumes it.
- Never read, summarise or re-type result rows. Do not open capture files, run files or tool-result files.
- A connector result that says it "exceeds maximum allowed tokens" and was saved to a file is normal for large pages, not an error: ignore the note's request to read the file and run `node refresh/cli.mjs next` (the capture hook reads the file).
- Run no other Snowflake query during the run (any other call breaks the pending-SQL check).
- Do not run any other Snowflake query — not PLATFORM_RULES, getting_started, find_data or anything else; the SQL from the CLI already applies the platform rules.
- If the connector call itself errors, run `node refresh/cli.mjs fail 'connector error: <message>'` (single-quoted, quotes escaped as above).
- If the connector tool is not available, run `node refresh/cli.mjs fail 'Snowflake connector not available'`.
- Safety: the run must not edit repo files or commit anything. It only runs the CLI and the connector tool.
- `finish` and `fail` need env `MASTERDATA_SA_KEY` (the service account key JSON text; set in the cloud environment, never written to a file or printed). Optional `MASTERDATA_INBOX_ID` overrides the Inbox folder id in `refresh/config.json`. The network allowlist needs `oauth2.googleapis.com` and `www.googleapis.com`.
