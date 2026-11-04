# Architecture

## Flow

1. A cloud task (environment `purchasing-master`, 06:15 Europe/Berlin, after the ~05:45 Snowflake refresh) runs the `nightly-refresh` skill with the Snowflake connector only.
2. The skill drives `refresh/cli.mjs` (`begin`, `next` loop, `finish` / `fail`). The CLI hands out one SQL at a time; the skill runs it through the connector and runs no other Snowflake query.
3. A PostToolUse hook (`.claude/settings.json` -> `node "$CLAUDE_PROJECT_DIR/refresh/capture-hook.mjs"`) saves each connector result under `runs/<runId>/captures/` while `runs/CURRENT` exists. The hook finds the repo from `CLAUDE_PROJECT_DIR`, else from the hook input's `cwd`. The model never sees or copies rows.
4. `next` compares the captured SQL with the pending SQL (whitespace-normalised), parses the result, and plans the next query: health check, then per feed a count query and keyset pages.
   - Paging: the first page of every feed asks for `pageLimit` (500) rows; each full page sizes the next one to about `targetPageChars` (250000, top level of `sql/feeds.json`) characters, clamped to 100..20000. A truncated page (fewer rows than `numRows`) is re-asked with the same key and limit `max(100, floor(rows that fit * 0.8))`.
   - A result that cannot be parsed aborts with `unrecognized connector result: <first 200 characters, newlines collapsed>`.
5. `finish` re-reads the captures, verifies and shapes the rows, and uploads them into the Drive Inbox (a folder in the company shared drive) with the service account `masterdata-uploader`: one `<runId>__<feed>.json.gz` per feed, then `<runId>__manifest.json` last (its presence means the run's files are complete). A failed run uploads only a `failed` manifest (`feeds: []`, with `reason`). The state ends as `uploaded` or `failed`.
6. MasterData's bound Apps Script polls the Inbox every 5 minutes (R54; `pollInbox`, see "Inbox puller") and runs the same begin -> chunk -> commit logic as the web app internally: staging tabs, validation, row-drop guard, swap into the live tabs, a Raw snapshots CSV per feed, `_Refresh_Log`. It then trashes the run's Inbox files.
7. A daily time-driven trigger (08:15 Europe/Berlin; Apps Script fires it within 15 minutes of that) runs `checkDailyRefresh` and logs `NO_REFRESH` when no run succeeded that day (R37, R43).

## Files

| Path | Responsibility |
|---|---|
| `.claude/skills/nightly-refresh/SKILL.md` | Rules for the cloud run (drive the CLI, no editing of SQL, no row handling, no other Snowflake query) |
| `.claude/settings.json` | Registers the capture hook |
| `refresh/capture-hook.mjs` | Saves connector results while a run is active |
| `scripts/it-handover.mjs`, `docs/IT-HANDOVER.md` | Handover pack for a direct Snowflake export by IT (rendered SQL per year, manifest template, file contract) |
| `refresh/cli.mjs` | Commands `begin`, `next`, `finish`, `fail`; run state machine |
| `refresh/lib/manifest.mjs`, `sql/feeds.json` | Feed definitions: tab, columns, types, first page limit; `targetPageChars` |
| `refresh/lib/sql.mjs`, `sql/health.sql`, `sql/feeds/*.sql` | SQL rendering, count and keyset page queries, page sizing |
| `refresh/lib/result.mjs` | Parses connector results |
| `refresh/lib/shape.mjs` | Converts raw rows to typed sheet rows |
| `refresh/lib/google-auth.mjs` | Service account JWT (RS256, `node:crypto`) exchanged for an access token; network errors, 5xx and 429 retried (5 s, 20 s), other 4xx (e.g. `invalid_grant`) fail at once |
| `refresh/lib/inbox.mjs` | Builds the Inbox files (gz data + manifest) and uploads them with multipart Drive requests, retrying network errors, 5xx, 429 and 403 `rateLimitExceeded` / `userRateLimitExceeded` (5 s, 20 s; R57) |
| `refresh/config.json` | `inboxFolderId` (override: env `MASTERDATA_INBOX_ID`) |
| `refresh/lib/state.mjs` | Run id, state file, capture lookup |
| `apps-script/MasterData/Config.ts` | Constants (token property, folder ids incl. `INBOX_FOLDER_ID`, row-drop limit, log sheet, time zone, locale, watchdog time, puller slice size and time budget) |
| `apps-script/MasterData/WebApp.ts` | `doPost`: token check, script lock, actions; the begin/chunk/commit/fail handlers the puller also uses |
| `apps-script/MasterData/Puller.ts` | `pollInbox` (Inbox puller) and `installPullTrigger` |
| `apps-script/MasterData/Sheets.ts` | Staging tabs, swap into live tabs, `_Refresh_Log`, log times, locale, default-sheet cleanup |
| `apps-script/MasterData/Store.ts`, `Core.ts` | Run storage and shared helpers |
| `apps-script/MasterData/Watchdog.ts` | `checkDailyRefresh` and `installDailyWatchdogTrigger` (R37, 08:15) |
| `scripts/release-gas.mjs`, `scripts/release-lib.mjs` | Release (R55, push-only): tests and validate, `clasp push --force`, and `clasp version` when a description is given. No web app deployment (spike S2 failed) |
| `docs/sheets.md` | Tab and header contract |

## Environment and network

- `MASTERDATA_SA_KEY`: the service account key JSON text (never written to disk, logged or committed). Missing or not a service account key: `finish` refuses and keeps `runs/CURRENT`.
- `MASTERDATA_INBOX_ID` (optional): Inbox folder id, default from `refresh/config.json`.
- Network allowlist for the cloud environment: `oauth2.googleapis.com`, `www.googleapis.com` (plus the Snowflake connector). Every Drive call passes `supportsAllDrives=true`; a data file is limited to 5 MB (multipart upload).

## Inbox puller (`pollInbox`, Apps Script)

Time-driven every 5 minutes (`installPullTrigger`, R54), plus one-off continuation triggers. Constants in `Config.ts`: `INBOX_FOLDER_ID`, `PULL_EVERY_MINUTES` (5), `PULL_SLICE_ROWS` (4000), `PULL_BUDGET_MS` (270 s), `PULL_COMMIT_START_MAX_MS` (150 s), `PULL_CONTINUATION_DELAY_MS` (60 s), `PULL_MAX_ATTEMPTS` (3), `PULL_STALL_POLLS` (3), `INBOX_ORPHAN_DAYS` (3), `INBOX_MIN_AGE_MS` (2 min).

- Reads its start time on entry, then takes the script lock with `tryLock(5000)`; when another execution holds it, the poll exits quietly.
- Under the lock it first deletes the one-off continuation triggers earlier polls created (their ids are in Script Property `PULL_CONTINUATION_TRIGGERS`); the 5-minute trigger is never touched.
- Lists the Inbox (trashed files skipped). Files named `<runId>__<name>` are grouped by runId.
- Files older than 3 days that belong to no manifest are trashed. A runId whose data files never got a manifest is logged `INCOMPLETE` (`no manifest after 3 days; N file(s) trashed`); files without a runId prefix are trashed without a log row. Younger files stay (an upload may be in progress).
- Script Property `LAST_PROCESSED_RUN` holds the runId of the last run that ended (committed or failed). Manifests with a runId up to it are never processed again; their files are trashed (data files first, the manifest only once every data file is gone, so leftovers never turn into manifest-less `INCOMPLETE` files). An older run is logged `SUPERSEDED` (`older run superseded by <last>; files trashed`) once all its files are trashed, so the row is written once per runId; the last committed run is never logged `SUPERSEDED`. Of the newer manifests the oldest is processed (runIds sort chronologically), one run per poll.
- R57: when a manifest of that oldest run is younger than 2 minutes (Drive listings can lag behind uploads), the poll returns `waiting` and leaves it for a later poll; a newer run is never processed ahead of it. Such a poll does not count toward R56.
- Script Property `LAST_COMMITTED_RUN` is set by the commit itself right after the swap. A pending run equal to it was committed by a poll that was killed before `LAST_PROCESSED_RUN` was set: the poll only finishes the bookkeeping (`LAST_PROCESSED_RUN`, trash the files); the run is never staged, committed or failed again.
- A late `failed` manifest for the run in `LAST_COMMITTED_RUN` (the cloud run saw an upload error after its ready manifest had landed) writes one `INFO` row `cloud run reported failure after data was committed: <reason>` (once per runId, Script Property `LAST_LATE_FAILURE_RUN`); the live data stays. A late `failed` manifest for a run that failed is trashed without a row.
- R56 (stalled runs): before any other work on a run, each poll persists Script Property `PULL_PROGRESS` = `{runId, polls, stagedTotal}` (the sum of the staged rows in ACTIVE_RUN; `polls` counts the polls that started at the same total). Apps Script can kill an execution at 6 minutes without running any catch or later code, so such a poll still counts. When the staged total has not grown for 3 polls in a row, the next poll fails the run (`FAILED`, `no progress after 3 polls`, the fail path below, `LAST_PROCESSED_RUN` set). A commit-only poll (everything staged) counts as progress only by committing, so a run whose commit is killed on every poll also fails after 3 polls. The counter is cleared when the run ends.
- A runId more than a day ahead of the clock is logged `FAILED` (`runId is in the future`) once (Script Property `LAST_FUTURE_RUN`) and its files are trashed. It never moves `LAST_PROCESSED_RUN`; errors on this path are handled like errors outside a run.
- Manifest copies (Drive create retries are not idempotent, R46): if any copy is `failed`, the failed one wins; unreadable or differing ready copies fail the run.
- `failed` manifest: the fail action logs one `FAILED` row with the manifest's `reason` (Started = manifest `startedAt`); `LAST_PROCESSED_RUN` is set and every `<runId>__*` file is trashed (also data files uploaded before the failure). `health` and `baseYear` may be null there.
- `ready` manifest: checked against the contract (`version` 1, runId matches the file name, each feed's `file` is `<runId>__<feed>.json.gz`, `sha256` is hex), then the begin validation (all six tabs, headers, types, `rowCount`, numeric `baseYear`, `startedAt`). Unless ACTIVE_RUN already is this run, every data file is read and checked before begin: of same-name copies the one whose sha256 (of the .gz bytes) matches the manifest is used, else the run fails (`sha256 does not match the manifest` / `missing from the Inbox`); then gunzip, JSON array, `rows.length === rowCount`, cell values. Then begin runs, once per run.
- Staging: per feed, the rows not yet staged are written in slices of 4000 rows through the chunk logic (formats before values, a part CSV per slice). A slice (or the next feed) is not started when the poll's elapsed time plus the previous slice's duration would pass 270 s. The commit (snapshots + swap) only starts while the poll is under 150 s old, so it has headroom before Apps Script's 6-minute limit. A poll that stops for either reason returns `staging`, and creates a one-off trigger (`after(60 s)`, R51) so the next poll continues from the staged counts in ACTIVE_RUN (the data file is re-read and re-checked; begin is not repeated). When every feed is staged, the commit logic runs (row-drop guard, snapshots, swap, `OK` rows). Committed or rejected, `LAST_PROCESSED_RUN` is set and the run's Inbox files are trashed. A commit that finds the run no longer active writes a `FAILED` row.
- Validation problems fail the run at once (final): manifest or data-file checks, begin validation, the commit's rejections (staged count, row-drop guard) and an error after the swap started. The fail/discard path removes staging tabs, part and `.tmp` files, writes one `FAILED` entry, sets `LAST_PROCESSED_RUN` and trashes the files.
- Unexpected errors of a run (exceptions, e.g. a Drive error reading a file or writing a snapshot) are retried (R48): attempts 1 and 2 write a `RETRY` row (`attempt n of 3: <message>`) and keep the run's state (ACTIVE_RUN, staging tabs, snapshot files; Script Property `PULL_RETRY` counts the attempts per runId); the next poll tries again. The third attempt fails the run (`FAILED`, `attempt 3 of 3: <message>`) as above. The counter is cleared when the run ends. An error in the commit before the swap is retryable without restaging: the commit keeps staging and an already assembled `<feed>.csv.tmp`. `doPost`'s commit still discards and logs `FAILED` on any error.
- Errors outside a run (for example the Inbox cannot be opened) write one `FAILED` row with an empty Run ID and `inbox: <message>`; the same message is not logged again until a poll ends without such an error (Script Property `LAST_PULL_ERROR`). An exception is rethrown only when nothing can be logged (Apps Script then reports the failed execution).
- The trigger owner needs a shared-drive role that may trash files (Content manager or Manager); a file that cannot be trashed is retried on later polls.

## Protocol (web app actions, no longer used by the nightly run)

Not deployed: spike S2 failed (domain policy forbids ANYONE web app access), `appsscript.json` has no `webapp` block (R55). The code stays because the puller reuses the handlers.


All requests are JSON POSTs with `token`.
- `begin`: `runId`, `startedAt` (ISO, the CLI run start), `baseYear`, per-feed `{feed, tab, headers, types, rowCount}`, `health`. Sets the spreadsheet locale to `en_US` if it differs. If another run is active (different `runId`) it is logged as `ABANDONED` (`replaced by <runId>`) and its leftovers are removed. The run is kept in Script Property `ACTIVE_RUN` (`{runId, date, baseYear, started, sourceRefreshedAt, feeds:[{feed, tab, width, rowCount, staged, seqs}]}`); each feed's headers and types are in their own property `ACTIVE_RUN_FEED_<feed>` (a property value is limited to 9 KB), written at begin and deleted whenever `ACTIVE_RUN` is cleared.
- `chunk`: `runId`, `feed`, increasing `seq`, `rowsB64Gzip`.
- `commit`: validates everything, then swaps staging into live tabs. May return a `warning`. After a successful swap the tabs of removed feeds (`MASTERDATA_CONFIG.OBSOLETE_TABS`: Component_Demand_Monthly, BOM_Demand_Monthly, BOM_Sources, Price_At_Demand, Savings_Levers, Quote_Health, Multisource_Health) are deleted if present (warning-only step; never on a failed run). The live tabs are, in order: Components, Multisource, Multisource_Members, Component_Usage, Products, MECL_Price, Product_Volumes, BOM_Coverage (plus `_Refresh_Log`); Components and Product_Volumes carry the rolling month columns. After the swap an empty default `Sheet1` / `Tabelle1` is deleted. A rejected commit (`{ok:false}`) has already been discarded and logged `FAILED` by the server, so the CLI posts no `fail` for it (R35), except for `not the active run`.
- `fail`: `runId`, `reason`, optional `startedAt` (Started when the run is not active). Always logged; cleans up if it is the active run.

## `_Refresh_Log`

- `B1` (last successful refresh) is an ISO UTC timestamp; `B2` the base year.
- Rows from row 5, newest first: Run ID, Started, Finished, Feed, Rows, Source Refreshed At, Status, Message. Started and Finished are Europe/Berlin `yyyy-MM-dd HH:mm:ss` (R36); Started is the CLI run start (`startedAt` of the manifest).
- Status values: `OK`, `FAILED` (also puller problems outside a run: empty Run ID, message `inbox: ...`; a stalled run: `no progress after 3 polls`), `RETRY` (puller attempt 1 or 2 of a run failed unexpectedly; retried), `SUPERSEDED` (`older run superseded by <last>`: an older Inbox run's files were trashed because a newer run was already processed), `INFO` (`cloud run reported failure after data was committed: <reason>`: a late failed manifest for the committed run; the data stays), `INCOMPLETE` (Inbox data files without a manifest after 3 days, trashed), `ABANDONED` (replaced by a later `begin`), `NO_REFRESH` (watchdog: `B1` missing or not today's Berlin date).

## Safety rules

- Everything that can reject a run happens before any live tab is touched.
- Staging tabs are swapped into the live tabs while keeping live tab identity (sheet ids and references stay valid).
- Row-drop guard: a feed whose row count falls more than 20% (`MAX_ROW_DROP`) below the previous run is rejected.
- Every action, the puller and the watchdog run under the script lock; begin/chunk/commit/fail never interleave. The puller uses `tryLock(5000)` and skips a poll when busy; the watchdog waits up to 330 s (`WATCHDOG_LOCK_TIMEOUT_MS`, R49), longer than any puller execution; `doPost` waits 30 s (`LOCK_TIMEOUT_MS`).
- Health check (`sql/health.sql`) must report zero problems, else the run aborts before fetching. It blocks on `PLATFORM_HEALTH` rows with `IS_PROBLEM` where `AREA = 'MECL_SNAPSHOT'` or `OBJECT_NAME` is `TASK_REFRESH_PURCHASING`, `TASK_REFRESH_SUPPLY_CHAIN` or `TASK_REFRESH_PLATFORM_HEALTH` (R34); `PROBLEM_LIST` entries read `AREA/OBJECT_NAME:STATUS`.
- Duplicate `ROW_KEY`, count mismatch, or a truncated page at minimum size abort the run.
- The manifest is uploaded last, so the puller never sees a half-uploaded run; an upload error fails the run (phase `failed`, best-effort `failed` manifest).
- The puller checks each data file's sha256 and row count against the manifest before staging; a run is processed at most once (`LAST_PROCESSED_RUN`).
- The skill must not edit repo files or commit.
