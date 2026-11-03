# MasterData tabs: contract notes (phase 1)

Source of truth for headers is `sql/feeds.json`; SQL is in `sql/feeds/*.sql` (first column `ROW_KEY`, then manifest columns in order, then `DEMAND_<year>` for each demand year where applicable). Placeholders: `{{BASE_YEAR}}`, and `{{DEMAND: <template>}}`, which expands to one line per demand year with `#YEAR#` replaced (the template starts with a comma). Demand years run from the fixed `firstYear` 2025 (the first year with demand in Snowflake) to BASE_YEAR+10, so each January appends one column and none is ever removed. Demand headers are `Demand <year>`, appended after the listed columns. A feed may set `demandYears.headerPrefix` (default `"Demand "`, e.g. `"Units "`) to change that header prefix. A feed may also carry `demandMonths: {sqlPrefix, firstYear, yearsAhead}`: one column per month from January of `firstYear` to December of BASE_YEAR+`yearsAhead` (twelve more each January), SQL names `<sqlPrefix><year>_<MM>`, headers `YYYY-MM`, type number, placed after the yearly columns. `{{MONTHS: <template>}}` expands to one line per month with `#YEAR#`, `#MONTH#` (1-12) and `#MM#` (01-12) replaced; like DEMAND, a template without `#YEAR#` or with no months is an error. `node scripts/feed-check-sql.mjs <feed> [baseYear]` prints the count SQL and a 3-row sample SQL separated by `-- next`. Health gate: `sql/health.sql`.

## Step 1 facts (verified against Snowflake on 2026-10-30)

- `COMPONENT_CATALOG.SUPPLIER_PARTNUMBER` holds the `ME_EC_...` number (2,510 `ME_EC_` rows plus 247 `ME_MC_` rows; 2,757 rows, all keys distinct and non-null). `COMPONENT_ID` is the numeric id used by joins.
- `PART_ID` in `KPI_COMPONENT_DEMAND_BY_YEAR` and `COMPONENT_DEMAND_FORECAST` is a mixed id space (`PART_KIND` = COMPONENT, BOUGHT_ITEM, SUB_ASSEMBLY); all joins to the catalog filter `PART_KIND = 'COMPONENT'` so ids cannot collide.
- `PLATFORM_HEALTH.AREA` values: `BASELINE`, `JIRA_PROJECT`, `MECL_SNAPSHOT`, `SAP_ENTITY`, `TASK`. All rows were `IS_PROBLEM = false` at check time. The gate (R34) blocks on `IS_PROBLEM` rows with `AREA = 'MECL_SNAPSHOT'` or whose `OBJECT_NAME` is `TASK_REFRESH_PURCHASING`, `TASK_REFRESH_SUPPLY_CHAIN` or `TASK_REFRESH_PLATFORM_HEALTH`; feed view names never appear in `PLATFORM_HEALTH`, so they are not part of the gate.
- `PRODUCT_CATALOG.PRODUCT_SAMPLE_PHASE` holds values such as `Series`, `C2-Sample`, `A1-Sample`; `START_OF_PRODUCTION` is a DATE (some NULL). Names match content.
- `MULTISOURCE_PARTS.USABLE_MEMBERS` is a count (number), not a list.
- Only `COMPONENT_WHERE_USED` and `SC_EMS_PART` carry `REFRESHED_AT`, so `health.sql` returns `REFRESHED_AT_SC_EMS_PART` and `REFRESHED_AT_COMPONENT_WHERE_USED` only.
- Builder's calls: `Description` = `CORE_DESCRIPTION`, else `HW_DESCRIPTION`; `Lifecycle` = `HW_LIFECYCLE`, else `SE_LIFECYCLE` (HW populated for 666 of 2,757, SE for 2,510); `Years To EOL` = `YEARS_TO_END_OF_LIFE`.

## Components
Key `ME_EC`. Sources `COMPONENT_CATALOG`, `KPI_COMPONENT_DEMAND_BY_YEAR`, `MULTISOURCE_PART_MEMBERS`, `SC_EMS_PART`. Columns: ME_EC (string), Manufacturer (string), MPN (string), Description (string), HW Category (string), HW Subcategory (string), Component Status (string), Lifecycle (string), Years To EOL (number), ME_MS (string; all usable clusters, comma-separated), Primary ME_MS (string; highest-numbered usable cluster), EMS Part Numbers (string; `EMS:part`, latest snapshot, comma-separated), Is Sourced By Us (boolean), Demand 2025..Y+10 (number; `TOTAL_DEMAND` of sourced-by-us rows, 0 when none).

## Multisource
Key `ME_MS`. Sources `MULTISOURCE_PARTS` plus member demand. Columns: ME_MS, Sourcing Health (string), Member Count, Usable Member Count, Manufacturer Count (numbers), Demand 2025..Y+10 (sum over that cluster's own usable members only; never across clusters sharing a member).

## Multisource_Members
Key `ME_MS|ME_EC`. Source `MULTISOURCE_PART_MEMBERS`, all member statuses. Columns: ME_MS, ME_EC, Member Status (strings), Is Usable (boolean), Member Priority (number), Manufacturer, MPN (strings).

## Component_Usage
Key `ME_EC|PRODUCT_ID`. Sources `COMPONENT_DEMAND_FORECAST` (sourced by us, pivoted by `DEMAND_YEAR`, `DEMAND_QUANTITY`), `COMPONENT_WHERE_USED` (Project). Columns: ME_EC, MPN, Manufacturer, Product, Product ID (number), Project, Program, Customer, EMS (strings), Qty Per Unit (number, `QTY_PER_UNIT`), Demand 2025..Y+10 (number, per product).

## Products
Key `PRODUCT_ID`. Source `PRODUCT_CATALOG`. Columns: Product ID (number), Product Display Name, Project, Program, Customer (strings), Sample Phase (`PRODUCT_SAMPLE_PHASE`), EMS, SOP (date `YYYY-MM-DD`, `START_OF_PRODUCTION`), Is Hierarchy Active (boolean).

## MECL_Price
Key `COMPONENT_PRICE_ID|COALESCE(PART_NUMBER,'')` (a quote linked to two components appears twice). Source `COMPONENT_PRICE_ITEMS` (plus `COMPONENT_CATALOG` for resolution). Columns: Price ID (number), ME_EC, Resolved ME_EC (`PART_NUMBER` if linked, else the single catalog component whose trimmed upper-cased MPN equals the trimmed upper-cased quoted MPN, else blank), Is Linked (boolean), Price Type, Price Owner, Vendor, Vendor Part Number, Volume Stage (strings), Year (number), MOQ (number), Price (number, quoted currency), Currency, Price EUR (current rate) (number), Quoted Unit, Quoted Manufacturer, Quoted MPN, Quote Reference, Quote File (strings), Valid From, Valid Until (dates), Is Valid Today, Is Binding (booleans), Created At (date).

## Live check, base year 2026 (2026-10-30)

| Feed | ROW_COUNT | KEY_COUNT |
|---|---|---|
| components | 2,757 | 2,757 |
| multisource | 430 | 430 |
| multisource_members | 891 | 891 |
| component_usage | 3,478 | 3,478 |
| products | 54 | 54 |
| mecl_price | 20,856 | 20,856 |

Spot checks: `ME_EC_0000001` Demand 2026 = 19,993 and Demand 2030 = 750 in the feed, equal to `KPI_COMPONENT_DEMAND_BY_YEAR` (PART_KIND COMPONENT, sourced by us). Components with at least one usable cluster: 818; with several usable clusters: 31 (both equal the spec's figures). `mecl_price`: 14,391 linked rows, 14,391 rows with non-null Resolved ME_EC (>= linked); 6,465 unlinked rows, of which 0 resolve by exact trimmed upper-case MPN (45 would match if punctuation were stripped; not done, spec says exact).

## Product_Volumes
Key `PRODUCT_ID|Flow`. Sources `COMPONENT_DEMAND_FORECAST` (all rows, no sourced or part-kind filter; `MAX(PLANNED_PRODUCT_UNITS)` per product, flow and month because product units repeat on every part row), `PRODUCT_CATALOG` (Project; blank when the product is not in the catalog). Columns: Product ID (number), Product Display Name, Project, Program, Customer, EMS, Flow (strings; Flow is `Series` or `Sample`), Units 2025..Y+10 (number; sum of that year's months), then one column per month `2025-01`..`Y+10-12` (number; planned units, 0 when no plan). Page limit 200.

## Component_Demand_Monthly
Key `ME_EC`. Sources `COMPONENT_DEMAND_FORECAST` (sourced by us, `PART_KIND = 'COMPONENT'`, `DEMAND_QUANTITY` summed over products and flows), `COMPONENT_CATALOG`, `MULTISOURCE_PART_MEMBERS`. Columns: ME_EC, MPN, Manufacturer, HW Category, HW Subcategory, Primary ME_MS (strings; highest-numbered usable cluster), then one month column per month `2025-01`..`Y+10-12` (number, 0 when no plan). Components whose total demand is 0 are left out. Page limit 200.

## BOM_Demand_Monthly
Key `ME_EC|PRODUCT_ID|Flow`. Sources `COMPONENT_DEMAND_FORECAST` (sourced by us, `PART_KIND = 'COMPONENT'`), `COMPONENT_CATALOG`. Columns: ME_EC, MPN, Manufacturer, Product, Product ID (number), EMS, Flow (strings), Qty Per Unit (number, `MAX(QTY_PER_UNIT)`), then one month column per month `2025-01`..`Y+10-12` (number, demand of that product and flow, 0 when no plan). Page limit 200.

## BOM_Sources
Key `PRODUCT_ID|BOM ME_EC|Source Position` (position zero-padded to 2). Sources `COMPONENT_DEMAND_FORECAST` (sourced by us, `PART_KIND = 'COMPONENT'`), `MULTISOURCE_PART_MEMBERS`, `COMPONENT_CATALOG`. One BOM line = product x sourced primary component; its volume per year is `DEMAND_QUANTITY` summed over both flows. Each line has one row per source: position 1 is the primary itself (ME_MS, Member Status and Is Usable blank, Volume Type `Demand`); positions 2+ are the usable members (`IS_USABLE`) of every cluster that has the primary as a member (any status), excluding the primary (Volume Type `Potential volume if sourced`). An alternative in two such clusters is kept once, with the lowest member priority (ties: lowest ME_MS), and its ME_MS is that cluster's. Positions are ordered by member priority, then Source ME_EC. Columns: Product, Product ID (number), EMS, BOM ME_EC, ME_MS, Source Position (number), Source ME_EC, Manufacturer, MPN, HW Category, HW Subcategory (identity of the source component), Member Status, Is Usable (boolean), Volume Type, then `Volume 2025`..`Volume Y+10` (number, the line's volume repeated on every row of the line). Volumes are never added across a line's rows: the alternatives' volume is a potential, not extra demand. Page limit 300. Live: 7,231 rows; position 1 = 3,478 lines (Volume 2026 = 451,905,099, equal to the BOM demand total); positions 2-5 = 2,331 / 1,109 / 285 / 28 rows.

## Price_At_Demand
Key `PART_NUMBER|DEMAND_YEAR|EMS_ID` (EMS_ID `-` when none is recorded). One row per component x demand year x EMS. Source `COMPONENT_PRICE_AT_DEMAND`. Columns: ME_EC, MPN, Manufacturer (strings), Year (number), EMS, EMS Demand, Total Demand (numbers), EMS Price EUR, EMS Price Stage, LOA Price EUR, LOA Price Stage, Target Price EUR, Best Binding Price EUR (numbers), Best Binding Price Type (string, EMS or LOA), Expected Spend EUR, Target Spend EUR, Gap To Target EUR (numbers; positive gap = above target), Is Priced, Is Below Lowest Stage (booleans), Source Refreshed At (string, Berlin time `YYYY-MM-DD HH24:MI`). EUR at today's rate; an estimate based on quotes, not paid prices. No year or month columns. Page limit 500. Live: 5,494 rows.

## Savings_Levers
Key `PART_NUMBER|DEMAND_YEAR|EMS_ID` (EMS_ID `-` when none is recorded). Same grain as Price_At_Demand: one row per component x demand year x EMS. Source `COMPONENT_SAVINGS_LEVERS`. Columns: ME_EC, MPN, Manufacturer (strings), Year (number), EMS, Spend Rank In Year, Cumulative Spend Share %, Expected Spend EUR, Component Spend In Year EUR, LOA Pass-Through Risk EUR, No LOA Spend EUR, EMS Harmonisation Saving EUR, Lowest EMS (string), Lowest EMS Price EUR, Alternative Saving EUR, Best Alternative MPN (string), Best Alternative Price EUR, Stale Price Spend EUR, Below Lowest Stage Spend EUR, Gap To Target EUR (numbers), Is Quote Expired, Is Carried Forward (booleans), Price Valid Until (date, blank = open), Has LOA Price, Has Target Price (booleans), Source Refreshed At (string, Berlin time).

Rule price-06 (MUST): never add the lever columns together. The levers overlap, and LOA Pass-Through Risk EUR is a risk (the EMS quote is higher than the LOA price that Expected Spend already assumes), not a saving. Component Spend In Year EUR repeats on every EMS row of the component and year: do not sum it. Stale Price Spend EUR is spend on a carried-forward or expired quote. EUR at today's rate; an estimate based on quotes, not paid prices. No year or month columns. Page limit 500. Live: 5,494 rows.
