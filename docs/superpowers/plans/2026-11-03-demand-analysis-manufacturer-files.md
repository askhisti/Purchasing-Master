# Monthly demand, analysis tabs and manufacturer files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine nightly-refreshed MasterData tabs (monthly product and component volumes, BOM sources, price at demand, savings levers, quote health, multisource health, BOM coverage) and a "Create manufacturer file…" menu item that builds a shareable Google Sheet per manufacturer from them.

**Architecture:** New tabs are new feeds in the existing pipeline: a SQL file plus a `sql/feeds.json` entry each, fetched by `refresh/cli.mjs` through the Snowflake connector, uploaded to the Drive Inbox and staged/swapped by the bound Apps Script (`Puller.ts`). The manifest learns month columns (`demandMonths`) and custom yearly header prefixes. The manufacturer file is Apps Script only: pure selection logic in `MfrSelect.ts` (vm-tested), a writer in `MfrFile.ts`, a dialog `MfrDialog.html`, and an `onOpen` menu.

**Tech Stack:** Node 24 ESM (`node --test`), Snowflake SQL (MECL_PLATFORM.ANALYTICS, read-only), Google Apps Script V8 in plain-JS `.ts` files (loaded in Node `vm` by the tests with `test/helpers/gas-fakes.mjs`), clasp 3.

**Spec:** `docs/superpowers/specs/2026-11-03-demand-analysis-manufacturer-files-design.md` (extends `docs/superpowers/specs/2026-10-30-purchasing-master-design.md`). Snowflake column reference: `docs/snowflake-views.md`.

## Global Constraints

- Contract: headers in row 1, data from row 2, one row per key, blanks are empty, numbers are numbers, dates `YYYY-MM-DD`, columns only ever appended.
- Yearly columns run from the fixed first year 2025 to Y+10 (Y = base year of the run). Monthly columns run from `2025-01` to `(Y+10)-12`, headed `YYYY-MM`; each January appends twelve. Months with no plan are 0.
- Released BOM only: demand from `COMPONENT_DEMAND_FORECAST` with `IS_SOURCED_BY_US` and `PART_KIND = 'COMPONENT'`; never `COMPONENT_DEMAND_ALL_BASES`.
- `PART_ID` is unique only within `PART_KIND`; always filter `PART_KIND = 'COMPONENT'` before joining `PART_ID` to `COMPONENT_CATALOG.COMPONENT_ID`.
- Never add volumes across alternative sources or across multisource clusters; never add lever columns together; `LOA_PASS_THROUGH_VALUE_EUR` is a risk.
- Timestamps from Snowflake reach us as epoch seconds; every timestamp column is selected as `TO_VARCHAR(CONVERT_TIMEZONE('Europe/Berlin', <col>), 'YYYY-MM-DD HH24:MI')` (string) and every date as `<col>::DATE`.
- Every feed SQL's first column is `ROW_KEY` (unique, non-null text), then the manifest columns in order, then year columns, then month columns. Feeds are SELECT-only.
- Manufacturer file: monthly volumes for the current and next year only (`Y-01` … `(Y+1)-12`), yearly `Y` … `Y+10`; nothing masked; warning that months are the finished product's build/shipment month with no lead-time offset.
- No secrets in the repo; Snowflake only through the "Snowflake - ME Data" connector.

## Review Focus

- **January rollover:** base year 2027 must give 156 month columns starting `2025-01` and keep every 2026 header in place (Task 1 test `demand months grow by twelve in January`).
- **A component in two usable clusters** must appear once per BOM line in `BOM_Sources` (Task 4 live check query: `COUNT(*) = COUNT(DISTINCT ROW_KEY)` and no duplicate `(Product ID, BOM ME_EC, Source ME_EC)`).
- **An alternative selected while its primary's category is not selected:** the whole line goes into the manufacturer file (Task 7 test `line is included when only an alternative is selected`).
- **A BOM line with no row in `BOM_Demand_Monthly` for a month or flow:** month cells are 0, not blank (Task 7 test `missing months are zero`).
- **A wide feed staged by the Puller:** slices are sized by cells, so a 160-column tab never writes 4,000-row slices (Task 2 test `wide feeds stage in cell-sized slices`).

## File Structure

| File | Responsibility |
|---|---|
| `refresh/lib/manifest.mjs` | adds `demandMonthsFor`, header prefix, month headers/sql columns |
| `refresh/lib/sql.mjs` | adds `{{MONTHS: …}}` expansion |
| `refresh/lib/shape.mjs`, `refresh/cli.mjs` | pass months through |
| `scripts/feed-check-sql.mjs` | prints the count and sample SQL of one feed for a live check |
| `sql/feeds/<feed>.sql`, `sql/feeds.json` | nine new feeds |
| `docs/sheets.md` | one contract section per new tab |
| `apps-script/MasterData/Config.ts` | `TABS` (15), `PULL_SLICE_CELLS`, `TAB_NOTES`, manufacturer-file constants |
| `apps-script/MasterData/Sheets.ts` | `applyTabNotes_` |
| `apps-script/MasterData/Puller.ts` | cell-sized slices |
| `apps-script/MasterData/WebApp.ts` | calls `applyTabNotes_` after the swap |
| `apps-script/MasterData/MfrSelect.ts` | pure: read tab objects, category tree, file rows |
| `apps-script/MasterData/MfrFile.ts` | Sheets/Drive: menu, dialog server functions, file writer |
| `apps-script/MasterData/MfrDialog.html` | the dialog |
| `apps-script/MasterData/appsscript.json`, `.clasp.json` | UI scope, push order |
| `test/helpers/gas-fakes.mjs` | fakes for notes, protection, `SpreadsheetApp.create`, UI |

---

### Task 1: Month columns and yearly header prefixes in the refresh pipeline

**Files:**
- Modify: `refresh/lib/manifest.mjs`, `refresh/lib/sql.mjs`, `refresh/lib/shape.mjs`, `refresh/cli.mjs`, `docs/sheets.md` (placeholder paragraph at the top)
- Create: `scripts/feed-check-sql.mjs`
- Test: `test/manifest.test.mjs`, `test/sql.test.mjs`, `test/shape.test.mjs`, `test/feeds-sql.test.mjs` (new)

**Interfaces:**
- Produces (manifest JSON): a feed may carry `demandYears: {sqlPrefix, firstYear, yearsAhead, headerPrefix?}` (`headerPrefix` defaults to `"Demand "`) and `demandMonths: {sqlPrefix, firstYear, yearsAhead}`.
- Produces: `demandMonthsFor(feed, baseYear) -> Array<{year: number, month: number}>` (from `firstYear`-01 to `(baseYear + yearsAhead)`-12; `[]` without `demandMonths`).
- Produces: `headersFor(feed, baseYear)` = column headers, then `${headerPrefix}${year}` per demand year, then `YYYY-MM` per month. `sqlColumnsFor(feed, baseYear)` = column sql names, then `${demandYears.sqlPrefix}${year}`, then `${demandMonths.sqlPrefix}${year}_${MM}` (MM zero-padded).
- Produces: `renderFeedSql(sqlText, baseYear, demandYears = [], demandMonths = [])`. `{{MONTHS: <template>}}` expands to one line per month with `#YEAR#`, `#MONTH#` (1–12) and `#MM#` (01–12) replaced; a MONTHS template without `#YEAR#` or with no months is an error, like DEMAND.
- Produces: `node scripts/feed-check-sql.mjs <feed> [baseYear]` prints two statements separated by a line `-- next`: the count SQL (`buildCountSql`) and `SELECT * FROM (<feed sql>) ORDER BY ROW_KEY LIMIT 3`. Base year defaults to the current Berlin year.

- [ ] **Step 1: Write the failing tests**

In `test/manifest.test.mjs` (use an inline feed object, not the real manifest):
```js
const wide = { feed: 'w', columns: [{ sql: 'ME_EC', header: 'ME_EC', type: 'string' }],
  demandYears: { sqlPrefix: 'UNITS_', firstYear: 2025, yearsAhead: 10, headerPrefix: 'Units ' },
  demandMonths: { sqlPrefix: 'M_', firstYear: 2025, yearsAhead: 10 } };
test('month headers follow year headers', () => {
  const h = headersFor(wide, 2026);
  assert.equal(h.length, 1 + 12 + 144);
  assert.deepEqual(h.slice(0, 3), ['ME_EC', 'Units 2025', 'Units 2026']);
  assert.equal(h[13], '2025-01'); assert.equal(h.at(-1), '2036-12');
  assert.deepEqual(sqlColumnsFor(wide, 2026).slice(12, 15), ['UNITS_2036', 'M_2025_01', 'M_2025_02']);
});
test('demand months grow by twelve in January', () => {
  const m26 = headersFor(wide, 2026), m27 = headersFor(wide, 2027);
  assert.equal(m27.length - m26.length, 1 + 12);
  assert.equal(m27.at(-1), '2037-12');
  assert.ok(m26.filter((x) => /^\d{4}-\d{2}$/.test(x)).every((x) => m27.includes(x)));
});
test('header prefix defaults to "Demand "', () => {
  assert.equal(headersFor({ ...wide, demandYears: { sqlPrefix: 'D_', firstYear: 2025, yearsAhead: 0 }, demandMonths: undefined }, 2025)[1], 'Demand 2025');
});
```
In `test/sql.test.mjs`: `renderFeedSql('SELECT 1 AS ROW_KEY {{MONTHS: , SUM(IFF(MONTH_START = DATE_FROM_PARTS(#YEAR#, #MONTH#, 1), Q, 0)) AS M_#YEAR#_#MM#}}', 2025, [], [{year:2025,month:1},{year:2025,month:12}])` contains `DATE_FROM_PARTS(2025, 1, 1), Q, 0)) AS M_2025_01` and `AS M_2025_12`; a MONTHS template with no months throws `/no demand months/`.
In `test/shape.test.mjs`: a feed with `demandMonths` shapes month values as numbers (`'0'` → `0`, `''` → `null`).
In `test/feeds-sql.test.mjs` (new, covers every feed now and later): for every feed in `loadManifest().feeds`, the SQL rendered with `demandYearsFor`/`demandMonthsFor` for base year 2026 contains `AS ROW_KEY` and, for every name in `sqlColumnsFor(feed, 2026)`, a match of `new RegExp('\\bAS ' + name + '\\b')`; and the rendered SQL has no `{{`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/manifest.test.mjs test/sql.test.mjs test/shape.test.mjs test/feeds-sql.test.mjs`
Expected: FAIL (`demandMonthsFor` not exported / month headers missing); `feeds-sql` passes for the six existing feeds.

- [ ] **Step 3: Implement** the interfaces above in `manifest.mjs`, `sql.mjs`, `shape.mjs` (month types are `number`) and `cli.mjs` (`feedSql` passes `demandMonthsFor(feed, baseYear)`; the column check in `prepareFeeds` already uses `sqlColumnsFor`). Write `scripts/feed-check-sql.mjs`. Update the placeholder paragraph of `docs/sheets.md` to describe `headerPrefix`, `demandMonths` and `{{MONTHS: …}}`.

- [ ] **Step 4: Run the full suite**

Run: `npm test` then `npm run validate`
Expected: all pass, no output from `tsc`.

- [ ] **Step 5: Commit**

```bash
git add refresh scripts/feed-check-sql.mjs test docs/sheets.md
git commit -m "feat(refresh): month columns and yearly header prefixes in the feed manifest"
```

---

### Task 2: Apps Script — fifteen tabs, cell-sized staging slices, header notes

**Files:**
- Modify: `apps-script/MasterData/Config.ts`, `apps-script/MasterData/Puller.ts:407`, `apps-script/MasterData/Sheets.ts`, `apps-script/MasterData/WebApp.ts` (after the `swapStagingToLive_` call in `commitRun_`)
- Test: `test/apps-script-puller.test.mjs`, `test/apps-script-webapp.test.mjs`, `test/apps-script-core.test.mjs`, `test/helpers/gas-fakes.mjs`

**Interfaces:**
- Produces: `MASTERDATA_CONFIG.TABS` = `['Components', 'Multisource', 'Multisource_Members', 'Component_Usage', 'Products', 'MECL_Price', 'Product_Volumes', 'Component_Demand_Monthly', 'BOM_Demand_Monthly', 'BOM_Sources', 'Price_At_Demand', 'Savings_Levers', 'Quote_Health', 'Multisource_Health', 'BOM_Coverage']` (manifest order; Tasks 3–6 add the feeds in exactly this order).
- Produces: `MASTERDATA_CONFIG.PULL_SLICE_CELLS = 100000` replacing `PULL_SLICE_ROWS`; rows per slice = `Math.max(1, Math.floor(PULL_SLICE_CELLS / headers.length))`.
- Produces: `MASTERDATA_CONFIG.TAB_NOTES` (object tab → note text, the texts below) and `applyTabNotes_(ss)` in `Sheets.ts`: sets each listed tab's A1 note (tabs missing from the spreadsheet are skipped). `commitRun_` calls it right after the swap.

Note texts (exact copy):
- `Product_Volumes`: `One row per product and flow (series/sample). Planned finished-product units. Months are the finished product's planned build/shipment month at the EMS; there is no lead-time offset. From 2028 most months are the yearly plan spread evenly over 12 months. Released-BOM coverage per year: see tab BOM_Coverage.`
- `Component_Demand_Monthly` and `BOM_Demand_Monthly`: `Released-BOM demand of the primary source only (alternatives, scrap and lead time excluded). Months are the finished product's planned build/shipment month at the EMS; there is no lead-time offset. From 2028 most months are the yearly plan spread evenly over 12 months. Released-BOM coverage per year: see tab BOM_Coverage.`
- `BOM_Sources`: `One row per BOM line (product x primary ME_EC) and source. Source position 1 is the BOM primary; its volume is demand. Other positions are usable multisource alternatives; their volume is the line's full volume as potential volume if sourced. Never add volumes across the rows of a line or across clusters.`
- `Price_At_Demand`: `One row per component, demand year and EMS. EUR prices and spend are at today's exchange rate and are estimates based on quotes, not prices paid. EMS prices apply only to that EMS's demand. Binding = EMS and LOA prices.`
- `Savings_Levers`: `One row per component, demand year and EMS. Never add the lever columns together. LOA Pass-Through Risk EUR is a risk, not a saving. Component Spend In Year EUR repeats on each EMS row: do not sum it. EUR at today's rate, estimates based on quotes.`
- `Quote_Health`: `One row per ME_EC with a binding (LOA or EMS) quote or any demand. Status: No quote / All expired / Expires within 90 days / Valid.`
- `Multisource_Health`: `One row per component that is a primary source on an active BOM. Only Sourcing Level SINGLE_SOURCE is a true single source. Interchangeability holds within one cluster only.`

- [ ] **Step 1: Write the failing tests**
  - `test/apps-script-puller.test.mjs`: `wide feeds stage in cell-sized slices`: a run whose feed has 160 headers and 1,500 rows stages in slices of 625 rows (assert the staged part files / `stageRows_` call sizes are `[625, 625, 250]`); a 25-column feed with 9,000 rows stages `[4000, 4000, 1000]`.
  - `test/apps-script-webapp.test.mjs`: after a successful commit, `Savings_Levers` A1 carries the `TAB_NOTES.Savings_Levers` text; a tab without a note has none.
  - Every existing test that builds a begin request or manifest with six feeds now builds all fifteen (add a fixture helper `allFeeds(overrides)` in the test file or `gas-fakes.mjs` that returns one minimal feed per `TABS` entry).
  - `gas-fakes.mjs`: `FakeRange.setNote(text)` / `getNote()`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/apps-script-puller.test.mjs test/apps-script-webapp.test.mjs`
Expected: FAIL on the slice sizes and the note.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run the full suite**

Run: `npm test` then `npm run validate`
Expected: all pass. (`test/e2e.test.mjs` uses the real manifest and stays on six feeds until Task 6; if it builds a begin request from the manifest, it must still pass: make the e2e test compare against `loadManifest().feeds.length` instead of a hard-coded six, and keep `TABS` validation strict.)

Note for the implementer: the live refresh cannot run between Task 2 and Task 6 (the Apps Script would reject a six-feed run). That is expected; Task 9 pushes the Apps Script only after Task 6.

- [ ] **Step 5: Commit**

```bash
git add apps-script/MasterData test
git commit -m "feat(apps-script): fifteen tabs, cell-sized staging slices, tab notes"
```

---

### Task 3: Feeds `product_volumes`, `component_demand_monthly`, `bom_demand_monthly`

**Files:**
- Create: `sql/feeds/product_volumes.sql`, `sql/feeds/component_demand_monthly.sql`, `sql/feeds/bom_demand_monthly.sql`
- Modify: `sql/feeds.json` (append in this order after `mecl_price`), `docs/sheets.md` (one section per tab, same style as the existing ones)
- Test: `test/feeds-sql.test.mjs` (already covers them), `test/manifest.test.mjs` (header lists below)

**Interfaces:**
- Consumes: Task 1 manifest keys and `{{DEMAND: …}}` / `{{MONTHS: …}}`.
- Produces: tabs `Product_Volumes`, `Component_Demand_Monthly`, `BOM_Demand_Monthly` with exactly these headers (base year 2026):

| Feed | `pageLimit` | Columns (sql → header, type) | Years | Months |
|---|---|---|---|---|
| `product_volumes` | 200 | PRODUCT_ID → Product ID (number), PRODUCT_DISPLAY_NAME → Product Display Name, PROJECT → Project, PROGRAM → Program, CUSTOMER → Customer, EMS → EMS, FLOW → Flow (strings) | `UNITS_`, header `Units ` | `M_` |
| `component_demand_monthly` | 200 | ME_EC, MPN, MANUFACTURER → Manufacturer, HW_CATEGORY → HW Category, HW_SUBCATEGORY → HW Subcategory, PRIMARY_ME_MS → Primary ME_MS (strings) | none | `M_` |
| `bom_demand_monthly` | 200 | ME_EC, MPN, MANUFACTURER → Manufacturer, PRODUCT → Product, PRODUCT_ID → Product ID (number), EMS, FLOW → Flow (strings), QTY_PER_UNIT → Qty Per Unit (number) | none | `M_` |

All `firstYear` 2025, `yearsAhead` 10.

SQL decisions (source `MECL_PLATFORM.ANALYTICS.COMPONENT_DEMAND_FORECAST`, called CDF; see `docs/snowflake-views.md`):
- `Flow` = `INITCAP(PRODUCT_FLOW_TYPE)` (`Series` / `Sample`).
- `product_volumes`: one row per `PRODUCT_ID` × flow; units per month = `MAX(PLANNED_PRODUCT_UNITS)` grouped by product, flow, `MONTH_START` (product units repeat on every part row), over **all** CDF rows (no sourced/part-kind filter: product volumes do not depend on parts). Project from `PRODUCT_CATALOG` the same way `sql/feeds/products.sql` does (LEFT JOIN on `PRODUCT_ID`; blank when the product is not in the catalog); Program = CDF `PROGRAM_NAME`, Customer = CDF `CUSTOMER_NAME`, EMS = CDF `EMS_NAME`. Yearly `UNITS_<y>` = sum of the months of that year. ROW_KEY = `PRODUCT_ID || '|' || FLOW`.
- `component_demand_monthly`: filter `IS_SOURCED_BY_US AND PART_KIND = 'COMPONENT'`; sum `DEMAND_QUANTITY` over products and flows; identity from `COMPONENT_CATALOG` joined `COMPONENT_ID = PART_ID` (ME_EC = `SUPPLIER_PARTNUMBER`, MPN = `MANUFACTURER_PARTNUMBER`, Manufacturer = `MANUFACTURER_NAME`, `HW_CATEGORY`, `HW_SUBCATEGORY`); Primary ME_MS = `MAX(MS_PART_NUMBER)` over usable memberships (as in `components.sql`); keep only components whose total demand is not 0. ROW_KEY = ME_EC.
- `bom_demand_monthly`: same filter; one row per ME_EC × `PRODUCT_ID` × flow; Product = CDF `PRODUCT_DISPLAY_NAME`; Qty Per Unit = `MAX(QTY_PER_UNIT)`; ROW_KEY = `ME_EC || '|' || PRODUCT_ID || '|' || FLOW`.
- Month cell: `SUM(IFF(MONTH_START = DATE_FROM_PARTS(#YEAR#, #MONTH#, 1), <qty>, 0)) AS M_#YEAR#_#MM#` (0 when no plan).

- [ ] **Step 1: Write the failing test** in `test/manifest.test.mjs`: `headersFor('component_demand_monthly', 2026)` equals `['ME_EC','MPN','Manufacturer','HW Category','HW Subcategory','Primary ME_MS', ...months]` with 144 months; `headersFor('product_volumes', 2026)` has `Units 2025` at index 7 and `2025-01` at index 19; `headersFor('bom_demand_monthly', 2026)[7]` is `Qty Per Unit`.
- [ ] **Step 2: Run** `node --test test/manifest.test.mjs test/feeds-sql.test.mjs` — Expected: FAIL (`unknown feed`).
- [ ] **Step 3: Write** the three SQL files, the manifest entries and the `docs/sheets.md` sections.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5 (controller, live check):** for each feed run `node scripts/feed-check-sql.mjs <feed>` and execute both statements through the Snowflake connector. Expected: `ROW_COUNT = KEY_COUNT`; `product_volumes` ≈ 80 rows, `component_demand_monthly` ≈ 620, `bom_demand_monthly` ≈ 3,500; for ME_EC_0000001 the sum of `M_2026_01..M_2026_12` in `component_demand_monthly` is 19,993 and of 2027 is 40,850. Fix the SQL until it holds.
- [ ] **Step 6: Commit**

```bash
git add sql docs/sheets.md test
git commit -m "feat(feeds): product volumes and monthly component demand"
```

---

### Task 4: Feed `bom_sources`

**Files:**
- Create: `sql/feeds/bom_sources.sql`
- Modify: `sql/feeds.json` (after `bom_demand_monthly`), `docs/sheets.md`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Produces: tab `BOM_Sources`, `pageLimit` 300, columns: PRODUCT → Product, PRODUCT_ID → Product ID (number), EMS, BOM_ME_EC → BOM ME_EC, ME_MS, SOURCE_POSITION → Source Position (number), SOURCE_ME_EC → Source ME_EC, MANUFACTURER → Manufacturer, MPN, HW_CATEGORY → HW Category, HW_SUBCATEGORY → HW Subcategory, MEMBER_STATUS → Member Status, IS_USABLE → Is Usable (boolean), VOLUME_TYPE → Volume Type; years `VOLUME_` with header `Volume `, 2025 … Y+10; no months.

SQL decisions:
- A BOM line = distinct (`PRODUCT_ID`, primary `PART_ID`) in CDF with `IS_SOURCED_BY_US AND PART_KIND = 'COMPONENT'`; line volume per year = `SUM(DEMAND_QUANTITY)` over both flows. Product = CDF `PRODUCT_DISPLAY_NAME`, EMS = `EMS_NAME`.
- Position 1 row: the primary itself; ME_MS, Member Status and Is Usable blank (NULL); Volume Type `Demand`.
- Alternatives: rows of `MULTISOURCE_PART_MEMBERS` with `IS_USABLE` in every cluster (`MULTISOURCE_ID`) that has the primary as a member (any status), excluding the primary. When an alternative sits in two such clusters, keep the row with the lowest `MEMBER_PRIORITY` (ties: lowest `MS_PART_NUMBER`); its ME_MS = that cluster's `MS_PART_NUMBER`. Position = `1 + ROW_NUMBER() OVER (PARTITION BY PRODUCT_ID, primary ORDER BY MEMBER_PRIORITY, alt SUPPLIER_PARTNUMBER)`. Volume Type `Potential volume if sourced`; volumes = the line's volumes.
- Identity (Source ME_EC, Manufacturer, MPN, HW Category, HW Subcategory) from `COMPONENT_CATALOG` of the source component.
- ROW_KEY = `PRODUCT_ID || '|' || BOM_ME_EC || '|' || LPAD(SOURCE_POSITION, 2, '0')`.

- [ ] **Step 1: Write the failing test**: `headersFor('bom_sources', 2026)` equals the 14 headers above followed by `Volume 2025` … `Volume 2036` (26 total).
- [ ] **Step 2: Run** `node --test test/manifest.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Write** the SQL, manifest entry, `docs/sheets.md` section.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5 (controller, live check):** count/sample statements as in Task 3; plus `SELECT COUNT(*), COUNT(DISTINCT PRODUCT_ID || '|' || BOM_ME_EC || '|' || SOURCE_ME_EC) FROM (<feed sql>)` must give two equal numbers; position-1 rows must equal the number of lines in `bom_demand_monthly` collapsed over flow; rows ≈ 7,000.
- [ ] **Step 6: Commit** `git commit -m "feat(feeds): BOM sources with alternatives"`

---

### Task 5: Feeds `price_at_demand`, `savings_levers`

**Files:**
- Create: `sql/feeds/price_at_demand.sql`, `sql/feeds/savings_levers.sql`
- Modify: `sql/feeds.json` (after `bom_sources`), `docs/sheets.md`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Produces: `Price_At_Demand` (source `COMPONENT_PRICE_AT_DEMAND`) and `Savings_Levers` (source `COMPONENT_SAVINGS_LEVERS`), `pageLimit` 500, no year/month columns. Headers exactly as spec §5. Mapping:
  - shared: ME_EC ← `PART_NUMBER`, MPN ← `MPN`, Manufacturer ← `MANUFACTURER_NAME`, Year ← `DEMAND_YEAR` (number), EMS ← `EMS_NAME`, Source Refreshed At ← `REFRESHED_AT` (string, Berlin `YYYY-MM-DD HH24:MI`).
  - Price_At_Demand: EMS Demand ← `EMS_DEMAND`, Total Demand ← `TOTAL_DEMAND`, EMS Price EUR, EMS Price Stage, LOA Price EUR, LOA Price Stage, Target Price EUR, Best Binding Price EUR, Best Binding Price Type (string), Expected Spend EUR, Target Spend EUR, Gap To Target EUR (numbers, same-named `_EUR` / `_STAGE` columns), Is Priced, Is Below Lowest Stage (booleans).
  - Savings_Levers: Spend Rank In Year ← `SPEND_RANK_IN_YEAR`, Cumulative Spend Share % ← `CUMULATIVE_SPEND_SHARE_PCT`, Expected Spend EUR, Component Spend In Year EUR, LOA Pass-Through Risk EUR ← `LOA_PASS_THROUGH_VALUE_EUR`, No LOA Spend EUR, EMS Harmonisation Saving EUR, Lowest EMS ← `LOWEST_EMS_NAME`, Lowest EMS Price EUR, Alternative Saving EUR, Best Alternative MPN ← `BEST_ALTERNATIVE_MPN`, Best Alternative Price EUR, Stale Price Spend EUR, Below Lowest Stage Spend EUR, Gap To Target EUR, Is Quote Expired, Is Carried Forward (booleans), Price Valid Until ← `PRICE_VALID_UNTIL` (date), Has LOA Price, Has Target Price (booleans).
- ROW_KEY (both) = `PART_NUMBER || '|' || DEMAND_YEAR || '|' || COALESCE(TO_VARCHAR(EMS_ID), '-')`.

- [ ] **Step 1: Write the failing test**: the header lists of both feeds equal spec §5 exactly (20 and 26 headers).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Write** SQL, manifest entries, `docs/sheets.md` sections (state rule price-06 in the Savings_Levers section).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5 (controller, live check):** both feeds 5,494 rows with `ROW_COUNT = KEY_COUNT`; `SUM(EXPECTED_SPEND_EUR)` for 2026 ≈ €16.8M in both.
- [ ] **Step 6: Commit** `git commit -m "feat(feeds): price at demand and savings levers"`

---

### Task 6: Feeds `quote_health`, `multisource_health`, `bom_coverage`

**Files:**
- Create: `sql/feeds/quote_health.sql`, `sql/feeds/multisource_health.sql`, `sql/feeds/bom_coverage.sql`
- Modify: `sql/feeds.json` (after `savings_levers`, in this order), `docs/sheets.md`, spec §5 (`Multisource_Health` loses `Source Refreshed At`: `COMPONENT_SOURCING` has no refresh time; add `BOM_Coverage` as the tab the coverage notes point to)
- Test: `test/manifest.test.mjs`, `test/e2e.test.mjs` (now 15 feeds)

**Interfaces:**
- Produces `Quote_Health`, `pageLimit` 500: ME_EC, MPN, Manufacturer, HW Category (strings), Next Demand Year (number), Demand Next 12 Months (number), Valid LOA Quotes, Expired LOA Quotes (numbers), LOA Valid Until (date), Valid EMS Quotes, Expired EMS Quotes (numbers), EMS Valid Until (date), Last Quoted On (date), Stale Price Spend EUR (number), Status (string).
  - Quotes: `COMPONENT_PRICE_ITEMS` rows with `PRICE_TYPE IN ('LOA','EMS')`, attributed to the Resolved ME_EC exactly as `sql/feeds/mecl_price.sql` resolves it (linked part number, else the single catalog component with the same trimmed upper-case MPN). Valid = `IS_VALID_TODAY`; Expired = `QUOTE_VALID_END::DATE < CURRENT_DATE`. `LOA/EMS Valid Until` = latest `QUOTE_VALID_END::DATE` among valid quotes of that type (blank when none, or when a valid quote is open-ended). Last Quoted On = `MAX(CREATED_AT)::DATE` of all its LOA/EMS quotes.
  - Demand (CDF, sourced, COMPONENT): Next Demand Year = smallest `DEMAND_YEAR` ≥ current Berlin year with demand > 0; Demand Next 12 Months = demand with `MONTH_START` from the first day of the current month for 12 months.
  - Stale Price Spend EUR = `SUM(STALE_PRICE_SPEND_EUR)` of `COMPONENT_SAVINGS_LEVERS` rows of the current year for that component (EMS rows of one year only).
  - Universe: every ME_EC with at least one LOA/EMS quote or any demand. Status, first match wins: `No quote` (no LOA/EMS quote); `All expired` (no valid one); `Expires within 90 days` (no open-ended valid quote and the latest valid-until ≤ `CURRENT_DATE + 90`); `Valid`.
  - ROW_KEY = ME_EC.
- Produces `Multisource_Health`, `pageLimit` 500, source `COMPONENT_SOURCING`: ME_EC ← `PART_NUMBER`, MPN, Manufacturer ← `MANUFACTURER_NAME`, HW Category, Sourcing Level, True Single Source Placements (number), Single Source Reasons, Usable Alternates, ME_MS ← `MULTISOURCE_PARTS` (the column of that name in COMPONENT_SOURCING), Cluster Sourcing Health ← `MULTISOURCE_PARTS.SOURCING_HEALTH` of the component's Primary ME_MS (`MAX(MS_PART_NUMBER)` over usable memberships), Products Using (number), Demand Current Year (number, `KPI_COMPONENT_DEMAND_BY_YEAR.TOTAL_DEMAND` sourced, current year, 0 when none). ROW_KEY = ME_EC.
- Produces `BOM_Coverage`, `pageLimit` 100, source `PRODUCT_DEMAND_BASIS`: Year ← `PLAN_YEAR` (number), Planned Units, Released BOM Units (numbers), Released BOM Share % (number, `100 * released / NULLIF(planned, 0)`, rounded to 1 decimal). ROW_KEY = `TO_VARCHAR(PLAN_YEAR)`.

- [ ] **Step 1: Write the failing tests**: header lists of the three feeds; `loadManifest().feeds.map(f => f.tab)` equals `MASTERDATA_CONFIG.TABS` (load `Config.ts` through the existing vm helper).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Write** SQL, manifest entries, `docs/sheets.md` sections, the spec §5 edit.
- [ ] **Step 4: Run** `npm test` and `npm run validate` — Expected: PASS.
- [ ] **Step 5 (controller, live check):** `ROW_COUNT = KEY_COUNT` for all three; `Multisource_Health` 642 rows; `BOM_Coverage` 2026 share 83.5; `Quote_Health` status counts look plausible (most components `All expired`, per the research).
- [ ] **Step 6: Commit** `git commit -m "feat(feeds): quote health, multisource health, BOM coverage"`

---

### Task 7: Manufacturer file — selection logic (pure)

**Files:**
- Create: `apps-script/MasterData/MfrSelect.ts`
- Modify: `apps-script/MasterData/.clasp.json` (`filePushOrder`: append `MfrSelect.ts`, `MfrFile.ts`)
- Test: `test/apps-script-mfr-select.test.mjs` (new; load `Config.ts` and `MfrSelect.ts` in vm like `test/apps-script-core.test.mjs`)

**Interfaces:**
- Produces `mfrTable_(values) -> {headers: string[], rows: any[][], col: (name) => number}`; `col` throws `missing column <name>` when absent.
- Produces `mfrCategoryTree_(components, bomSources, onlyUsed) -> [{category, count, subcategories: [{subcategory, count}]}]`: `components`/`bomSources` are `mfrTable_` objects of the `Components` / `BOM_Sources` tabs; nodes sorted by name; blank category/subcategory shown as `(none)`; count = distinct ME_EC in the node, restricted to ME_ECs that occur as `Source ME_EC` in `BOM_Sources` when `onlyUsed`.
- Produces `mfrBuildRows_(input, selection, onlyUsed, baseYear) -> {headers: string[], rows: any[][], parts: [{meEc, manufacturer, mpn, description}]}`:
  - `input = {components, bomSources, bomMonthly}` (`mfrTable_` objects of `Components`, `BOM_Sources`, `BOM_Demand_Monthly`); `selection` = array of `{category, subcategory}` (`(none)` for blank).
  - headers: `Category, Subcategory, Product, EMS, BOM ME_EC, Source Position, ME_EC, Manufacturer, MPN, Description, ME_MS, Volume Type`, then `Volume <Y>` … `Volume <Y+10>`, then `<Y>-01` … `<Y+1>-12`.
  - a line (Product ID × BOM ME_EC) is included when any of its sources' (HW Category, HW Subcategory) is selected; then all its rows are output. Category/Subcategory/Description per row come from that row's own component (`Components`); ME_MS from `BOM_Sources`.
  - yearly cells from `BOM_Sources` `Volume <y>`; monthly cells = sum over flows of `BOM_Demand_Monthly` rows with ME_EC = BOM ME_EC and the same Product ID; a missing row or month is 0.
  - order: by the line's primary Category, Subcategory, BOM ME_EC, Product, Source Position.
  - when `!onlyUsed`: each selected component that is no `Source ME_EC` anywhere in `BOM_Sources` gets one row after the lines: Product, EMS, BOM ME_EC, Source Position blank (`''`), ME_MS = its `Components.ME_MS`, Volume Type `Not on a BOM`, all volume cells `''`.
  - `parts`: distinct ME_EC of the rows, in row order.

- [ ] **Step 1: Write the failing tests** (fixture: 3 components — C1 MLCC/0402 primary, C2 MLCC/0603 alternative, C3 Resistors/Thick film primary not on any line with C1; one line P1×C1 with sources C1 pos 1, C2 pos 2; `BOM_Demand_Monthly` with series and sample rows for C1×P1 in 2026-03 = 10 and 5):
  - `category tree counts distinct parts per node` (onlyUsed true → MLCC 2, Resistors 0 or absent per onlyUsed; onlyUsed false → Resistors 1).
  - `line is included when only an alternative is selected`: selection MLCC/0603 → 2 rows, positions 1 and 2, Volume Type `Demand` and `Potential volume if sourced`.
  - `monthly cells sum series and sample`: the `2026-03` cell is 15 on both rows; `missing months are zero`: `2027-12` is 0.
  - `headers for base year 2026`: 12 + 11 + 24 = 47 headers, last `2027-12`, first volume `Volume 2026`.
  - `unused parts appear only when onlyUsed is off`: selection Resistors/Thick film → 0 rows with onlyUsed, 1 row `Not on a BOM` without.
  - `missing column is reported`: a `BOM_Sources` table without `Source Position` throws `missing column Source Position`.
- [ ] **Step 2: Run** `node --test test/apps-script-mfr-select.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** `MfrSelect.ts` (plain JS syntax, `var`/`function`, no Apps Script services).
- [ ] **Step 4: Run** `npm test` and `npm run validate` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(apps-script): manufacturer file selection logic"`

---

### Task 8: Manufacturer file — menu, dialog and writer

**Files:**
- Create: `apps-script/MasterData/MfrFile.ts`, `apps-script/MasterData/MfrDialog.html`
- Modify: `apps-script/MasterData/Config.ts` (constants below), `apps-script/MasterData/appsscript.json` (add scope `https://www.googleapis.com/auth/script.container.ui`), `test/helpers/gas-fakes.mjs`, `docs/sheets.md` (a "Manufacturer file" section), `docs/TESTING.md` (live checklist items)
- Test: `test/apps-script-mfr-file.test.mjs` (new)

**Interfaces:**
- Consumes: `mfrTable_`, `mfrCategoryTree_`, `mfrBuildRows_` (Task 7); `MASTERDATA_CONFIG.FOLDER_ID`, `TIME_ZONE`, `LOG_SHEET` (base year in `_Refresh_Log` B2).
- Produces `onOpen()` adding menu `MasterData` → `Create manufacturer file…` (handler `showManufacturerFileDialog`).
- Produces `showManufacturerFileDialog()` (modal, `HtmlService.createHtmlOutputFromFile('MfrDialog')`, width 560, height 680, title `Create manufacturer file`).
- Produces `getManufacturerFileOptions(onlyUsed: boolean) -> {tree, baseYear, refreshedAt}` and `createManufacturerFile(form: {manufacturer: string, selection: [{category, subcategory}], onlyUsed: boolean}) -> {url, xlsxUrl, name, rowCount}`; errors are thrown as `Error` with a message the dialog shows.
- Config constants: `MFR_FOLDER_NAME: 'Manufacturer files'`, `MFR_MAX_CELLS: 2000000`, `MFR_PRICE_YEARS: 5`, `MFR_EXTRA_PRICE_ROWS: 300`.

Behaviour:
- `createManufacturerFile` validates: manufacturer trimmed non-empty (`Enter the manufacturer name.`); selection non-empty (`Select at least one category.`); rows > 0 (`No parts match the selection.`); rows × columns ≤ `MFR_MAX_CELLS` (`The selection is too large; select fewer categories.`).
- Base year Y = `_Refresh_Log` B2 when it is an integer, else the current Berlin year.
- Creates the spreadsheet with `SpreadsheetApp.create(name)`, moves it into `<FOLDER_ID>/Manufacturer files` (created when missing), name `<manufacturer> - component overview - <yyyy-MM-dd Berlin>`.
- Sheets, in order: `Read me`, `Our parts`, `Your alternatives`, `Your pricing` (the default first sheet is renamed to `Read me`).
- `Read me` (column A, one line per row, bold for the warning lines): `Component overview for <manufacturer>`, `Generated <yyyy-MM-dd HH:mm> (Berlin) from MasterData, data refreshed <B1 of _Refresh_Log as Berlin time>`, `Categories: <cat / sub, …>`, blank, then the warnings (bold): `Months are the finished product's planned build/shipment month at the EMS. There is no lead-time offset: order your components earlier.`, `From <Y+2> on, volumes are a yearly plan, not a build schedule.`, `Rows marked "Potential volume if sourced" are alternative sources: the volume is what that part would get if it were used for the whole BOM line. It is not demand and must not be added to the primary source's volume.`, `Volumes are plans, not orders.`, blank, then `How to answer:`, `Sheet "Your alternatives": enter your own part number against our parts where you have a drop-in or near alternative.`, `Sheet "Your pricing": enter your prices per year; add rows below for alternative part numbers you propose.`, `Please do not change the grey columns.`
- `Our parts`: headers + rows from `mfrBuildRows_`; header row bold and frozen; the sheet protected (`protect()`, description `Read-only`).
- `Your alternatives`: headers `ME_EC, Manufacturer, MPN, Description, Your Alternative MPN, Drop-in Replacement (Yes/No), Differences, Datasheet Link, Comment`; one row per `parts` entry; columns A–D grey; sheet protected with columns E–I of the data rows unprotected; data validation `Yes`/`No` on column F.
- `Your pricing`: headers `ME_EC, Manufacturer, MPN, Quoted MPN, Currency, MOQ, Lead Time (weeks), Price <Y>` … `Price <Y+4>`, `Valid Until, Comment`; one row per `parts` entry plus `MFR_EXTRA_PRICE_ROWS` blank rows; columns A–C grey; sheet protected with columns D onward of all data rows and every column of the extra rows unprotected.
- Number format `@` on text columns of `Our parts`, `General` on volumes.
- Return `xlsxUrl` = `https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx`.
- Dialog: manufacturer field; "Only parts we use" checkbox (default checked; toggling reloads the tree counts); category tree with checkboxes (a category checkbox ticks all its subcategories, counts in brackets); Create button disabled while working; on success shows the file name, an "Open file" link and a "Download as Excel" link; on failure shows the error text. Uses `google.script.run` only.

- [ ] **Step 1: Extend the fakes** in `gas-fakes.mjs`: `SpreadsheetApp.create(name)` returning a `FakeSpreadsheet` with `getId()`, `getUrl()`, one sheet `Sheet1`; `FakeSheet.protect()` returning a protection fake with `setDescription`, `setUnprotectedRanges(ranges)`, `getUnprotectedRanges()`; `FakeSheet.setFrozenRows`, `FakeRange.setFontWeight`, `setBackground`, `setDataValidation`; `SpreadsheetApp.newDataValidation()` builder; `DriveApp.getFileById(id).moveTo(folder)`; `SpreadsheetApp.getUi()` with `createMenu(...).addItem(...).addToUi()` recording calls.
- [ ] **Step 2: Write the failing tests** (seed `Components`, `BOM_Sources`, `BOM_Demand_Monthly`, `_Refresh_Log` with B2 = 2026 in the active fake spreadsheet using the Task 7 fixture):
  - `onOpen adds the MasterData menu` (`Create manufacturer file…` → `showManufacturerFileDialog`).
  - `creates the file in Manufacturer files with four sheets` (name `Murata - component overview - <date>`, sheet names in order, `Our parts` row count = rows + 1, folder created once and reused on a second call).
  - `input columns are the only unprotected ranges` (`Your alternatives` unprotected = E2:I<n+1>; `Your pricing` includes the extra rows).
  - `read me carries the build-month warning` (a row starting `Months are the finished product's planned build/shipment month`).
  - `rejects an empty manufacturer, an empty selection and a selection with no parts` (exact messages above).
  - `rejects a selection over the cell limit` (set `MFR_MAX_CELLS` to 10 in the test).
  - `xlsxUrl points at the export of the new file`.
- [ ] **Step 3: Run** `node --test test/apps-script-mfr-file.test.mjs` — Expected: FAIL.
- [ ] **Step 4: Implement** `MfrFile.ts`, `MfrDialog.html`, Config constants, the scope, docs.
- [ ] **Step 5: Run** `npm test` and `npm run validate` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(apps-script): Create manufacturer file menu, dialog and writer"`

---

### Task 9: Live rollout (controller, with the user)

- [ ] **Step 1:** Push the Apps Script: `clasp push` from `apps-script/MasterData` (run clasp directly; `scripts/release-gas.mjs` has a broken Windows path, residual R59). Expected: all files pushed, including `MfrSelect.ts`, `MfrFile.ts`, `MfrDialog.html`.
- [ ] **Step 2:** Run the refresh from the laptop as on 2026-11-03 (headless `claude -p "Run the nightly-refresh skill."` with `MASTERDATA_SA_KEY` from the local key file, allowed tools: the Snowflake `sql` tool and `Bash(node refresh/cli.mjs:*)`). Expected: `DONE uploaded <runId> …` with 15 feeds.
- [ ] **Step 3:** Within ~15 minutes `_Refresh_Log` shows SUCCESS for the run; all 15 tabs filled; notes on the new tabs.
- [ ] **Step 4:** The user reloads MasterData, authorises the new scope, opens `MasterData → Create manufacturer file…`, creates a file for one real request (e.g. MLCC), checks it and the Excel download.
- [ ] **Step 5:** Update `docs/TESTING.md` (checked items), `docs/ARCHITECTURE.md` (new tabs, menu), push the branch, open a PR to `main`.
