# Purchasing Master (Phase 0 + 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A MasterData Google Sheet that a scheduled Claude task refreshes every morning at 07:00 Berlin from Snowflake, with dated raw snapshots and a run log.

**Architecture:** A cloud scheduled Claude session drives a small Node state machine (`refresh/cli.mjs`) that tells it which SQL to run next through the Snowflake connector; a PostToolUse hook saves every result byte-for-byte; Node verifies and shapes the results and POSTs them in chunks to a web app in the Apps Script project bound to MasterData, which stages, validates, swaps tabs, writes CSV snapshots and logs. Claude never handles row values.

**Tech Stack:** Node 24 (built-in `node:test`, `node:zlib`, `fetch`; no npm runtime deps), Google Apps Script V8 written as plain-JS-syntax `.ts` files (type-checked with `tsc`, loadable in Node `vm` for tests, same as the RFQ repo), clasp, Snowflake SQL (`MECL_PLATFORM.ANALYTICS`), Claude Code cloud scheduled tasks.

**Spec:** `docs/superpowers/specs/2026-10-30-purchasing-master-design.md`

## Global Constraints

- Repo root: `C:\Users\a.khisti\Desktop\Purchasing Master Database\Purchasing Master` → GitHub `askhisti/Purchasing-Master` (private).
- Drive folder: `1lP59mBX1dM24emOJlussSvMPbkBiTTUk` (`03_Master File from Snowflake`); snapshots under `Raw snapshots/YYYY-MM-DD/`; retention 30 days.
- Schedule: 07:00 Europe/Berlin daily. Fallback transport trigger 08:00.
- Every Snowflake query goes through the Claude connector tool `mcp__claude_ai_Snowflake_-_ME_Data__sql`. No service user, no Snowflake API from Apps Script or Node.
- Query only `MECL_PLATFORM.ANALYTICS`; column names UPPERCASE unquoted; never alias a column `ROWS` or `SAMPLE`.
- Platform rules: demand = `KPI_COMPONENT_DEMAND_BY_YEAR.TOTAL_DEMAND` with `IS_SOURCED_BY_US` (dem-01); per-product quantity from `QTY_PER_UNIT` (ops-10); multisource sums only within one cluster (des-03); prices in quoted currency, EUR column labelled "current rate" (price-02); health by `IS_PROBLEM` (ops-02).
- Page target: 250,000 characters per connector result (`TARGET_PAGE_CHARS = 250000`). Push chunk: at most 2,000,000 bytes of gzip+base64 per POST (`CHUNK_BYTES = 2000000`).
- Reject a run when any feed's row count drops more than 20% versus the last successful run (`MAX_ROW_DROP = 0.2`).
- Tab contract (spec §6): headers row 1, data from row 2, blanks empty, numbers as numbers, dates `YYYY-MM-DD`, string columns stored as plain text. Demand columns `Demand <Y>` … `Demand <Y+10>`, Y = base year of the run.
- No deploy, push to GitHub, or schedule creation without the user's explicit go-ahead at that step (marked **USER**).

## Review Focus

- **Part numbers that look like numbers or dates** (`0402`, `1E3`, `MAR-12`): Sheets would convert them on write. String columns must be formatted `@` before `setValues` → test in Task 9.
- **Run that crosses midnight in UTC/Pacific vs Berlin (e.g. 1 January):** headers and SQL must use one base year taken from Berlin time at run start → tests in Task 3 and Task 5.
- **Data changing between the count and the pages, or a truncated page:** must never produce a short tab; truncated pages are re-fetched smaller, a count/sum mismatch fails the run with live tabs untouched → tests in Task 4.
- **A second run (manual "Run now" during the scheduled one) or a retried run after a partial upload:** must not mix rows of two runs → `begin` clears staging for a new run id, chunks for another run id are rejected, a script lock serialises requests → tests in Task 8.
- **Quotes linked to several components / ambiguous MPN matches:** row key is `Price ID|ME_EC`; duplicate `ROW_KEY` fails verification; `Resolved ME_EC` blank when the MPN matches more than one component → tests in Task 4 and SQL check in Task 3.

---

## File Structure

```
Purchasing Master/
├── package.json, tsconfig.json, .gitignore, README.md
├── .claude/settings.json                     PostToolUse hook → refresh/capture-hook.mjs
├── .claude/skills/nightly-refresh/SKILL.md   the run's step list for Claude
├── sql/feeds.json                            manifest: feeds, tabs, columns, types, source views
├── sql/health.sql                            health gate + base year
├── sql/feeds/<feed>.sql                      one SELECT per feed, first column ROW_KEY, placeholder {{BASE_YEAR}}
├── refresh/lib/manifest.mjs                  load + validate manifest
├── refresh/lib/sql.mjs                       count/page SQL builders, page sizing
├── refresh/lib/result.mjs                    parse a captured connector result
├── refresh/lib/state.mjs                     run state on disk (runs/<runId>/state.json)
├── refresh/lib/shape.mjs                     rows → typed tab payloads
├── refresh/lib/push.mjs                      chunk + POST protocol client
├── refresh/capture-hook.mjs                  hook entry: save tool result
├── refresh/cli.mjs                           begin | next | finish | fail
├── test/*.test.mjs                           node:test suites (+ test/fixtures/)
├── apps-script/MasterData/.clasp.json, appsscript.json
├── apps-script/MasterData/Config.ts          constants
├── apps-script/MasterData/Core.ts            pure logic (validation, CSV, formats) – vm-tested
├── apps-script/MasterData/Store.ts           Drive: snapshot parts, assemble, prune
├── apps-script/MasterData/Sheets.ts          staging tabs, swap, _Refresh_Log
├── apps-script/MasterData/WebApp.ts          doPost routing, token, lock
├── scripts/release-gas.mjs                   test → validate → clasp push → version → redeploy same deployment
└── docs/ ARCHITECTURE.md, sheets.md (tab contracts), memory.md, TESTING.md, phase-0-findings.md
```

`runs/` is git-ignored.

---

## Phase 0 — tests and reconciliation

### Task 1: Repo scaffold and capture hook

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `.claude/settings.json`, `refresh/capture-hook.mjs`, `refresh/lib/result.mjs`, `test/capture-hook.test.mjs`, `test/result.test.mjs`, `test/fixtures/sql-small.json`, `test/fixtures/sql-truncated.json`, `test/fixtures/hook-input.json`
- Move in: the existing `docs/superpowers/` folder stays.

**Interfaces:**
- Produces: `parseConnectorResult(text: string) -> { rows: string[][], columns: string[], numRows: number, chars: number }` in `refresh/lib/result.mjs` — accepts the raw connector text in either shape seen so far: a JSON object with `result_set`, or a JSON array `[{type:'text', text:'<json>'}]` wrapping it. `chars` = length of the raw text.
- Produces: capture file format `runs/<runId>/captures/<NNNN>.json` = `{ "seq": number, "capturedAt": iso, "sql": string, "response": string }` (`response` is the raw tool result text, verbatim).
- Produces: `runs/CURRENT` (text file, a run id). When absent, the hook does nothing.

- [ ] **Step 1: Scaffold.** `git init`; `package.json` scripts: `"test": "node --test test/"`, `"validate": "tsc --noEmit -p tsconfig.json"`, `"release": "node scripts/release-gas.mjs"`; devDependencies `typescript@^6.0.2`, `@types/google-apps-script@^2.0.8` (same as RFQ repo); `tsconfig.json` = RFQ `tsconfig.json` options plus `"include": ["apps-script/MasterData/**/*.ts"]`; `.gitignore` = RFQ `.gitignore` plus `runs/`. `.claude/settings.json`:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "mcp__claude_ai_Snowflake_-_ME_Data__sql",
  "hooks": [ { "type": "command", "command": "node refresh/capture-hook.mjs" } ] } ] } }
```

- [ ] **Step 2: Write failing tests.** `test/result.test.mjs`: `parseConnectorResult` on `sql-small.json` returns `numRows === rows.length`; on `sql-truncated.json` returns `rows.length < numRows`; on the array-wrapped form returns the same as the unwrapped form. Build fixtures from the two results saved in this session's design work (a 3-row object, and a copy of the 5,000-row query trimmed to 3 rows with `numRows: 5000`). `test/capture-hook.test.mjs`: spawning `node refresh/capture-hook.mjs` with `hook-input.json` on stdin and a temp cwd containing `runs/CURRENT = "r1"` writes `runs/r1/captures/0001.json` whose `sql` equals `tool_input.sql` and `response` equals the tool response text exactly; a second call writes `0002.json`; with no `runs/CURRENT` it writes nothing and exits 0; malformed stdin exits 0 (a hook must never break the session).
- [ ] **Step 3: Run** `npm test` → FAIL (modules missing).
- [ ] **Step 4: Implement** `parseConnectorResult` and `capture-hook.mjs` (reads stdin JSON `{tool_name, tool_input, tool_response, cwd}`; `tool_response` may be a string, an array of content blocks, or an object with `content` — take the concatenated text; resolve paths against `cwd`).
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `chore: scaffold repo and Snowflake capture hook`.

### Task 2: Spike S1 + S3 — hook and size limit in a cloud run

Not TDD: an experiment with recorded results.

**Files:** Create `.claude/skills/probe-connector/SKILL.md`, `docs/phase-0-findings.md`.

- [ ] **Step 1:** Write the probe skill: write `runs/CURRENT = probe-<timestamp>`; run via the connector (a) `SELECT 1 AS ONE`, (b) `SELECT COMPONENT_PRICE_ID FROM MECL_PLATFORM.ANALYTICS.COMPONENT_PRICE_ITEMS ORDER BY COMPONENT_PRICE_ID LIMIT 20000`, (c) the 13-column `COMPONENT_PRICE_ITEMS` query with `LIMIT 1200`, `2400`, `3600`; then run `node -e` to print, per capture file, `chars`, `rows.length`, `numRows`; commit nothing.
- [ ] **Step 2 (USER):** Create the private GitHub repo `askhisti/Purchasing-Master` and push `main`.
- [ ] **Step 3 (USER):** Create a one-off cloud scheduled task (`/schedule`, run now) on that repo, Snowflake connector only, prompt "Run the probe-connector skill and report its printed table."
- [ ] **Step 4:** Record in `docs/phase-0-findings.md`: did captures appear for (a) small and (b)/(c) large (>50k chars) results; does `response` contain the full JSON for large results; the largest `chars` that came back complete; the smallest that was truncated. **Pass:** captures exist for all queries and contain complete JSON. **Fail path:** if large results are not in `tool_response`, change Task 1's hook to also accept a file path argument and make the nightly skill pass the auto-saved result file path to `node refresh/cli.mjs next --file <path>` — revise Tasks 5 and 10 before continuing.
- [ ] **Step 5:** Set `TARGET_PAGE_CHARS` = min(250000, 0.75 × smallest truncated size) in the findings; commit `docs: phase 0 S1/S3 findings`.

### Task 3: Spike S2 — web app reachable from a cloud run (minimal receiver)

**Files:**
- Create: `apps-script/MasterData/.clasp.json`, `appsscript.json`, `Config.ts`, `WebApp.ts`, `test/webapp-auth.test.mjs`, `.claude/skills/probe-webapp/SKILL.md`

**Interfaces:**
- Produces: `doPost(e) -> ContentService.TextOutput` returning JSON `{ ok: boolean, error?: string, ... }`; `checkToken_(provided: string) -> boolean` (constant-time compare against Script Property `REFRESH_TOKEN`); action `ping` returns `{ ok: true, pong: true }`.
- Produces: `appsscript.json` with `"timeZone": "Europe/Berlin"`, `"runtimeVersion": "V8"`, `"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }`, scopes `spreadsheets`, `drive`, `script.container.ui`.
- Request body (all actions): JSON `{ "token": string, "action": string, ... }`.

- [ ] **Step 1: Failing test** `test/webapp-auth.test.mjs` (load `Config.ts` + `WebApp.ts` in `vm` with fake `PropertiesService`, `ContentService`, `LockService`): wrong or missing token → `{ ok:false, error:'unauthorized' }`; right token + `ping` → `{ ok:true, pong:true }`; unknown action → `{ ok:false, error:'unknown action' }`; non-JSON body → `{ ok:false, error:'bad request' }`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement `doPost`, `checkToken_`, and `setRefreshToken(token)` (editor-run helper that stores the property). Keep `.ts` files in plain JS syntax (no type annotations) so `vm` can load them.
- [ ] **Step 4:** `npm test && npm run validate` → PASS.
- [ ] **Step 5 (USER):** Create the empty Google Sheet `MasterData` in the Drive folder (Drive connector `create_file`, mimeType spreadsheet, parent `1lP59mBX1dM24emOJlussSvMPbkBiTTUk`); `clasp create --parentId <sheetId> --rootDir apps-script/MasterData`; `clasp push`; run `setRefreshToken` once in the editor with a new random 32-byte hex token; `clasp deploy` as web app. Record script ID, deployment ID, `/exec` URL in `docs/memory.md`.
- [ ] **Step 6 (USER):** In claude.ai cloud environments create environment `purchasing-master`: network Custom = default list + `script.google.com`, `script.googleusercontent.com`; secret token as a network secret, URL as an environment variable `MASTERDATA_WEBAPP_URL`.
- [ ] **Step 7:** Probe skill: `node -e` POST `{token, action:'ping'}` with `fetch(url, {method:'POST', redirect:'follow'})`, print status and body. Run it as a one-off cloud task in that environment. Record in findings: reachable (yes/no), how the secret reaches the process (env var name or injected header), response body. **Pass:** `{ok:true,pong:true}`. **Fail path:** Workspace forbids anonymous web apps or the host is unreachable → stop and switch to the GitHub `data`-branch transport (spec §5) — write a plan amendment replacing Task 7's client and Task 8's `doPost` with a pull trigger before continuing.
- [ ] **Step 8:** Commit `feat(apps-script): token-protected web app ping + S2 findings`.

### Task 4: Reconciliation R1 — explain the demand gap

Not code. Deliverable: `docs/reconciliation-demand.md`.

- [ ] **Step 1:** Pick 10 parts: ME_EC_0000001, ME_EC_0000002, the 4 highest-volume parts in Qlik `Component_View` 2027, 2 parts that are in 2 multisource clusters (e.g. ME_EC_0000519), 2 random.
- [ ] **Step 2:** For each, compare Qlik `Component_View` Usage 2026/2027 and Qlik `Project_View` per product against Snowflake `KPI_COMPONENT_DEMAND_BY_YEAR` (sourced by us), `KPI_COMPONENT_DEMAND_ALL_BASES_BY_YEAR`, and `COMPONENT_DEMAND_FORECAST` per product. Test each suspect: alternatives counted as usage (compare against `BOM_EXPLOSION` per source), inactive products, design-basis demand, products only in Qlik.
- [ ] **Step 3:** Write the table and a 5-line conclusion naming the cause(s) and the share of the gap each explains; show the SQL used (platform rule answer-01). Commit `docs: R1 demand reconciliation`.

**Gate:** Before Phase 1, report Tasks 2–4 to the user. Phase 1 assumes S1 and S2 passed.

---

## Phase 1 — MasterData

### Task 5: Feed manifest and SQL

**Files:**
- Create: `sql/feeds.json`, `sql/health.sql`, `sql/feeds/components.sql`, `multisource.sql`, `multisource_members.sql`, `component_usage.sql`, `products.sql`, `mecl_price.sql`, `refresh/lib/manifest.mjs`, `test/manifest.test.mjs`, `docs/sheets.md`

**Interfaces:**
- Produces `sql/feeds.json`: `{ "feeds": [ { "feed": string, "tab": string, "sqlFile": string, "pageLimit": number, "columns": [ { "sql": string, "header": string, "type": "string"|"number"|"boolean"|"date" } ], "demandYears"?: { "sqlPrefix": "DEMAND_Y", "count": 11 } } ] }`. Feed order and tab names: `components→Components`, `multisource→Multisource`, `multisource_members→Multisource_Members`, `component_usage→Component_Usage`, `products→Products`, `mecl_price→MECL_Price`. Headers exactly as spec §6 (demand headers generated as `Demand <BASE_YEAR+k>`, appended after the listed columns).
- Produces `loadManifest(path?: string) -> Manifest` and `headersFor(feed, baseYear: number) -> string[]` and `sqlColumnsFor(feed) -> string[]` (ROW_KEY not included) in `refresh/lib/manifest.mjs`.
- SQL file rules: a single `SELECT` whose first column is `ROW_KEY` (unique string per row), then the manifest columns as UPPERCASE aliases in manifest order, then `DEMAND_Y0 … DEMAND_Y10` where applicable; the only placeholder is `{{BASE_YEAR}}`; no `ORDER BY`/`LIMIT` (added by Task 6).
- `sql/health.sql` returns one row: `BASE_YEAR` (= `YEAR(CONVERT_TIMEZONE('Europe/Berlin', CURRENT_TIMESTAMP()))`), `PROBLEM_COUNT`, `PROBLEM_LIST`, and `REFRESHED_AT_<VIEW>` for each source view that has `REFRESHED_AT`.

Pinned SQL decisions (spec §6 definitions):
- `components`: one row per `COMPONENT_CATALOG` component; ROW_KEY = ME_EC. Demand joined on `PART_ID = COMPONENT_ID`, `IS_SOURCED_BY_US`, pivot `SUM(IFF(DEMAND_YEAR = {{BASE_YEAR}} + k, TOTAL_DEMAND, 0))`. `ME_MS` = `LISTAGG(DISTINCT MS_PART_NUMBER, ', ') WITHIN GROUP (ORDER BY MS_PART_NUMBER)` over usable memberships; `Primary ME_MS` = `MAX(MS_PART_NUMBER)` over usable memberships. `EMS Part Numbers` from `SC_EMS_PART` where `IS_IN_LATEST_SNAPSHOT`, keyed by `PRIMARY_COMPONENT_ID`, formatted `EMS_CODE:EMS_PART`.
- `multisource`: ROW_KEY = ME_MS; demand = sum over that cluster's usable members only.
- `multisource_members`: ROW_KEY = `ME_MS|ME_EC`; all member statuses, with `Is Usable`.
- `component_usage`: ROW_KEY = `ME_EC|PRODUCT_ID`; from `COMPONENT_DEMAND_FORECAST` where `IS_SOURCED_BY_US`, pivot by `DEMAND_YEAR`.
- `products`: ROW_KEY = PRODUCT_ID from `PRODUCT_CATALOG`; `Sample Phase` = `PRODUCT_SAMPLE_PHASE`, `SOP` = `START_OF_PRODUCTION`.
- `mecl_price`: ROW_KEY = `COMPONENT_PRICE_ID|COALESCE(PART_NUMBER,'')`; `Resolved ME_EC` = `PART_NUMBER` if linked, else the catalog component whose `UPPER(TRIM(MANUFACTURER_PARTNUMBER))` equals `UPPER(TRIM(QUOTED_MANUFACTURER_PARTNUMBER))` when exactly one matches, else NULL. Dates `TO_CHAR(…, 'YYYY-MM-DD')`; decimals cast to `FLOAT` (drops trailing zeros).

- [ ] **Step 1: Verify the open column facts with the connector before writing SQL** and note results in `docs/sheets.md`: which `COMPONENT_CATALOG` column holds the `ME_EC_…` number (`SUPPLIER_PARTNUMBER` expected); distinct `PLATFORM_HEALTH.AREA` values; that `PRODUCT_CATALOG.PRODUCT_SAMPLE_PHASE` and `START_OF_PRODUCTION` hold what the names say.
- [ ] **Step 2: Failing test** `test/manifest.test.mjs`: every feed's `sqlFile` exists; its first selected alias is `ROW_KEY`; every `columns[].sql` appears as an alias in that file; `DEMAND_Y0`…`DEMAND_Y10` present iff `demandYears`; `{{BASE_YEAR}}` is the only `{{…}}` placeholder; no `ORDER BY`/`LIMIT` at the top level; `headersFor('components', 2026)` ends with `'Demand 2026', …, 'Demand 2036'`; tab names and header lists equal spec §6 exactly (copy them into the test as literals).
- [ ] **Step 3:** `npm test` → FAIL.
- [ ] **Step 4:** Write `feeds.json`, the SQL files, `health.sql`, `manifest.mjs`, and `docs/sheets.md` (one section per tab: key, source views, columns with type and meaning — copied from spec §6 and its definitions).
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6: Live check through the connector** (base year 2026): for each feed run `SELECT COUNT(*) AS ROW_COUNT, COUNT(DISTINCT ROW_KEY) AS KEY_COUNT FROM (<sql>)` → counts equal; and `SELECT * FROM (<sql>) ORDER BY ROW_KEY LIMIT 5` → plausible values. Spot check: `components` Demand 2026 for ME_EC_0000001 equals `KPI_COMPONENT_DEMAND_BY_YEAR` TOTAL_DEMAND for that part and year; `mecl_price` count of rows with non-null `Resolved ME_EC` ≥ count of linked rows. Record counts in `docs/sheets.md`.
- [ ] **Step 7:** Commit `feat(sql): feed manifest, feed SQL and tab contracts`.

### Task 6: SQL builders and page sizing

**Files:** Create `refresh/lib/sql.mjs`, `test/sql.test.mjs`

**Interfaces:**
- Produces: `renderFeedSql(sqlText: string, baseYear: number) -> string` (replaces `{{BASE_YEAR}}`; throws on any other placeholder or a non-integer year).
- Produces: `buildCountSql(feedSql: string) -> string` = `SELECT COUNT(*) AS ROW_COUNT, COUNT(DISTINCT ROW_KEY) AS KEY_COUNT FROM (<feedSql>)`.
- Produces: `buildPageSql(feedSql: string, afterKey: string|null, limit: number) -> string` = `SELECT * FROM (<feedSql>) [WHERE ROW_KEY > '<afterKey escaped>'] ORDER BY ROW_KEY LIMIT <limit>`.
- Produces: `nextLimit(prevLimit: number, chars: number, rowsReturned: number, target = 250000) -> number` = `floor(target / (chars / rowsReturned))`, clamped to [100, 20000].
- Produces: `shrinkLimit(limit: number, rowsReturned: number, numRows: number) -> number` = `max(100, floor(limit * rowsReturned / numRows * 0.8))`.

- [ ] **Step 1: Failing tests:** `buildPageSql(s, "A'B", 10)` contains `ROW_KEY > 'A''B'`; `afterKey = null` has no `WHERE`; `renderFeedSql('…{{BASE_YEAR}}…', 2027)` contains `2027` and no `{{`; `renderFeedSql('{{X}}', 2027)` throws; `nextLimit(2000, 339594, 2137)` = 1573; `nextLimit(2000, 1000, 1000)` = 20000; `shrinkLimit(5000, 2137, 5000)` = 1709.
- [ ] **Step 2:** `npm test` → FAIL. **Step 3:** implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(refresh): SQL builders and adaptive page sizing`.

### Task 7: Run state machine (`cli.mjs begin | next`)

**Files:** Create `refresh/lib/state.mjs`, `refresh/cli.mjs`, `test/cli-next.test.mjs`, fixtures under `test/fixtures/run/`

**Interfaces:**
- Consumes: Task 1 `parseConnectorResult`, capture file format, `runs/CURRENT`; Task 5 `loadManifest`; Task 6 builders.
- Produces state file `runs/<runId>/state.json`: `{ runId, startedAt, baseYear|null, phase: 'health'|'feeds'|'fetched'|'failed', feedIndex, step: 'count'|'page', afterKey, limit, expected: {rowCount, keyCount}|null, pages: [{captureSeq, rows, firstKey, lastKey}], pendingSql, health: {...}|null, failure: string|null }`.
- Produces CLI contract (stdout is what Claude acts on; exactly one of):
  - `RUN_SQL` newline + the SQL text → Claude runs exactly that SQL with the connector, then calls `next` again.
  - `FETCHED` → all feeds fetched; Claude calls `finish`.
  - `ABORT <reason>` → Claude calls `fail "<reason>"` and stops.
- `begin`: run id = Berlin local `YYYY-MM-DDTHH-mm-ss`; writes `runs/CURRENT`; state phase `health`; prints `RUN_SQL` + `sql/health.sql`.

`next` algorithm (the plan fixes this; implement exactly):

```
c = newest capture with seq > last consumed seq
if c missing or c.sql != state.pendingSql        -> ABORT "expected result of the pending SQL"
r = parseConnectorResult(c.response)
phase health: PROBLEM_COUNT > 0 -> ABORT "platform health: <PROBLEM_LIST>"
              else baseYear = BASE_YEAR; phase feeds, feed 0, step count
step count:   if ROW_COUNT != KEY_COUNT -> ABORT "<feed>: duplicate ROW_KEY"
              expected = counts; step page, afterKey null, limit = feed.pageLimit
step page:    if r.rows.length < r.numRows -> limit = shrinkLimit(...); reissue same page (do not store)
              else store page; afterKey = last ROW_KEY; limit = nextLimit(...)
                   if r.rows.length < requested limit (or 0): feed done ->
                        sum(pages.rows) != expected.rowCount -> ABORT "<feed>: expected N rows, fetched M"
                        next feed (step count) or phase fetched
print RUN_SQL for the new pendingSql, or FETCHED
```

- [ ] **Step 1: Failing tests** (temp dir, fixture captures written by the test): happy path over a 2-feed mini manifest → sequence count/page/page/count/page → `FETCHED`; truncated page → next SQL repeats the same `afterKey` with a smaller `LIMIT` and the truncated rows are not counted; count 10 but pages return 9 → `ABORT … expected 10 rows, fetched 9`; `ROW_COUNT != KEY_COUNT` → `ABORT … duplicate ROW_KEY`; capture SQL differs from pending → `ABORT expected result of the pending SQL`; health `PROBLEM_COUNT 2` → `ABORT platform health: …`; `baseYear` comes from the health result (fixture `BASE_YEAR 2027`), and later `RUN_SQL` texts contain `2027`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(refresh): run state machine (begin/next)`.

### Task 8: Apps Script receiver — begin, chunk, commit

**Files:**
- Modify: `apps-script/MasterData/WebApp.ts`, `Config.ts`
- Create: `apps-script/MasterData/Core.ts`, `Sheets.ts`, `Store.ts`, `test/apps-script-core.test.mjs`, `test/apps-script-webapp.test.mjs`

**Interfaces:**
- Consumes: Task 3 `doPost`, `checkToken_`.
- Config constants: `FOLDER_ID = '1lP59mBX1dM24emOJlussSvMPbkBiTTUk'`, `SNAPSHOT_FOLDER_NAME = 'Raw snapshots'`, `RETENTION_DAYS = 30`, `MAX_ROW_DROP = 0.2`, `LOG_SHEET = '_Refresh_Log'`, `STAGING_PREFIX = '__staging_'`, `TABS` (the six tab names in manifest order).
- Protocol (JSON bodies, all with `token`):
  - `{action:'begin', runId, baseYear, feeds:[{feed, tab, headers, types, rowCount}], health}` → clears all `__staging_*` tabs and any snapshot parts of other runs; stores the run in Script Properties `ACTIVE_RUN`; creates staging tabs with headers; returns `{ok:true}`.
  - `{action:'chunk', runId, feed, seq, rowsB64Gzip}` where the payload is gzip(JSON `string|number|boolean|null[][]`) → rejects if `runId != ACTIVE_RUN`; appends rows to the staging tab; saves the chunk as CSV part `Raw snapshots/<date>/<feed>.part<seq>.csv` (no header); returns `{ok:true, stagedRows}`.
  - `{action:'commit', runId}` → for every feed: staged rows == `rowCount`, else fail; `checkRowDrop_`; assemble `<feed>.csv` (header + parts in seq order) and delete parts; swap staging → live; write log; set "Last successful refresh"; prune snapshot folders older than 30 days; store per-feed counts in `LAST_ROW_COUNTS`; clear `ACTIVE_RUN`. Returns `{ok:true, feeds:[{feed, rows}]}`. On any failure: log status `FAILED` with message, leave live tabs untouched, return `{ok:false, error}`.
  - `{action:'fail', runId, reason}` → log `FAILED` with reason; clear staging; returns `{ok:true}`.
  - Every action runs under `LockService.getScriptLock().waitLock(30000)`.
- Pure functions in `Core.ts` (vm-tested): `checkRowDrop_(prev: {[feed]:number}|null, next: {[feed]:number}, maxDrop: number) -> string|null` (message or null); `toCsv_(headers: string[]|null, rows: any[][]) -> string` (RFC 4180 quoting, `\n` line ends, booleans `TRUE`/`FALSE`, null → empty); `columnFormats_(types: string[]) -> string[]` (`string`→`'@'`, `date`→`'yyyy-mm-dd'`, `number`→`'0.######'`, `boolean`→`'General'`); `logRows_(run, feeds, status, message) -> any[][]`; `isExpiredSnapshotFolder_(name: string, today: string, retentionDays: number) -> boolean` (name `YYYY-MM-DD`; non-date names never expire).
- `_Refresh_Log` layout: `A1 = 'Last successful refresh'`, `B1` = ISO timestamp of the last successful commit, `A2 = 'Base year'`, `B2` = base year; headers in row 4 `Run ID | Started | Finished | Feed | Rows | Source Refreshed At | Status | Message`, newest rows inserted at row 5.

- [ ] **Step 1: Failing tests** `test/apps-script-core.test.mjs`: `checkRowDrop_({mecl_price:1000},{mecl_price:799},0.2)` returns a message naming `mecl_price`; `…800…` returns null; `prev=null` returns null; `toCsv_(['A','B'],[['x,y','he said "hi"'],[null,true]])` = `'A,B\n"x,y","he said ""hi"""\n,TRUE\n'`; a value containing `\n` is quoted; `columnFormats_(['string','date','number','boolean'])` = `['@','yyyy-mm-dd','0.######','General']`; `isExpiredSnapshotFolder_('2026-09-29','2026-10-30',30)` = true, `'2026-09-30'` = false, `'notes'` = false.
- [ ] **Step 2: Failing tests** `test/apps-script-webapp.test.mjs` with in-memory fakes for `SpreadsheetApp` (sheets as arrays, `setNumberFormats` recorded), `DriveApp` (folders/files map), `Utilities` (`gzip`/`ungzip`/`base64Decode` backed by Node `zlib`/`Buffer`), `PropertiesService`, `LockService`: begin → 2 chunks → commit produces live tab rows equal to the sent rows, string columns formatted `@` **before** values are written (assert call order), `<feed>.csv` with header + both chunks in seq order, log row `OK`, `B1` set; commit with staged 9 vs `rowCount` 10 → `{ok:false}`, live tab unchanged, log `FAILED`; chunk with a different `runId` → `{ok:false, error:'not the active run'}`; begin for a new run removes staging tabs left by an earlier run; row drop > 20% → `{ok:false}` and live unchanged.
- [ ] **Step 3:** `npm test` → FAIL. **Step 4:** implement `Core.ts`, `Store.ts`, `Sheets.ts`, extend `WebApp.ts` (plain JS syntax). Swap = delete live tab if present, rename staging, keep tab order = `TABS`. **Step 5:** `npm test && npm run validate` → PASS.
- [ ] **Step 6:** Commit `feat(apps-script): staged receiver with validation, snapshots and log`.

### Task 9: Shape and push (`cli.mjs finish | fail`)

**Files:** Create `refresh/lib/shape.mjs`, `refresh/lib/push.mjs`, `test/shape.test.mjs`, `test/push.test.mjs`; modify `refresh/cli.mjs`

**Interfaces:**
- Consumes: Task 7 state (phase `fetched`, pages per feed), Task 1 parser, Task 5 `headersFor`, Task 8 protocol.
- Produces: `shapeFeed(feedDef, baseYear, rawRows: string[][], sqlColumns: string[]) -> { headers: string[], types: string[], rows: (string|number|boolean|null)[][] }` — drops `ROW_KEY`; converts by type: `number` → `Number` (empty → null), `boolean` → `true/false` from `'true'/'false'` (case-insensitive), `date` → first 10 chars `YYYY-MM-DD` (empty → null), `string` → as-is (empty → null).
- Produces: `chunkRows(rows, maxBytes = 2000000) -> string[]` (each item = base64(gzip(JSON slice)) under `maxBytes`); `postJson(url, body) -> Promise<object>` (`fetch` POST, `redirect:'follow'`, 3 attempts with 5 s / 20 s backoff on network error or 5xx; parses JSON; throws on `{ok:false}` with its `error`).
- `finish`: re-verify every feed (pages sum == expected, no duplicate keys across pages) → shape → `begin` → all `chunk`s → `commit`; prints `DONE <feed>=<rows> …` or `FAILED <message>` (exit code 1). `fail "<reason>"`: POST `fail`; prints `FAILED <reason>`.
- URL and token from environment variables `MASTERDATA_WEBAPP_URL` and the token mechanism recorded in Task 3 findings.

- [ ] **Step 1: Failing tests** `test/shape.test.mjs`: MPN `'0402'` stays the string `'0402'`; `'1E3'` stays `'1E3'`; number `'4.730000000'` → `4.73`; `''` number → `null`; date `'2022-08-25 00:00:00.000'` → `'2022-08-25'`; headers for base year 2027 end with `'Demand 2037'`; `ROW_KEY` not in output. `test/push.test.mjs` with a local `http` server: chunk sizes all ≤ `maxBytes` and round-trip to the original rows; a 503 then 200 succeeds with one retry; `{ok:false,error:'x'}` throws `x`; `finish` against the fake server sends `begin`, chunks in seq order, `commit`, in that order.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(refresh): shape and push to MasterData`.

### Task 10: Nightly-refresh skill, release script, first live run

**Files:** Create `.claude/skills/nightly-refresh/SKILL.md`, `scripts/release-gas.mjs`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/memory.md` (update); delete the two probe skills.

**Interfaces:**
- Consumes: CLI contract from Tasks 7 and 9.
- Skill content (exact rules): run `node refresh/cli.mjs begin`; loop: if output starts with `RUN_SQL`, call `mcp__claude_ai_Snowflake_-_ME_Data__sql` with exactly the SQL that follows (no edits), then `node refresh/cli.mjs next`; on `FETCHED` run `node refresh/cli.mjs finish`; on `ABORT <reason>` run `node refresh/cli.mjs fail "<reason>"`; never read, summarise or re-type result rows; end with the final CLI line as the report. If the connector call itself errors, run `fail "connector error: <message>"`.
- `release-gas.mjs`: single target `apps-script/MasterData`; `npm test && npm run validate` → `clasp push` → `clasp version "<desc>"` → `clasp deploy -i <deploymentId> -d "<desc>"` (same `/exec` URL). Same clasp path handling as the RFQ script.

- [ ] **Step 1:** Write the skill, release script and docs (`ARCHITECTURE.md`: flow and files; `TESTING.md`: `npm test`, `npm run validate`, the manual live-run checklist below; `memory.md`: IDs, URLs, findings).
- [ ] **Step 2:** `npm test && npm run validate` → PASS.
- [ ] **Step 3 (USER):** `npm run release -- "phase 1 receiver"`; push `main` to GitHub.
- [ ] **Step 4 (USER):** One-off cloud task in environment `purchasing-master`, Snowflake connector only, prompt "Run the nightly-refresh skill." 
- [ ] **Step 5: Live-run checklist:** final line `DONE` with six feeds; `_Refresh_Log` row `OK` per feed and `B1` = today; the six tabs exist with headers exactly as `docs/sheets.md`; `Components` row ME_EC_0000001 Demand <Y> equals the Snowflake value queried directly; a part number with a leading zero shows the zero; `Raw snapshots/<today>/` has six CSVs with header + row counts matching the log; Snowflake connector calls in the run ≤ 45.
- [ ] **Step 6:** Commit `feat: nightly refresh skill, release script, docs`.

### Task 11: Schedule at 07:00 and failure drill

- [ ] **Step 1 (USER):** `/schedule` → daily 07:00 Europe/Berlin, repo `askhisti/Purchasing-Master`, environment `purchasing-master`, connectors: Snowflake – ME Data only, prompt "Run the nightly-refresh skill."
- [ ] **Step 2: Failure drill** (one-off runs on a throwaway branch, never merged): restrict `sql/feeds/products.sql` to 10 rows with `QUALIFY ROW_NUMBER() OVER (ORDER BY PRODUCT_ID) <= 10` → run → `_Refresh_Log` shows `FAILED` with the row-drop message and the live `Products` tab is unchanged. Then a wrong token in the environment → run output `FAILED unauthorized`, MasterData untouched; restore the token.
- [ ] **Step 3:** After 3 consecutive scheduled mornings, record in `docs/memory.md`: run durations, connector calls, any failures. Commit `docs: schedule live, first runs`.

---

## Self-review notes

- Spec coverage: §5 flow → Tasks 1, 6–10; §6 tabs and definitions → Task 5; snapshots/retention/log → Task 8; 07:00 schedule → Task 11; phase 0 S1/S2/S3/R1 → Tasks 2–4; fallback transport → Task 3 fail path (amendment); §7 consumer needs are satisfied by Task 5's columns (RFQ/Alternatives DB/LOA adaptations are phase 2, out of this plan).
- Not in this plan by design: consumer adaptations (phase 2), analysis tabs (phase 3).
