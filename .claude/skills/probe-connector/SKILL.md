---
name: probe-connector
description: Spike S1+S3 probe. Runs fixed Snowflake queries through the connector so the capture hook saves each result, then prints per-capture size stats (seq, chars, rows, numRows, shape). Use in a cloud run to learn whether the hook fires and where results get truncated.
---

# probe-connector

Experiment only. Commit nothing. Do not paraphrase results; the capture files are the evidence.

## 1. Arm the capture hook

Run:

```
node -e "const id='probe-'+new Date().toISOString().replace(/[:.]/g,'-');require('fs').mkdirSync('runs',{recursive:true});require('fs').writeFileSync('runs/CURRENT',id);console.log(id)"
```

## 2. Run these queries, in order, with the Snowflake `sql` tool (one call each, no edits)

a. `SELECT 1 AS ONE`

b. `SELECT COMPONENT_PRICE_ID FROM MECL_PLATFORM.ANALYTICS.COMPONENT_PRICE_ITEMS ORDER BY COMPONENT_PRICE_ID LIMIT 20000`

c. Three calls of the 13-column query with `LIMIT 1200`, then `LIMIT 2400`, then `LIMIT 3600`:

```
SELECT COMPONENT_PRICE_ID, PART_NUMBER, PRICE_TYPE, PRICE_OWNER_NAME, VENDOR, VOLUME_STAGE, PRICE_YEAR, PRICE_PER_UNIT, CURRENCY, QUOTE_VALID_START, QUOTE_VALID_END, QUOTED_MANUFACTURER, QUOTED_MANUFACTURER_PARTNUMBER FROM MECL_PLATFORM.ANALYTICS.COMPONENT_PRICE_ITEMS ORDER BY COMPONENT_PRICE_ID LIMIT <n>
```

with n = 1200, 2400, 3600. The connector accepts SELECT only; these column names are confirmed, do not alter them. If a call errors, copy the exact error text into the report as an extra row under the table and continue with the next query. The same applies to a truncated result or one saved to a file.

## 3. Print the capture table

Run exactly:

```
node --input-type=module -e "
import fs from 'node:fs';
import path from 'node:path';
import { parseConnectorResult } from './refresh/lib/result.mjs';
const id = fs.readFileSync('runs/CURRENT','utf8').trim();
const dir = path.join('runs', id, 'captures');
if (!fs.existsSync(dir)) { console.log('NO CAPTURES DIR: hook did not fire for', id); process.exit(0); }
const files = fs.readdirSync(dir).filter(f => /^\d{4}\.json$/.test(f)).sort();
console.log('captures:', files.length);
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const unrec = c.shape === 'unrecognized';
  let line = { seq: c.seq, chars: String(c.response).length, rows: null, numRows: null, unrecognized: unrec, parse: 'ok' };
  try { const r = parseConnectorResult(c.response); line.rows = r.rows.length; line.numRows = r.numRows; }
  catch (e) { line.parse = 'FAIL: ' + e.message; }
  console.log(JSON.stringify(line), '|', String(c.sql).slice(0, 60));
}
"
```

Print the output verbatim. A row where `parse` is FAIL means the response was truncated or not complete JSON; `rows` below `numRows` means a partial page.

## 4. Report

Reply with the printed table and nothing else, plus the run id and any error rows.
