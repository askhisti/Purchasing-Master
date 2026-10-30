# Architecture

## Flow

1. A cloud task (environment `purchasing-master`, 07:00 Europe/Berlin) runs the `nightly-refresh` skill with the Snowflake connector only.
2. The skill drives `refresh/cli.mjs` (`begin`, `next` loop, `finish` / `fail`). The CLI hands out one SQL at a time; the skill runs it through the connector and runs no other Snowflake query.
3. A PostToolUse hook (`.claude/settings.json` -> `node "$CLAUDE_PROJECT_DIR/refresh/capture-hook.mjs"`) saves each connector result under `runs/<runId>/captures/` while `runs/CURRENT` exists. The hook finds the repo from `CLAUDE_PROJECT_DIR`, else from the hook input's `cwd`. The model never sees or copies rows.
4. `next` compares the captured SQL with the pending SQL (whitespace-normalised), parses the result, and plans the next query: health check, then per feed a count query and keyset pages.
   - Paging: the first page of every feed asks for `pageLimit` (500) rows; each full page sizes the next one to about `targetPageChars` (250000, top level of `sql/feeds.json`) characters, clamped to 100..20000. A truncated page (fewer rows than `numRows`) is re-asked with the same key and limit `max(100, floor(rows that fit * 0.8))`.
   - A result that cannot be parsed aborts with `unrecognized connector result: <first 200 characters, newlines collapsed>`.
5. `finish` re-reads the captures, shapes the rows, and POSTs them to the Apps Script web app (`begin`, `chunk`, `commit`).
6. The web app writes the MasterData tabs, a Raw snapshots CSV per feed, and `_Refresh_Log`.
7. A daily time-driven trigger (10:00 Europe/Berlin) runs `checkDailyRefresh` and logs `NO_REFRESH` when no run succeeded that day (R37).

## Files

| Path | Responsibility |
|---|---|
| `.claude/skills/nightly-refresh/SKILL.md` | Rules for the cloud run (drive the CLI, no editing of SQL, no row handling, no other Snowflake query) |
| `.claude/settings.json` | Registers the capture hook |
| `refresh/capture-hook.mjs` | Saves connector results while a run is active |
| `refresh/cli.mjs` | Commands `begin`, `next`, `finish`, `fail`; run state machine |
| `refresh/lib/manifest.mjs`, `sql/feeds.json` | Feed definitions: tab, columns, types, first page limit; `targetPageChars` |
| `refresh/lib/sql.mjs`, `sql/health.sql`, `sql/feeds/*.sql` | SQL rendering, count and keyset page queries, page sizing |
| `refresh/lib/result.mjs` | Parses connector results |
| `refresh/lib/shape.mjs` | Converts raw rows to typed sheet rows |
| `refresh/lib/push.mjs` | Chunking (gzip + base64) and HTTP POST with retry |
| `refresh/lib/state.mjs` | Run id, state file, capture lookup |
| `apps-script/MasterData/Config.ts` | Constants (token property, folder name, row-drop limit, log sheet, time zone, locale, watchdog hour) |
| `apps-script/MasterData/WebApp.ts` | `doPost`: token check, script lock, actions |
| `apps-script/MasterData/Sheets.ts` | Staging tabs, swap into live tabs, `_Refresh_Log`, log times, locale, default-sheet cleanup |
| `apps-script/MasterData/Store.ts`, `Core.ts` | Run storage and shared helpers |
| `apps-script/MasterData/Watchdog.ts` | `checkDailyRefresh` and `installDailyWatchdogTrigger` (R37) |
| `scripts/release-gas.mjs`, `scripts/release-config.json` | Release: tests, clasp push, version, deploy to the fixed deployment |
| `docs/sheets.md` | Tab and header contract |

## Protocol (web app actions)

All requests are JSON POSTs with `token`.
- `begin`: `runId`, `startedAt` (ISO, the CLI run start), `baseYear`, per-feed `{feed, tab, headers, types, rowCount}`, `health`. Sets the spreadsheet locale to `en_US` if it differs. If another run is active (different `runId`) it is logged as `ABANDONED` (`replaced by <runId>`) and its leftovers are removed.
- `chunk`: `runId`, `feed`, increasing `seq`, `rowsB64Gzip`.
- `commit`: validates everything, then swaps staging into live tabs. May return a `warning`. After the swap an empty default `Sheet1` / `Tabelle1` is deleted. A rejected commit (`{ok:false}`) has already been discarded and logged `FAILED` by the server, so the CLI posts no `fail` for it (R35), except for `not the active run`.
- `fail`: `runId`, `reason`. Always logged; cleans up if it is the active run.

## `_Refresh_Log`

- `B1` (last successful refresh) is an ISO UTC timestamp; `B2` the base year.
- Rows from row 5, newest first: Run ID, Started, Finished, Feed, Rows, Source Refreshed At, Status, Message. Started and Finished are Europe/Berlin `yyyy-MM-dd HH:mm:ss` (R36); Started is the CLI run start sent in `begin`.
- Status values: `OK`, `FAILED`, `ABANDONED` (replaced by a later `begin`), `NO_REFRESH` (watchdog: `B1` missing or not today's Berlin date).

## Safety rules

- Everything that can reject a run happens before any live tab is touched.
- Staging tabs are swapped into the live tabs while keeping live tab identity (sheet ids and references stay valid).
- Row-drop guard: a feed whose row count falls more than 20% (`MAX_ROW_DROP`) below the previous run is rejected.
- Every action (and the watchdog) runs under the script lock; begin/chunk/commit/fail never interleave.
- Health check (`sql/health.sql`) must report zero problems, else the run aborts before fetching. It blocks on `PLATFORM_HEALTH` rows with `IS_PROBLEM` where `AREA = 'MECL_SNAPSHOT'` or `OBJECT_NAME` is `TASK_REFRESH_PURCHASING`, `TASK_REFRESH_SUPPLY_CHAIN` or `TASK_REFRESH_PLATFORM_HEALTH` (R34); `PROBLEM_LIST` entries read `AREA/OBJECT_NAME:STATUS`.
- Duplicate `ROW_KEY`, count mismatch, or a truncated page at minimum size abort the run.
- If the `commit` request ends in a transient error the outcome is unknown: the CLI reports `FAILED commit status unknown` and the run state is `unknown`; check `_Refresh_Log` before retrying.
- The skill must not edit repo files or commit.
