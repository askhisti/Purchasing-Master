# Rolling month columns and tab cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut MasterData to 8 tabs, give `Components` and `Product_Volumes` a rolling layout (yearly totals, monthly only for the current and next year, each year's months right before its total), and make "Create manufacturer file" derive BOM lines, alternatives and monthly volumes from `Component_Usage`, `Multisource_Members` and `Product_Volumes`.

**Architecture:** The feed manifest gets an interleaved year/month series (`{{SERIES: … || …}}` placeholder; months only for Y and Y+1). Seven feeds and their SQL are removed; the Apps Script tab list shrinks to 8 and deletes the obsolete tabs after a successful commit. `MfrSelect.ts` switches its inputs; the writer, dialog and file layout stay.

**Tech Stack:** Node 24 ESM (`node --test`), Snowflake SQL (read-only), Apps Script V8 plain-JS `.ts` files tested in Node `vm` with `test/helpers/gas-fakes.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-03-demand-analysis-manufacturer-files-design.md` — **§11 (amendment 2026-11-04) is binding and overrides §2/§5/§6.** Snowflake columns: `docs/snowflake-views.md`.

## Global Constraints

- Tabs, in this order: `Components`, `Multisource`, `Multisource_Members`, `Component_Usage`, `Products`, `MECL_Price`, `Product_Volumes`, `BOM_Coverage` (plus `_Refresh_Log`).
- Removed feeds/tabs: `component_demand_monthly`/`Component_Demand_Monthly`, `bom_demand_monthly`/`BOM_Demand_Monthly`, `bom_sources`/`BOM_Sources`, `price_at_demand`/`Price_At_Demand`, `savings_levers`/`Savings_Levers`, `quote_health`/`Quote_Health`, `multisource_health`/`Multisource_Health`.
- Rolling layout for Y = 2026: `Demand 2025 | 2026-01 … 2026-12 | Demand 2026 | 2027-01 … 2027-12 | Demand 2027 | Demand 2028 | … | Demand 2036` (Product_Volumes: `Units <year>`). Yearly columns 2025 … Y+10; months only for Y and Y+1; months with no plan are 0; month cells `NUMBER(38,2)` (sum, then cast).
- Monthly demand: `COMPONENT_DEMAND_FORECAST`, `IS_SOURCED_BY_US AND PART_KIND = 'COMPONENT'`, joined on `PART_ID = COMPONENT_ID`; it sums to `KPI_COMPONENT_DEMAND_BY_YEAR.TOTAL_DEMAND` per year exactly.
- Manufacturer file: unchanged sheets, texts, warnings, protections and month window; never add volumes across sources or clusters.
- Every feed SQL: `ROW_KEY` first, then manifest columns in header order. SELECT-only. Rendered SQL ≤ 8,000 chars at base year 2026.

## Review Focus

- **January rollover:** base year 2027 drops the 2026 months and adds 2028 months; `Demand 2026` stays (Task 1 test).
- **A part in two usable clusters** appears once per line in the manufacturer file (Task 3 test).
- **A product with only one flow** (Series or Sample) in `Product_Volumes` still yields correct monthly volumes (Task 3 test).
- **Obsolete tabs** are deleted only after a successful commit, never on a failed run (Task 2 test).
- **A line whose product is missing from `Product_Volumes`** gets 0 months, not an error (Task 3 test).

---

### Task 1: Interleaved rolling series in the refresh pipeline

**Files:** Modify `refresh/lib/manifest.mjs`, `refresh/lib/sql.mjs`, `refresh/lib/shape.mjs` (only if needed), `refresh/cli.mjs` (only if needed), `docs/sheets.md` (placeholder paragraph). Test: `test/manifest.test.mjs`, `test/sql.test.mjs`.

**Interfaces:**
- Manifest `demandMonths` becomes `{sqlPrefix, yearsAhead}`: months for years `baseYear … baseYear + yearsAhead` (feeds use `yearsAhead: 1` → 24 months). `demandMonthsFor(feed, baseYear) -> [{year, month}]` returns exactly those.
- `headersFor` / `sqlColumnsFor`: listed columns, then for each demand year y in order: the months of y that are in the window (`YYYY-MM` / `<monthPrefix><y>_<MM>`), then the year column (`<headerPrefix><y>` / `<sqlPrefix><y>`). A feed with `demandMonths` must have `demandYears` (error otherwise).
- `renderFeedSql(sqlText, baseYear, demandYears, demandMonths)` adds `{{SERIES: <year template> || <month template>}}`: expands, in the interleaved order above, one line per year (year template, `#YEAR#`) and per window month (month template, `#YEAR#`, `#MONTH#`, `#MM#`). `{{DEMAND: …}}` and `{{MONTHS: …}}` keep working (for CTEs).

- [ ] Step 1: failing tests — for an inline feed (`demandYears` 2025 +10, `demandMonths` yearsAhead 1): headers at base year 2026 equal `[…cols, 'Demand 2025', '2026-01', …, '2026-12', 'Demand 2026', '2027-01', …, '2027-12', 'Demand 2027', 'Demand 2028', …, 'Demand 2036']` (12 + 24 = 36 series columns); `sqlColumnsFor` has the same order with `DEMAND_`/`M_` names; at base year 2027 there is no `2026-xx` header, `Demand 2026` is present and `2028-12` is last month; `{{SERIES: , D_#YEAR# AS DEMAND_#YEAR# || , M#YEAR##MM# AS M_#YEAR#_#MM#}}` renders aliases in exactly `sqlColumnsFor` order (parse the `AS <name>` sequence); `demandMonths` without `demandYears` throws.
- [ ] Step 2: run `node --test test/manifest.test.mjs test/sql.test.mjs` — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: `npm test` and `npm run validate` — PASS (existing monthly feeds still render; Task 2 changes them).
- [ ] Step 5: commit `feat(refresh): rolling interleaved month series in the feed manifest`.

### Task 2: Eight tabs — feeds, Apps Script tab list, notes, obsolete-tab cleanup

**Files:** Modify `sql/feeds/components.sql`, `sql/feeds/product_volumes.sql`, `sql/feeds.json`, `apps-script/MasterData/Config.ts`, `apps-script/MasterData/Sheets.ts`, `apps-script/MasterData/WebApp.ts` (commit step), `docs/sheets.md`, `docs/ARCHITECTURE.md` (tab list). Delete `sql/feeds/{component_demand_monthly,bom_demand_monthly,bom_sources,price_at_demand,savings_levers,quote_health,multisource_health}.sql`. Tests: `test/manifest.test.mjs`, `test/e2e.test.mjs`, `test/apps-script-*.test.mjs`, `test/helpers/gas-fakes.mjs`.

**Interfaces:**
- `components` and `product_volumes` get `demandMonths: {sqlPrefix: 'M_', yearsAhead: 1}`; their final SELECT uses `{{SERIES: …}}`. Components months come from a CTE over `COMPONENT_DEMAND_FORECAST` (filter as in Global Constraints, `M = TO_CHAR(MONTH_START,'YYYY-MM')`, months of Y and Y+1 only), LEFT JOINed on `COMPONENT_ID`, `COALESCE(…, 0)`, cast `NUMBER(38,2)`. Yearly demand stays from `KPI_COMPONENT_DEMAND_BY_YEAR`. `product_volumes` keeps its meaning (yearly `Units` = sum of the year's months over all months, not only the window).
- `MASTERDATA_CONFIG.TABS` = the 8 tabs of Global Constraints; `MASTERDATA_CONFIG.OBSOLETE_TABS` = the 7 removed tab names; `deleteObsoleteTabs_(ss)` in `Sheets.ts` deletes those that exist; `commitRun_` calls it as a post-swap warning-only step after a successful swap (like `applyTabNotes_`).
- `TAB_NOTES`: keep `Product_Volumes` (wording: months only for the current and next year, each year's months before its total); add `Components`: `Demand is released-BOM demand of the primary source (alternatives, scrap and lead time excluded). Monthly columns exist for the current and next year only; months are the finished product's planned build/shipment month at the EMS, with no lead-time offset. Released-BOM coverage per year: see tab BOM_Coverage.`; remove the notes of removed tabs.

- [ ] Step 1: failing tests — manifest tabs equal `TABS` (8); `headersFor('components', 2026)` ends with the 36-column rolling series after `Is Sourced By Us`; `headersFor('product_volumes', 2026)` has `Units 2025, 2026-01 …`; after a successful commit the 7 obsolete tabs present in the fake spreadsheet are deleted and the 8 live tabs remain; after a failed run nothing is deleted; Components carries its note.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement; update `docs/sheets.md` (remove the 7 sections, describe the rolling layout in Components and Product_Volumes) and `docs/ARCHITECTURE.md` tab list.
- [ ] Step 4: `npm test`, `npm run validate` — PASS.
- [ ] Step 5 (controller, live check): `components` 2,770 rows, `ROW_COUNT = KEY_COUNT`; for ME_EC_0000001 the sum of `M_2026_01..12` = `DEMAND_2026` = 19,993 and of `M_2027_*` = 40,850; `product_volumes` 56 rows, sum of 2026 months = `UNITS_2026` = 933,386.
- [ ] Step 6: commit `feat: eight MasterData tabs with rolling monthly columns`.

### Task 3: Manufacturer file reads Component_Usage, Multisource_Members, Product_Volumes

**Files:** Modify `apps-script/MasterData/MfrSelect.ts`, `apps-script/MasterData/MfrFile.ts` (inputs only), `docs/sheets.md` (Manufacturer file section). Tests: `test/apps-script-mfr-select.test.mjs`, `test/apps-script-mfr-file.test.mjs`.

**Interfaces:**
- `mfrBuildRows_(input, selection, onlyUsed, baseYear)` keeps its signature and output (headers, rows, parts) but `input = {components, usage, members, productVolumes}` (`mfrTable_` of `Components`, `Component_Usage`, `Multisource_Members`, `Product_Volumes`). `mfrCategoryTree_(components, usage, members, onlyUsed)`: "used" = ME_EC that is a line primary in `Component_Usage` or an alternative of one.
- Lines: one per `Component_Usage` row (ME_EC × Product ID; Product, EMS from that row). Position 1 = that ME_EC, ME_MS blank, Volume Type `Demand`. Alternatives: rows of `Multisource_Members` with `Is Usable` true in every cluster (ME_MS) that has the primary as a member (any status), primary excluded, deduped per alternative by lowest `Member Priority` (ties: lowest ME_MS) — its ME_MS shown; positions 2, 3 … by Member Priority then ME_EC; Volume Type `Potential volume if sourced`.
- Volumes: yearly `Volume <y>` (Y … Y+10) = `Component_Usage` `Demand <y>` of the line; monthly `<Y>-01 … <Y+1>-12` = Σ over `Product_Volumes` rows with the same Product ID (Series and Sample) of the month's units × `Qty Per Unit`; missing product or month → 0. Same figures on every source row of a line.
- Category, Subcategory, Manufacturer, MPN, Description of each row from `Components` by ME_EC (`(none)` when blank or missing).
- `MfrFile.ts` reads the four tabs instead of `BOM_Sources` / `BOM_Demand_Monthly`; everything else unchanged.

- [ ] Step 1: failing tests — rewrite the fixture: Components (C1 MLCC/0402, C2 MLCC/0603, C3 Resistors/Thick film, C4 MLCC/0402 in two clusters with C1), Component_Usage (C1×P1 qty 2, Demand 2026 = 30), Multisource_Members (MS1: C1 prio 1, C2 prio 2, C4 prio 3; MS2: C1 prio 1, C4 prio 2; one draft member not usable), Product_Volumes (P1 Series 2026-03 = 10, P1 Sample 2026-03 = 5; P2 only Series). Keep every existing test name, adapted; add `a part in two clusters appears once per line` (C4 once, ME_MS = MS2, position by its lowest priority), `monthly volume is product units times qty` (2026-03 = (10+5)×2 = 30 on every row of the line), `a product missing from Product_Volumes gives zero months`, `draft members are not alternatives`.
- [ ] Step 2: run — FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: `npm test`, `npm run validate` — PASS.
- [ ] Step 5: commit `feat(apps-script): manufacturer file from Component_Usage, Multisource_Members and Product_Volumes`.

### Task 4: Live rollout (controller, with the user)

- [ ] `clasp push` from `apps-script/MasterData`.
- [ ] Headless refresh (as on 2026-11-03; resume from `runs/pending.sql` if it pauses). Expected: `DONE uploaded … components=2770 … product_volumes=56 bom_coverage=11` (8 feeds).
- [ ] `_Refresh_Log` SUCCESS; 8 tabs; the 7 old tabs gone; rolling headers in Components and Product_Volumes.
- [ ] The user creates one manufacturer file and checks it.
- [ ] Push the branch and open a PR to `main`.
