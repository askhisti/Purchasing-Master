# Purchasing MasterData: direct Snowflake export (IT handover)

The MasterData Google Sheet is filled every night from Snowflake. The sheet's own Apps Script already does all of the loading. It picks up files from a Drive folder (the **Inbox**), checks them and swaps them into the tabs. What we need from IT is a scheduled job that runs our SQL in Snowflake and puts the results into the Inbox in the format below. Nothing in the sheet or its script has to change.

```
Snowflake (MECL_PLATFORM.ANALYTICS)
   │  IT job, nightly after the ~05:45 platform refresh
   ▼
Drive Inbox  ── 8 x <runId>__<feed>.json.gz, then <runId>__manifest.json
   │  MasterData Apps Script (pollInbox, every 5 min) – already live
   ▼
MasterData sheet: 8 tabs + _Refresh_Log
```

## What is where

| What | Where |
|---|---|
| MasterData sheet | Shared with you separately |
| Drive Inbox (shared drive "03_Master File from Snowflake/Inbox") | folder id `1PE6IcZqJFHM7ISA4XKNHpifk8oCVyqdV` |
| Ready-to-run SQL, one file per feed, plus the health check | [`handover/2026/`](../handover/2026/) |
| Exact headers and types per feed | [`handover/2026/manifest-template.json`](../handover/2026/manifest-template.json) |
| Reference implementation of the file format (Node) | [`refresh/lib/inbox.mjs`](../refresh/lib/inbox.mjs) `buildPayload`, [`refresh/lib/shape.mjs`](../refresh/lib/shape.mjs) |
| What the sheet checks on arrival | [`apps-script/MasterData/Puller.ts`](../apps-script/MasterData/Puller.ts), `validateBegin_` in [`Core.ts`](../apps-script/MasterData/Core.ts) |
| Tab and column meaning | [`docs/sheets.md`](sheets.md), [`docs/snowflake-views.md`](snowflake-views.md) |

## Nightly job, step by step

1. **Health check.** Run `00_health.sql` (one row). If `PROBLEM_COUNT > 0`, upload a *failed* manifest (see below) and stop. That way the sheet logs the reason and keeps yesterday's data.
2. **Run the 8 feed queries** `01_…sql` to `08_…sql`. They are plain SELECTs on `MECL_PLATFORM.ANALYTICS`, read only, and end in `ORDER BY ROW_KEY`.
3. **Build one data file per feed** (format below), gzip it and compute its SHA-256.
4. **Upload to the Inbox**: the 8 data files first, **the manifest last**. The sheet only starts on a run once its manifest is there.
5. Within about 15 minutes, `_Refresh_Log` in the sheet shows one `OK` row per tab. If it shows `FAILED`, the message column gives the reason.

Today's sizes (2026-11-04): components 2,777 rows, multisource 432, multisource_members 895, component_usage 3,478, products 56, mecl_price 20,856, product_volumes 56, bom_coverage 11.

## The SQL changes once a year

`Components` and `Product_Volumes` have rolling columns. Within a year they are fixed; on **1 January** they shift:

- yearly totals from **2025** to **current year + 10**;
- monthly columns only for the **current and next year**, each year's 12 months placed just before that year's total.

For 2026 that is `Demand 2025 | 2026-01 … 2026-12 | Demand 2026 | 2027-01 … 2027-12 | Demand 2027 | Demand 2028 … Demand 2036`. In Product_Volumes the totals are called `Units <year>`.

`handover/2026/` is rendered for 2026. For another year, regenerate the pack from the repo (Node 20+, no install needed):

```
node scripts/it-handover.mjs 2027        # writes handover/2027/
```

Either regenerate the pack each December, or have your job render the files from the templates in `sql/feeds/*.sql` with this rule. The year used must match `baseYear` in the manifest. Use the current year in Europe/Berlin.

## Data file: `<runId>__<feed>.json.gz`

- gzip of UTF-8 JSON: **an array of rows; each row is an array** of cell values.
- Drop the first SQL column (`ROW_KEY`). The rest stay in SQL order, which equals the `headers` order in `manifest-template.json` (`sqlColumns` lists the SQL names in the same order).
- `ROW_KEY` must be unique within a feed. The queries guarantee it; a duplicate means something is wrong.
- Cell values by the column's type in the manifest:

| type | JSON value | note |
|---|---|---|
| `string` | string | |
| `number` | number | Snowflake NUMBER/FLOAT as a JSON number (not a string); must be finite |
| `boolean` | `true` / `false` | |
| `date` | `"YYYY-MM-DD"` | date part only |
| any | `null` | Snowflake NULL or an empty string |

Example (bom_coverage, 2 rows, values illustrative): `[[2025,812000,640000,78.8],[2026,937252,782606,83.5]]`

## Manifest: `<runId>__manifest.json` (plain JSON, uploaded last)

Copy `manifest-template.json` and fill in the `<…>` placeholders:

```json
{
  "version": 1,
  "runId": "2026-11-05T06-15-00",
  "status": "ready",
  "baseYear": 2026,
  "startedAt": "2026-11-05T05:15:00.000Z",
  "publishedAt": "2026-11-05T05:21:40.000Z",
  "health": null,
  "feeds": [
    { "feed": "components", "tab": "Components", "headers": ["ME_EC", "..."], "types": ["string", "..."],
      "rowCount": 2777, "file": "2026-11-05T06-15-00__components.json.gz", "sha256": "3f1c…(64 hex)" }
  ]
}
```

- **runId**: `YYYY-MM-DDTHH-mm-ss`, the job's start time in **Europe/Berlin**, and the same prefix on every file of the run. Each run needs a new runId that sorts after the last one. A runId at or before the last processed run is ignored, and one more than a day in the future is rejected.
- **feeds**: all 8, each exactly once. `headers` and `types` are copied unchanged from the template. `rowCount` = rows in the data file. `sha256` = lowercase hex SHA-256 of the **.gz bytes** as uploaded.
- **health**: optional. Leave it `null`, or put the health query's row in as an object; the values of `REFRESHED_AT_SC_EMS_PART` and `REFRESHED_AT_COMPONENT_WHERE_USED` then appear in the log.
- **Failed run** (health problem or export error): upload only a manifest with `"status": "failed"`, `"reason": "<text>"`, `"feeds": []`. `baseYear` and `health` may be `null` there.

## What makes the sheet reject a run

The sheet then logs `FAILED` and keeps the previous data:

- a missing or extra feed, header count ≠ type count, unknown type, wrong file name;
- SHA-256 or row count not matching the data file, or a row with the wrong number of cells;
- **any feed whose row count falls more than 20 % below the previous run** (protects against half-empty exports);
- data files without a manifest are cleaned up after 3 days and logged `INCOMPLETE`.

The sheet does not check header names or column meaning, so a renamed or swapped column would load silently. The "Create manufacturer file" menu in the sheet finds its columns by header name, so keep headers and column order exactly as in the template.

## Drive access

- The Inbox is in a shared drive. Your uploader needs at least **Contributor** on it. Drive API calls need `supportsAllDrives=true`.
- Use your own service account or connector. The existing uploader key stays with its owner and is not part of this handover.
- The sheet's script removes processed files itself. Please don't delete files from the Inbox while a run is in progress.

## Switching over

Today the same files are produced by a Claude-driven job (`refresh/cli.mjs` and the `nightly-refresh` skill). When your job has run successfully for a few nights, that job is switched off. Running both in parallel is harmless: the sheet loads each run in runId order, so the later run simply replaces the earlier one.

## Contact

Business owner: Purchasing (owner of this repository). Questions about columns or SQL logic: see `docs/snowflake-views.md` first.
