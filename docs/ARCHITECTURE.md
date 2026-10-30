# Architecture

## Flow

1. A cloud task (environment `purchasing-master`, 06:15 Europe/Berlin, after the ~05:45 Snowflake refresh) runs the `nightly-refresh` skill with the Snowflake connector only.
2. The skill drives `refresh/cli.mjs` (`begin`, `next` loop, `finish` / `fail`). The CLI hands out one SQL at a time; the skill runs it through the connector and runs no other Snowflake query.
3. A PostToolUse hook (`.claude/settings.json` -> `node "$CLAUDE_PROJECT_DIR/refresh/capture-hook.mjs"`) saves each connector result under `runs/<runId>/captures/` while `runs/CURRENT` exists. The hook finds the repo from `CLAUDE_PROJECT_DIR`, else from the hook input's `cwd`. The model never sees or copies rows.
4. `next` compares the captured SQL with the pending SQL (whitespace-normalised), parses the result, and plans the next query: health check, then per feed a count query and keyset pages.
   - Paging: the first page of every feed asks for `pageLimit` (500) rows; each full page sizes the next one to about `targetPageChars` (250000, top level of `sql/feeds.json`) characters, clamped to 100..20000. A truncated page (fewer rows than `numRows`) is re-asked with the same key and limit `max(100, floor(rows that fit * 0.8))`.
   - A result that cannot be parsed aborts with `unrecognized connector result: <first 200 characters, newlines collapsed>`.
5. `finish` re-reads the captures, verifies and shapes the rows, and uploads them into the Drive Inbox (a folder in the company shared drive) with the service account `masterdata-uploader`: one `<runId>__<feed>.json.gz` per feed, then `<runId>__manifest.json` last (its presence means the run's files are complete). A failed run uploads only a `failed` manifest (`feeds: []`, with `reason`). The state ends as `uploaded` or `failed`.
6. MasterData's bound Apps Script polls the Inbox every 15 minutes (`pollInbox`, see "Inbox puller") and runs the same begin -> chunk -> commit logic as the web app internally: staging tabs, validation, row-drop guard, swap into the live tabs, a Raw snapshots CSV per feed, `_Refresh_Log`. It then trashes the run's Inbox files.
7. A daily time-driven trigger (08:15 Europe/Berlin; Apps Script fires it within 15 minutes of that) runs `checkDailyRefresh` and logs `NO_REFRESH` when no run succeeded that day (R37, R43).

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
| `refresh/lib/google-auth.mjs` | Service account JWT (RS256, `node:crypto`) exchanged for an access token |
| `refresh/lib/inbox.mjs` | Builds the Inbox files (gz data + manifest) and uploads them with multipart Drive requests, retrying network errors and 5xx |
| `refresh/config.json` | `inboxFolderId` (override: env `MASTERDATA_INBOX_ID`) |
| `refresh/lib/state.mjs` | Run id, state file, capture lookup |
| `apps-script/MasterData/Config.ts` | Constants (token property, folder ids incl. `INBOX_FOLDER_ID`, row-drop limit, log sheet, time zone, locale, watchdog time, puller slice size and time budget) |
| `apps-script/MasterData/WebApp.ts` | `doPost`: token check, script lock, actions; the begin/chunk/commit/fail handlers the puller also uses |
| `apps-script/MasterData/Puller.ts` | `pollInbox` (Inbox puller) and `installPullTrigger` |
| `apps-script/MasterData/Sheets.ts` | Staging tabs, swap into live tabs, `_Refresh_Log`, log times, locale, default-sheet cleanup |
| `apps-script/MasterData/Store.ts`, `Core.ts` | Run storage and shared helpers |
| `apps-script/MasterData/Watchdog.ts` | `checkDailyRefresh` and `installDailyWatchdogTrigger` (R37, 08:15) |
| `scripts/release-gas.mjs`, `scripts/release-config.json` | Release: tests, clasp push, version, deploy to the fixed deployment |
| `docs/sheets.md` | Tab and header contract |

## Environment and network

- `MASTERDATA_SA_KEY`: the service account key JSON text (never written to disk, logged or committed). Missing or not a service account key: `finish` refuses and keeps `runs/CURRENT`.
- `MASTERDATA_INBOX_ID` (optional): Inbox folder id, default from `refresh/config.json`.
- Network allowlist for the cloud environment: `oauth2.googleapis.com`, `www.googleapis.com` (plus the Snowflake connector). Every Drive call passes `supportsAllDrives=true`; a data file is limited to 5 MB (multipart upload).

## Inbox puller (`pollInbox`, Apps Script)

Time-driven every 15 minutes (`installPullTrigger`). Constants in `Config.ts`: `INBOX_FOLDER_ID`, `PULL_SLICE_ROWS` (4000), `PULL_BUDGET_MS` (270 s), `INBOX_ORPHAN_DAYS` (3).

- Takes the script lock with `tryLock(5000)`; when another execution holds it, the poll exits quietly.
- Lists the Inbox (trashed files skipped). Files named `<runId>__<name>` are grouped by runId.
- Files older than 3 days that belong to no manifest (no `<runId>__manifest.json`, or no valid runId prefix) are trashed. Younger ones stay (an upload may be in progress).
- Script Property `LAST_PROCESSED_RUN` holds the runId of the last run that ended (committed or failed). Manifests with a runId up to it are never processed again; their leftover files are trashed. Of the newer manifests the oldest is processed (runIds sort chronologically), one run per poll.
- A runId more than a day ahead of the clock is logged `FAILED` (`runId is in the future`) and its files are trashed, without moving `LAST_PROCESSED_RUN`.
- Manifest copies (Drive create retries are not idempotent, R46): if any copy is `failed`, the failed one wins; unreadable or differing ready copies fail the run.
- `failed` manifest: the fail action logs one `FAILED` row with the manifest's `reason` (Started = manifest `startedAt`); `LAST_PROCESSED_RUN` is set and every `<runId>__*` file is trashed (also data files uploaded before the failure). `health` and `baseYear` may be null there.
- `ready` manifest: checked against the contract (`version` 1, runId matches the file name, each feed's `file` is `<runId>__<feed>.json.gz`, `sha256` is hex), then the begin validation (all six tabs, headers, types, `rowCount`, numeric `baseYear`, `startedAt`). Unless ACTIVE_RUN already is this run, every data file is read and checked before begin: of same-name copies the one whose sha256 (of the .gz bytes) matches the manifest is used, else the run fails (`sha256 does not match the manifest` / `missing from the Inbox`); then gunzip, JSON array, `rows.length === rowCount`, cell values. Then begin runs, once per run.
- Staging: per feed, the rows not yet staged are written in slices of 4000 rows through the chunk logic (formats before values, a part CSV per slice). Before each slice and before commit the poll checks its elapsed time; past 270 s it stops and the next poll continues from the staged counts in ACTIVE_RUN (the data file is re-read and re-checked; begin is not repeated). When every feed is staged, the commit logic runs (row-drop guard, snapshots, swap, `OK` rows). Committed or rejected, `LAST_PROCESSED_RUN` is set and the run's Inbox files are trashed.
- Any validation error or missing file goes through the fail/discard path: staging tabs and part files removed, one `FAILED` log entry, `LAST_PROCESSED_RUN` set, files trashed. A failed run is never retried.
- Unexpected exceptions do not escape the trigger when they can be logged. Inside a run the run fails as above (`unexpected error: <message>`, logged once). Outside a run (for example the Inbox cannot be opened) one `FAILED` row with an empty Run ID and `inbox: <message>` is written, and the same message is not logged again until a poll gets past the Inbox listing (Script Property `LAST_PULL_ERROR`). Only when nothing can be logged is the exception rethrown (Apps Script then reports the failed execution).
- The trigger owner needs a shared-drive role that may trash files (Content manager or Manager); a file that cannot be trashed is retried on later polls.

## Protocol (web app actions, no longer used by the nightly run)

All requests are JSON POSTs with `token`.
- `begin`: `runId`, `startedAt` (ISO, the CLI run start), `baseYear`, per-feed `{feed, tab, headers, types, rowCount}`, `health`. Sets the spreadsheet locale to `en_US` if it differs. If another run is active (different `runId`) it is logged as `ABANDONED` (`replaced by <runId>`) and its leftovers are removed.
- `chunk`: `runId`, `feed`, increasing `seq`, `rowsB64Gzip`.
- `commit`: validates everything, then swaps staging into live tabs. May return a `warning`. After the swap an empty default `Sheet1` / `Tabelle1` is deleted. A rejected commit (`{ok:false}`) has already been discarded and logged `FAILED` by the server, so the CLI posts no `fail` for it (R35), except for `not the active run`.
- `fail`: `runId`, `reason`, optional `startedAt` (Started when the run is not active). Always logged; cleans up if it is the active run.

## `_Refresh_Log`

- `B1` (last successful refresh) is an ISO UTC timestamp; `B2` the base year.
- Rows from row 5, newest first: Run ID, Started, Finished, Feed, Rows, Source Refreshed At, Status, Message. Started and Finished are Europe/Berlin `yyyy-MM-dd HH:mm:ss` (R36); Started is the CLI run start (`startedAt` of the manifest).
- Status values: `OK`, `FAILED` (also puller problems outside a run: empty Run ID, message `inbox: ...`), `ABANDONED` (replaced by a later `begin`), `NO_REFRESH` (watchdog: `B1` missing or not today's Berlin date).

## Safety rules

- Everything that can reject a run happens before any live tab is touched.
- Staging tabs are swapped into the live tabs while keeping live tab identity (sheet ids and references stay valid).
- Row-drop guard: a feed whose row count falls more than 20% (`MAX_ROW_DROP`) below the previous run is rejected.
- Every action, the puller and the watchdog run under the script lock; begin/chunk/commit/fail never interleave. The puller uses `tryLock(5000)` and skips a poll when busy; the watchdog waits up to 30 s (`LOCK_TIMEOUT_MS`).
- Health check (`sql/health.sql`) must report zero problems, else the run aborts before fetching. It blocks on `PLATFORM_HEALTH` rows with `IS_PROBLEM` where `AREA = 'MECL_SNAPSHOT'` or `OBJECT_NAME` is `TASK_REFRESH_PURCHASING`, `TASK_REFRESH_SUPPLY_CHAIN` or `TASK_REFRESH_PLATFORM_HEALTH` (R34); `PROBLEM_LIST` entries read `AREA/OBJECT_NAME:STATUS`.
- Duplicate `ROW_KEY`, count mismatch, or a truncated page at minimum size abort the run.
- The manifest is uploaded last, so the puller never sees a half-uploaded run; an upload error fails the run (phase `failed`, best-effort `failed` manifest).
- The puller checks each data file's sha256 and row count against the manifest before staging; a run is processed at most once (`LAST_PROCESSED_RUN`).
- The skill must not edit repo files or commit.
