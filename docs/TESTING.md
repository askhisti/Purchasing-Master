# Testing

## Commands

- `npm test`: `node --test "test/*.test.mjs"`.
- `npm run validate`: `tsc --noEmit -p tsconfig.json` (type check of the Apps Script sources).

## What the automated tests cover

- Refresh CLI logic: manifest (including `pageLimit` 500 and `targetPageChars`), SQL rendering and page sizing, the health gate text, result parsing, shaping, service account JWT signing and token request, Inbox payload building and multipart upload (order, retry, 5 MB limit), `finish`/`fail` against a fake Google fetch, a key-leak scan of stdout and error messages, the `next` state machine with fixture captures, the capture hook (repo root from `CLAUDE_PROJECT_DIR` or input `cwd`), main-module detection through a symlink/junction, `.claude/settings.json` and the skill's no-other-query rule.
- Apps Script code (`Core`, `Sheets`, `WebApp`, `Watchdog`, `Puller`) loaded in Node `vm` against fake SpreadsheetApp (including locale), DriveApp (folder listing incl. trashed items and same-name duplicates, binary files, `getDateCreated`, `setTrashed`), Properties, Lock (`waitLock`, `tryLock`), Utilities (`formatDate`, `computeDigest` returning signed bytes, gzip) and ScriptApp (daily, every-15-minutes and one-off `after` triggers, `nearMinute`, `getUniqueId`): token auth, actions, staging and swap, log (Berlin times, `ABANDONED`, `NO_REFRESH`), guards, default-sheet cleanup, watchdog trigger install at 08:15.
- Inbox puller (`test/apps-script-puller.test.mjs`): a ready run lands all six tabs, logs `OK`, writes CSV snapshots and trashes its files; a second poll does nothing; the time budget with an injected clock (no slice started when elapsed + the previous slice would pass 270 s; no commit after 150 s; the next poll resumes without re-running begin or restaging; one-off continuation trigger replaced, the 15-minute trigger kept; start time read before `tryLock`); 4,000-row slices; R48 retries (one transient error → `RETRY` then `OK`; a transient commit error keeps staging and the retry commits without restaging, with complete snapshots; three failures → `FAILED`; validation rejections final); a commit that finds the run inactive logs `FAILED`; sha256 mismatch, missing file, row-count mismatch, begin validation and unreadable manifests fail the run with live tabs untouched; same-name duplicates (matching copy used, failed manifest wins); failed manifests; two pending runs oldest first; stale orphans (`INCOMPLETE`); busy lock; `LAST_PROCESSED_RUN` (`SUPERSEDED`) and future runIds (logged once, never `LAST_PROCESSED_RUN`, also when logging fails); row-drop guard; unexpected errors logged once (rethrown only when nothing can be logged); `installPullTrigger`. An end-to-end test feeds the exact files of Node's `buildPayload` for the real `sql/feeds.json` into the fake Inbox.
- End to end (`test/e2e.test.mjs`): `begin`/`next` over the real `sql/feeds.json` and SQL files with generated captures for all six feeds, then `finish` against a fake Google fetch: one token request, six gz data files then the manifest last, decoded headers and rows with `0402` kept as a string and matching sha256 and row counts.
- Release config validation (`scripts/release-lib.mjs`).

## What they do not cover

- Real Google services: `getActiveSpreadsheet()` in `doPost` and in a time-driven trigger, real sheet type coercion, `setSpreadsheetLocale`, tab ordering in a real spreadsheet, Drive folders (the shared-drive Inbox, trash permissions), real triggers, quotas and execution time limits (how many 4,000-row slices fit in 270 s).
- The real Snowflake connector, result sizes, the health gate against live `PLATFORM_HEALTH`, hook behaviour in the cloud (`$CLAUDE_PROJECT_DIR` expansion), and network reachability.
- `scripts/release-gas.mjs` itself (the clasp calls) is untested by design; only its config validation is unit-tested.

## USER step: install the triggers (once)

After the first release containing `Puller.ts`, run `installPullTrigger` and `installDailyWatchdogTrigger` once each from the Apps Script editor and approve the permissions (see `docs/memory.md`, USER steps). Then check:

- [ ] Triggers page shows exactly one `pollInbox` trigger, time-driven, every 15 minutes.
- [ ] Triggers page shows exactly one `checkDailyRefresh` trigger, time-driven, daily 08:00 to 09:00 Europe/Berlin (fires near 08:15).
- [ ] After the first nightly run: the Inbox is empty again, `_Refresh_Log` shows `OK` rows for the run, and the `pollInbox` executions (Executions page) finished without errors, each under 6 minutes.
- [ ] Slice timing: in the Executions page, the `pollInbox` executions that staged the run (Components is the largest feed) took well under 270 s each, and the commit execution well under 6 minutes; if a poll stopped early, a one-off `pollInbox` trigger ran about a minute later and no one-off trigger is left afterwards.
- [ ] The account that installed the triggers has Content manager (or Manager) on the shared drive `03_Master File from Snowflake` (otherwise processed Inbox files are not trashed).
- [ ] The watchdog still runs when a `pollInbox` execution is busy at 08:15 (it waits for the lock; no "lock timeout" failure).
- [ ] Running `checkDailyRefresh` from the editor on a day without a successful refresh adds a `NO_REFRESH` row to `_Refresh_Log`; on a day with one it adds nothing.

## Manual live-run checklist

Run once in the cloud environment `purchasing-master` with the prompt "Run the nightly-refresh skill." (Snowflake connector only).

- [ ] Final line is `DONE` with six feeds.
- [ ] `_Refresh_Log` has a row `OK` per feed and `B1` = today (ISO UTC); Started/Finished show Berlin time `yyyy-MM-dd HH:mm:ss`, Started = the CLI run start.
- [ ] The six tabs exist with headers exactly as in `docs/sheets.md`.
- [ ] `Components` row ME_EC_0000001 Demand <Y> equals the Snowflake value queried directly.
- [ ] `Raw snapshots/<today>/` has six CSVs with header and row counts matching the log.
- [ ] Snowflake connector calls in the run are <= 45, and the transcript shows no Snowflake tool other than `sql` with the CLI's SQL.
- [ ] The capture hook wrote captures (`$CLAUDE_PROJECT_DIR` resolved in the cloud).
- [ ] `getActiveSpreadsheet()` works inside the time-driven `pollInbox` of the bound script.
- [ ] Spreadsheet locale is `en_US` (File > Settings) after the run; an empty `Sheet1` / `Tabelle1` is gone.
- [ ] A part number with a leading zero (e.g. 0402) shows the zero, and `1E3` stay text.
- [ ] Tab order is correct after the swap (`moveActiveSheet` without UI).
- [ ] A string starting with `=` is stored as text, not a formula.
- [ ] Number columns show without a trailing dot.
