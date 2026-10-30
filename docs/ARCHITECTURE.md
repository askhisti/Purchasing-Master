# Architecture

## Flow

1. A cloud task (environment `purchasing-master`, 07:00 Europe/Berlin) runs the `nightly-refresh` skill with the Snowflake connector only.
2. The skill drives `refresh/cli.mjs` (`begin`, `next` loop, `finish` / `fail`). The CLI hands out one SQL at a time; the skill runs it through the connector.
3. A PostToolUse hook (`.claude/settings.json` -> `refresh/capture-hook.mjs`) saves each connector result under `runs/<runId>/captures/` while `runs/CURRENT` exists. The model never sees or copies rows.
4. `next` compares the captured SQL with the pending SQL (whitespace-normalised), parses the result, and plans the next query: health check, then per feed a count query and keyset pages.
5. `finish` re-reads the captures, shapes the rows, and POSTs them to the Apps Script web app (`begin`, `chunk`, `commit`).
6. The web app writes the MasterData tabs, a Raw snapshots CSV per feed, and `_Refresh_Log`.

## Files

| Path | Responsibility |
|---|---|
| `.claude/skills/nightly-refresh/SKILL.md` | Rules for the cloud run (drive the CLI, no editing of SQL, no row handling) |
| `.claude/settings.json` | Registers the capture hook |
| `refresh/capture-hook.mjs` | Saves connector results while a run is active |
| `refresh/cli.mjs` | Commands `begin`, `next`, `finish`, `fail`; run state machine |
| `refresh/lib/manifest.mjs`, `sql/feeds.json` | Feed definitions: tab, columns, types, page limit |
| `refresh/lib/sql.mjs`, `sql/health.sql`, `sql/feeds/*.sql` | SQL rendering, count and keyset page queries |
| `refresh/lib/result.mjs` | Parses connector results |
| `refresh/lib/shape.mjs` | Converts raw rows to typed sheet rows |
| `refresh/lib/push.mjs` | Chunking (gzip + base64) and HTTP POST with retry |
| `refresh/lib/state.mjs` | Run id, state file, capture lookup |
| `apps-script/MasterData/Config.ts` | Constants (token property, folder name, row-drop limit, log sheet) |
| `apps-script/MasterData/WebApp.ts` | `doPost`: token check, script lock, actions |
| `apps-script/MasterData/Sheets.ts` | Staging tabs, swap into live tabs, `_Refresh_Log` |
| `apps-script/MasterData/Store.ts`, `Core.ts` | Run storage and shared helpers |
| `scripts/release-gas.mjs`, `scripts/release-config.json` | Release: tests, clasp push, version, deploy to the fixed deployment |
| `docs/sheets.md` | Tab and header contract |

## Protocol (web app actions)

All requests are JSON POSTs with `token`.
- `begin`: `runId`, `baseYear`, per-feed `{feed, tab, headers, types, rowCount}`, `health`.
- `chunk`: `runId`, `feed`, increasing `seq`, `rowsB64Gzip`.
- `commit`: validates everything, then swaps staging into live tabs. May return a `warning`.
- `fail`: `runId`, `reason`. Always logged; cleans up if it is the active run.

## Safety rules

- Everything that can reject a run happens before any live tab is touched.
- Staging tabs are swapped into the live tabs while keeping live tab identity (sheet ids and references stay valid).
- Row-drop guard: a feed whose row count falls more than 20% (`MAX_ROW_DROP`) below the previous run is rejected.
- Every action runs under the script lock; begin/chunk/commit/fail never interleave.
- Health check (`sql/health.sql`) must report zero problems, else the run aborts before fetching.
- Duplicate `ROW_KEY`, count mismatch, or a truncated page at minimum size abort the run.
- If the `commit` request ends in a transient error the outcome is unknown: the CLI reports `FAILED commit status unknown` and the run state is `unknown`; check `_Refresh_Log` before retrying.
- The skill must not edit repo files or commit.
