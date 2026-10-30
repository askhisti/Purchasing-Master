# Testing

## Commands

- `npm test`: `node --test "test/*.test.mjs"`.
- `npm run validate`: `tsc --noEmit -p tsconfig.json` (type check of the Apps Script sources).

## What the automated tests cover

- Refresh CLI logic: manifest, SQL rendering, result parsing, shaping, chunking and push with a fake fetch, the `next` state machine with fixture captures, the capture hook.
- Apps Script code (`Core`, `Sheets`, `WebApp`) loaded in Node `vm` against fake SpreadsheetApp, DriveApp, Properties and Lock services: token auth, actions, staging and swap, log, guards.
- Release config validation (`scripts/release-lib.mjs`).

## What they do not cover

- Real Google services: `getActiveSpreadsheet()` in `doPost`, real sheet type coercion, tab ordering in a real spreadsheet, Drive folders, quotas and execution time limits.
- The real Snowflake connector, result sizes, hook behaviour in the cloud, and network reachability.
- `scripts/release-gas.mjs` itself (the clasp calls) is untested by design; only its config validation is unit-tested.

## Manual live-run checklist

Run once in the cloud environment `purchasing-master` with the prompt "Run the nightly-refresh skill." (Snowflake connector only).

- [ ] Final line is `DONE` with six feeds.
- [ ] `_Refresh_Log` has a row `OK` per feed and `B1` = today.
- [ ] The six tabs exist with headers exactly as in `docs/sheets.md`.
- [ ] `Components` row ME_EC_0000001 Demand <Y> equals the Snowflake value queried directly.
- [ ] A part number with a leading zero shows the zero.
- [ ] `Raw snapshots/<today>/` has six CSVs with header and row counts matching the log.
- [ ] Snowflake connector calls in the run are <= 45.
- [ ] `getActiveSpreadsheet()` works inside `doPost` of the bound web app.
- [ ] A part number with a leading zero (e.g. 0402) and `1E3` stay text.
- [ ] Tab order is correct after the swap (`moveActiveSheet` without UI).
- [ ] A string starting with `=` is stored as text, not a formula.
- [ ] Number columns show without a trailing dot.
