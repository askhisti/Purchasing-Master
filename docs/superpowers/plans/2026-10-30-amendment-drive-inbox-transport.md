# Amendment: Drive Inbox transport (replaces the web-app POST)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Why:** `clasp create-deployment` failed on 2026-10-30 with "ANYONE access has been disabled by your domain administrator" (spike S2 failed). A GitHub data-branch route was blocked by Claude Code's safety check (company data leaving Google). The user chose a Google Cloud service account that uploads into a Drive folder; the data stays inside Google. The user wants MasterData refreshed before 08:00 Berlin. (This file was first written for a GitHub branch; that version is superseded.)

**Goal:** The nightly run uploads the verified, shaped data as files into the Drive **Inbox** folder using a service account. The MasterData Apps Script polls the Inbox every 15 minutes, stages, validates and swaps exactly as before.

**Spec:** `docs/superpowers/specs/2026-10-30-purchasing-master-design.md`. Base plan: `docs/superpowers/plans/2026-10-30-purchasing-master-phase-0-1.md`.

## Global Constraints

- Service account `masterdata-uploader@rfq-mecl-automation-project.iam.gserviceaccount.com`, Editor on the Inbox folder `1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV` (inside `03_Master File from Snowflake`, a shared drive). Its JSON key reaches the cloud run only through the environment variable `MASTERDATA_SA_KEY` (the JSON text). The key is never written to disk, logged, printed or committed.
- Inbox folder id in `refresh/config.json` (`{"inboxFolderId": "1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV"}`); env `MASTERDATA_INBOX_ID` overrides it.
- Google endpoints: token `https://oauth2.googleapis.com/token`, upload `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`. Scope `https://www.googleapis.com/auth/drive`. Every Drive call passes `supportsAllDrives=true` (shared drive).
- Cloud run 06:15 Europe/Berlin (after the ~05:45 Snowflake refresh). Apps Script puller every 15 minutes. Watchdog at `atHour(8).nearMinute(15)` Berlin. MasterData must normally be refreshed before 08:00.
- Everything that verifies rows before the upload (`next`, `finish` re-verification, column check, shaping) stays exactly as it is. No model re-types data.
- The web-app path (`doPost`, `refresh/lib/push.mjs`) is no longer used by the nightly run. Keep `doPost` and its tests; remove `push.mjs` if nothing uses it.

## Inbox file contract (between Task A1 and Task A2)

All files of one run are uploaded flat into the Inbox, data files first and the manifest **last** (its presence means the run's files are complete):

```
<runId>__<feed>.json.gz      one per feed (absent when status = failed)
<runId>__manifest.json       uploaded last
```

`manifest.json`:
```json
{ "version": 1, "runId": "2026-10-31T06-15-02", "status": "ready" | "failed",
  "reason": "<only when failed>", "baseYear": 2026, "startedAt": "<ISO>", "publishedAt": "<ISO>",
  "health": { "...": "health row" },
  "feeds": [ { "feed": "components", "tab": "Components", "headers": ["..."], "types": ["..."],
               "rowCount": 2757, "file": "2026-10-31T06-15-02__components.json.gz", "sha256": "<hex of the .gz bytes>" } ] }
```
`<feed>.json.gz` = gzip(JSON.stringify(rows)), rows exactly as `shapeFeed` returns them. A failed manifest has `feeds: []`. Each data file must be ≤ 5 MB (multipart limit); a larger file fails the run with a clear message.

---

### Task A1: Upload to the Drive Inbox (Node)

**Files:** Create `refresh/lib/google-auth.mjs`, `refresh/lib/inbox.mjs`, `refresh/config.json`, `test/google-auth.test.mjs`, `test/inbox.test.mjs`. Modify `refresh/cli.mjs`, `.claude/skills/nightly-refresh/SKILL.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/memory.md`, `test/e2e.test.mjs` and tests that assert the HTTP POST path of `finish`/`fail`.

**Interfaces:**
- `getAccessToken({ keyJson, scope, fetchImpl = fetch, now = () => Date.now() }) -> Promise<string>`: RS256 JWT (`iss` = client_email, `scope`, `aud` = token URL, `iat`, `exp` = iat + 3600) signed with `node:crypto`, exchanged with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. Errors never include the key or the assertion.
- `buildPayload(state, prepared) -> { manifest, files: [{ name, bytes: Buffer, mimeType }] }` (pure; sha256 over the gz bytes; manifest last in the list).
- `uploadToInbox({ folderId, files, token, fetchImpl }) -> Promise<{ ids }>`: one multipart upload per file, in list order, `supportsAllDrives=true`; non-2xx → throw with status and Google's error message (never the token). Retries network errors / 5xx up to 3 attempts (5 s, 20 s).
- `finish({ root, env, fetchImpl?, sleep?, now? })`: unchanged verification + shaping, then upload with a `ready` manifest. Prints `DONE uploaded <runId> <feed>=<rows> …` (exit 0) or `FAILED <message>` (exit 1). Missing `MASTERDATA_SA_KEY` → `FAILED missing MASTERDATA_SA_KEY` (refusal: CURRENT kept). On a failure after the state is loaded, try once to upload a `failed` manifest (best effort, its own error appended). Ends with phase `uploaded` / `failed` and deletes `runs/CURRENT`.
- `fail({ root, reason, env })`: uploads a `failed` manifest when state and key are available (best effort), marks state failed, deletes CURRENT, prints `FAILED <reason>`. With no CURRENT/state it prints `FAILED <reason>` without throwing.

- [ ] Step 1: failing tests: JWT header/claims and RS256 signature verify with the matching public key (generate a test key pair with `crypto.generateKeyPairSync`); the token request body; uploads go in order with the manifest last, carry `supportsAllDrives=true`, the folder as parent and the right names; a 5xx is retried, a 4xx is not; a > 5 MB file fails clearly; the key never appears in any error or stdout; `finish` happy path (fake fetch) prints `DONE uploaded …` and the uploaded gz decodes to the shaped rows (`'0402'` stays a string); failure paths upload a `failed` manifest; the e2e test reads the uploaded files from the fake fetch.
- [ ] Step 2: RED. Step 3: implement. Step 4: `npm test && npm run validate` GREEN.
- [ ] Step 5: SKILL.md: needs `MASTERDATA_SA_KEY`; outputs `DONE uploaded …`; drop "commit status unknown". Docs: flow (06:15 run → Inbox → puller), env vars, network allowlist `oauth2.googleapis.com` and `www.googleapis.com`.
- [ ] Step 6: commit `feat(refresh): upload nightly data to the Drive Inbox with a service account`.

### Task A2: Pull from the Drive Inbox (Apps Script)

**Files:** Create `apps-script/MasterData/Puller.ts`, `test/apps-script-puller.test.mjs`. Modify `Config.ts` (`INBOX_FOLDER_ID = '1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV'`), `Watchdog.ts` (08:15), `test/helpers/gas-fakes.mjs` (folder file listing by name, Utilities.computeDigest, ScriptApp minute trigger), docs.

**Interfaces:**
- `pollInbox()` (trigger handler): script lock with `tryLock(5000)` (exit quietly if busy). List files in the Inbox (skip trashed). Pick the oldest `<runId>__manifest.json` whose runId is not `LAST_PROCESSED_RUN` (runIds sort chronologically).
  - `status: failed` → log `FAILED` with the reason, set `LAST_PROCESSED_RUN`, trash that run's files.
  - `ready`: if no ACTIVE_RUN for this runId, run the existing begin logic (same validation). Then for each feed not fully staged: read `<runId>__<feed>.json.gz`, verify sha256 of its bytes, ungzip, parse, check `rows.length === rowCount`, stage the remaining rows through the existing chunk logic in slices of 4,000 rows. Stop when elapsed time exceeds 270 s (the next trigger continues; begin is not repeated). When all feeds are staged, run the existing commit logic, set `LAST_PROCESSED_RUN`, trash that run's Inbox files. Any validation error or missing file → existing fail/discard path, `FAILED` log row, `LAST_PROCESSED_RUN`, trash the run's files.
  - Inbox files older than 3 days that belong to no manifest are trashed.
- `installPullTrigger()`: removes existing `pollInbox` triggers, creates `everyMinutes(15)`.
- Refactor only as far as needed so the puller calls the begin/chunk/commit internals directly; `doPost` keeps working.

- [ ] Step 1: failing tests with fake Drive files: a ready run lands all six tabs, logs OK and trashes its Inbox files; a second poll does nothing; a run hitting the time budget (inject a clock) resumes on the next poll without restaging or re-running begin; sha256 mismatch → FAILED, live tabs untouched; failed manifest → one FAILED row; a manifest whose data file is missing → FAILED; two pending runs are processed oldest first; stale orphan files are trashed; watchdog trigger at 08:15.
- [ ] Step 2: RED. Step 3: implement. Step 4: GREEN (`npm test && npm run validate`).
- [ ] Step 5: docs: USER steps (run `installPullTrigger` and `installDailyWatchdogTrigger` once in the editor).
- [ ] Step 6: commit `feat(apps-script): pull nightly data from the Drive Inbox`.

### USER steps after A1–A2

1. `clasp push` the Apps Script (Claude can do this), then run `installPullTrigger` and `installDailyWatchdogTrigger` once in the editor (approves the scopes).
2. Claude cloud environment `purchasing-master`: environment variable `MASTERDATA_SA_KEY` = the JSON key text; network access Custom = default list + `oauth2.googleapis.com`, `www.googleapis.com`.
3. One-off cloud run of `probe-connector`; then one `nightly-refresh` run; check MasterData after the next poll.
4. `/schedule` daily 06:15 Europe/Berlin, Snowflake connector only.
