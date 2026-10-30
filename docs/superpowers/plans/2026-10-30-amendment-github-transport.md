# Amendment: GitHub data-branch transport (replaces the web-app POST)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Why:** `clasp create-deployment` failed on 2026-10-30 with "ANYONE access has been disabled by your domain administrator" (spike S2 failed). The user chose the spec §5 fallback and wants MasterData refreshed before 08:00 Berlin.

**Goal:** The nightly run publishes the verified, shaped data to the `data` branch of the private repo; the MasterData Apps Script polls that branch every 15 minutes, stages, validates and swaps exactly as before.

**Spec:** `docs/superpowers/specs/2026-10-30-purchasing-master-design.md` (§5 fallback). Base plan: `docs/superpowers/plans/2026-10-30-purchasing-master-phase-0-1.md`.

## Global Constraints

- Cloud run 06:15 Europe/Berlin (after the ~05:45 Snowflake refresh). Puller trigger every 15 minutes. Watchdog moves to `atHour(8).nearMinute(15)` Berlin. MasterData must normally be refreshed before 08:00.
- Repo `askhisti/Purchasing-Master` (private). Data branch name from `refresh/config.json` `{"dataBranch": "data"}`; Apps Script reads Script Property `DATA_BRANCH` (default `data`), `GITHUB_REPO` (default `askhisti/Purchasing-Master`), `GITHUB_TOKEN` (fine-grained, Contents: read-only).
- The branch holds only the latest run: one orphan commit, force-pushed.
- Everything that verifies rows before the push (`next`, `finish` re-verification, column check, shaping) stays exactly as it is. No model re-types data.
- The web-app path (`doPost`, `refresh/lib/push.mjs`) is no longer used by the nightly run. Leave `doPost` and its tests in place; remove `push.mjs` usage from `finish`.

## Data branch layout (the contract between Task A1 and Task A2)

```
latest/manifest.json
latest/<feed>.json.gz      (one per feed; absent when status = failed)
```

`manifest.json`:
```json
{ "version": 1, "runId": "2026-10-31T06-15-02", "status": "ready" | "failed",
  "reason": "<only when failed>", "baseYear": 2026, "startedAt": "<ISO>", "publishedAt": "<ISO>",
  "health": { "...": "health row" },
  "feeds": [ { "feed": "components", "tab": "Components", "headers": ["..."], "types": ["..."],
               "rowCount": 2757, "file": "latest/components.json.gz", "sha256": "<hex of the .gz bytes>" } ] }
```
`<feed>.json.gz` = gzip(JSON.stringify(rows)), rows exactly as `shapeFeed` returns them (arrays of string | number | boolean | null). A failed manifest has `feeds: []`.

---

### Task A1: Publish to the data branch (Node)

**Files:** Create `refresh/lib/publish.mjs`, `refresh/config.json`, `test/publish.test.mjs`. Modify `refresh/cli.mjs`, `.claude/skills/nightly-refresh/SKILL.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/memory.md`, tests that assert the HTTP path of `finish`/`fail`.

**Interfaces:**
- `buildPayload(state, prepared) -> { manifest, files: [{ path, bytes: Buffer }] }` (pure; sha256 over gz bytes).
- `publishToBranch({ root, branch, files, message, git = defaultGit }) -> { commit }`: inside the existing clone, `git worktree add --detach <tmp>`; in it `git checkout --orphan <tmpBranch>`, remove everything, write files, `git -c user.name="MasterData refresh" -c user.email="masterdata-refresh@users.noreply.github.com" commit -m <message>`, `git push --force origin HEAD:refs/heads/<branch>`, then always `git worktree remove --force <tmp>` and delete the temp branch. Uses `execFileSync('git', …)` (no shell).
- `finish({ root, now? })`: unchanged verification + shaping, then `publishToBranch` with a `ready` manifest. Prints `DONE published <runId> <feed>=<rows> …` (exit 0) or `FAILED <message>` (exit 1). On any failure after the state is loaded it tries once to publish a `failed` manifest (best effort, its own error appended). Ends with phase `published` / `failed` and deletes `runs/CURRENT`. Refusals (wrong phase) keep CURRENT, as before. No env vars are needed any more.
- `fail({ root, reason })`: publishes a `failed` manifest (best effort), marks state failed, deletes CURRENT, prints `FAILED <reason>`.

- [ ] Step 1: failing tests in `test/publish.test.mjs` using a temp bare repo as `origin` of a temp clone: a ready publish leaves branch `data` with exactly `latest/manifest.json` + one `.json.gz` per feed, a single parentless commit, sha256 values match, gz decodes to the shaped rows (`'0402'` still a string); a second publish replaces the commit (still one commit, old files gone); a failed manifest has `feeds: []` and the reason; the temp worktree is removed even when the push fails; `finish` refusal paths unchanged; the e2e test is switched to read the published files.
- [ ] Step 2: RED. Step 3: implement. Step 4: `npm test && npm run validate` GREEN.
- [ ] Step 5: SKILL.md: no env vars; `finish` performs a git push itself (Claude still never edits or commits files); outputs `DONE published …`; remove the "commit status unknown" case. Docs updated (flow, 06:15, branch layout, no web app).
- [ ] Step 6: commit `feat(refresh): publish to the data branch instead of the web app`.

### Task A2: Pull from the data branch (Apps Script)

**Files:** Create `apps-script/MasterData/Puller.ts`, `test/apps-script-puller.test.mjs`. Modify `Config.ts`, `Watchdog.ts` (08:15), `appsscript.json` (add `https://www.googleapis.com/auth/script.external_request`), `test/helpers/gas-fakes.mjs` (UrlFetchApp, ScriptApp minute trigger, Utilities.computeDigest), docs.

**Interfaces:**
- `pollDataBranch()` (trigger handler): script lock (`tryLock(5000)`, exit quietly if busy); read properties; GET `https://api.github.com/repos/<repo>/contents/latest/manifest.json?ref=<branch>` with headers `Authorization: Bearer <token>`, `Accept: application/vnd.github.raw`, `X-GitHub-Api-Version: 2022-11-28`, `muteHttpExceptions: true`.
  - 404 / no manifest → exit. Non-200 otherwise → log `FAILED` once per hour at most (property `LAST_PULL_ERROR_AT`).
  - `manifest.runId === LAST_PROCESSED_RUN` → exit.
  - `status: failed` → log `FAILED` with the reason, set `LAST_PROCESSED_RUN`, exit.
  - `ready`: if no ACTIVE_RUN for this runId, run the existing begin logic (same validation: six tabs, headers, types). Then for each feed not fully staged: download the file, verify sha256 of the bytes, ungzip, parse, check `rows.length === rowCount`, stage the remaining rows through the existing chunk logic in slices of 4,000 rows (seq = slice number). Stop and return when elapsed time exceeds 270 s (the next trigger continues; begin is not repeated for the same runId). When all feeds are staged, run the existing commit logic, then set `LAST_PROCESSED_RUN`. Any validation error → existing fail/discard path, log `FAILED`, set `LAST_PROCESSED_RUN`.
- `installPullTrigger()`: removes existing `pollDataBranch` triggers, creates `everyMinutes(15)`.
- Refactor only as far as needed so the puller calls the begin/chunk/commit internals directly (not via `doPost`); `doPost` keeps working.

- [ ] Step 1: failing tests with a fake UrlFetchApp serving a manifest + gz files: a ready run lands all six tabs and logs OK; a second poll with the same runId does nothing; a run that hits the time budget (inject a clock) resumes on the next poll without restaging; sha256 mismatch → FAILED, live tabs untouched; failed manifest → one FAILED row; 404 → nothing; 401 → one FAILED row, a second 401 within the hour adds none; watchdog trigger at 08:15.
- [ ] Step 2: RED. Step 3: implement. Step 4: GREEN (`npm test && npm run validate`).
- [ ] Step 5: docs: USER steps — create the fine-grained token (repo `askhisti/Purchasing-Master`, Contents: read-only), set Script Properties `GITHUB_TOKEN` (and optionally `GITHUB_REPO`, `DATA_BRANCH`), run `installPullTrigger` and `installDailyWatchdogTrigger` once in the editor (approves the new scopes).
- [ ] Step 6: commit `feat(apps-script): pull nightly data from the GitHub data branch`.

### USER steps after A1–A2 (replace the old web-app steps)

1. `clasp push` the Apps Script (I can do this).
2. Create the fine-grained GitHub token; set Script Property `GITHUB_TOKEN`; run `installPullTrigger` and `installDailyWatchdogTrigger` once in the editor.
3. One-off cloud run of `probe-connector`; then one `nightly-refresh` run; check MasterData after the next poll.
4. `/schedule` daily 06:15 Europe/Berlin, Snowflake connector only.
