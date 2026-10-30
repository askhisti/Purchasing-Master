# MasterData tabs: contract notes (phase 1)

Source of truth for headers is `sql/feeds.json`; SQL is in `sql/feeds/*.sql` (first column `ROW_KEY`, then manifest columns in order, then `DEMAND_Y0..DEMAND_Y10` where applicable). `{{BASE_YEAR}}` is the only placeholder. Demand headers are `Demand <BASE_YEAR+k>`, k = 0..10, appended after the listed columns. Health gate: `sql/health.sql`.

## Step 1 facts (verified against Snowflake on 2026-10-30)

- `COMPONENT_CATALOG.SUPPLIER_PARTNUMBER` holds the `ME_EC_...` number (2,510 `ME_EC_` rows plus 247 `ME_MC_` rows; 2,757 rows, all keys distinct and non-null). `COMPONENT_ID` is the numeric id used by joins.
- `PART_ID` in `KPI_COMPONENT_DEMAND_BY_YEAR` and `COMPONENT_DEMAND_FORECAST` is a mixed id space (`PART_KIND` = COMPONENT, BOUGHT_ITEM, SUB_ASSEMBLY); all joins to the catalog filter `PART_KIND = 'COMPONENT'` so ids cannot collide.
- `PLATFORM_HEALTH.AREA` values: `BASELINE`, `JIRA_PROJECT`, `MECL_SNAPSHOT`, `SAP_ENTITY`, `TASK`. All rows were `IS_PROBLEM = false` at check time. The gate (R34) blocks on `IS_PROBLEM` rows with `AREA = 'MECL_SNAPSHOT'` or whose `OBJECT_NAME` is `TASK_REFRESH_PURCHASING`, `TASK_REFRESH_SUPPLY_CHAIN` or `TASK_REFRESH_PLATFORM_HEALTH`; feed view names never appear in `PLATFORM_HEALTH`, so they are not part of the gate.
- `PRODUCT_CATALOG.PRODUCT_SAMPLE_PHASE` holds values such as `Series`, `C2-Sample`, `A1-Sample`; `START_OF_PRODUCTION` is a DATE (some NULL). Names match content.
- `MULTISOURCE_PARTS.USABLE_MEMBERS` is a count (number), not a list.
- Only `COMPONENT_WHERE_USED` and `SC_EMS_PART` carry `REFRESHED_AT`, so `health.sql` returns `REFRESHED_AT_SC_EMS_PART` and `REFRESHED_AT_COMPONENT_WHERE_USED` only.
- Builder's calls: `Description` = `CORE_DESCRIPTION`, else `HW_DESCRIPTION`; `Lifecycle` = `HW_LIFECYCLE`, else `SE_LIFECYCLE` (HW populated for 666 of 2,757, SE for 2,510); `Years To EOL` = `YEARS_TO_END_OF_LIFE`.

## Components
Key `ME_EC`. Sources `COMPONENT_CATALOG`, `KPI_COMPONENT_DEMAND_BY_YEAR`, `MULTISOURCE_PART_MEMBERS`, `SC_EMS_PART`. Columns: ME_EC (string), Manufacturer (string), MPN (string), Description (string), HW Category (string), HW Subcategory (string), Component Status (string), Lifecycle (string), Years To EOL (number), ME_MS (string; all usable clusters, comma-separated), Primary ME_MS (string; highest-numbered usable cluster), EMS Part Numbers (string; `EMS:part`, latest snapshot, comma-separated), Is Sourced By Us (boolean), Demand Y..Y+10 (number; `TOTAL_DEMAND` of sourced-by-us rows, 0 when none).

## Multisource
Key `ME_MS`. Sources `MULTISOURCE_PARTS` plus member demand. Columns: ME_MS, Sourcing Health (string), Member Count, Usable Member Count, Manufacturer Count (numbers), Demand Y..Y+10 (sum over that cluster's own usable members only; never across clusters sharing a member).

## Multisource_Members
Key `ME_MS|ME_EC`. Source `MULTISOURCE_PART_MEMBERS`, all member statuses. Columns: ME_MS, ME_EC, Member Status (strings), Is Usable (boolean), Member Priority (number), Manufacturer, MPN (strings).

## Component_Usage
Key `ME_EC|PRODUCT_ID`. Sources `COMPONENT_DEMAND_FORECAST` (sourced by us, pivoted by `DEMAND_YEAR`, `DEMAND_QUANTITY`), `COMPONENT_WHERE_USED` (Project). Columns: ME_EC, MPN, Manufacturer, Product, Product ID (number), Project, Program, Customer, EMS (strings), Qty Per Unit (number, `QTY_PER_UNIT`), Demand Y..Y+10 (number, per product).

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
