# Purchasing Master — Monthly demand, analysis tabs, manufacturer files

Date: 2026-11-03 · Owner: a.khisti (Purchasing) · Status: **approved** (2026-11-03), **amended 2026-11-04 (§11 overrides §2, §5, §6 where they differ)** · Extends `2026-10-30-purchasing-master-design.md` (the base design; its contract rules, transport and refresh flow apply unchanged unless this document says otherwise).

## 1. Intent

The first test fill of MasterData (run `2026-11-03T16-58-54`, six feeds loaded) showed two gaps: there are **no product volumes at all**, and component demand exists **only per year**. Purchasing needs monthly and yearly volumes per product and per component, and per component × product × EMS. The user also pulled four phase-3 analysis tabs forward. On top of these tabs comes the first MasterData menu feature: **Create manufacturer file**.

Why the manufacturer file: manufacturers tell Purchasing which component types and subtypes they make (for example MLCC and ceramic capacitors, thin-film and thick-film resistors). Purchasing wants to send them, from MasterData, every component we use in those categories together with its multisource alternatives and the volumes, so the manufacturer can propose their own alternatives and quote prices.

## 2. Decided by the user

- Build now: `Product_Volumes`, `Component_Demand_Monthly`, `BOM_Demand_Monthly`, `BOM_Sources`, `Price_At_Demand`, `Savings_Levers`, `Quote_Health`, `Multisource_Health`, and the **Create manufacturer file** menu item.
- **Months are columns** (wide tabs): one row per part / product / BOM line, one column per month.
- **Released BOM only** (as in the existing tabs). Design-basis-only products stay out.
- `Product_Volumes` carries **planned units only** (not realized units).
- LOA register vs MECL check: **dropped for now** (the LOA register is not in Snowflake and holds no prices).
- Manufacturer file:
  - The user picks HW categories and subcategories in a dialog; MasterData generates **one Google Sheet** for that manufacturer.
  - It is shared as a **Google Sheet link**, or optionally downloaded as an **Excel attachment**.
  - Three sheets: (1) **our parts**, read-only: our components in the chosen categories, their multisource alternatives and their volumes; (2) **their alternatives**: the manufacturer enters their own part number against our parts; (3) **their pricing**, entered separately.
  - Decided 2026-10-30 and still binding: monthly and yearly volumes per EMS; the source position (1st/2nd/3rd) per product; 2nd/3rd sources show the BOM line's full volume labelled **"potential volume if sourced"** (Snowflake demand sits on the primary source only; never add volumes across sources); the file carries a visible **warning that months are the finished product's build month with no lead-time offset**; **nothing is masked** (product and customer codenames, ME_EC numbers, other manufacturers' MPNs and volumes all appear).
- Reading the manufacturer's answers back into MasterData: **later**, not part of this work.

## 3. Goals, non-goals, anti-goals

Goals: the eight tabs refreshed with the nightly run under the existing contract; a menu item that produces a ready-to-share manufacturer file in under a minute for a typical selection.

Non-goals: collecting manufacturers' answers back; emailing files; LOA vs MECL check; any change to the RFQ library, Alternatives DB or LOA tool; design-basis demand.

Anti-goals: a manufacturer file that adds volumes across alternative sources or across multisource clusters; volumes shown without the build-month warning; savings levers presented as addable; generated files that a manufacturer can edit outside their input sheets.

## 4. Snowflake facts (research run 2026-11-03, role ME_READ_T2)

- **Monthly demand source:** `ANALYTICS.COMPONENT_DEMAND_FORECAST`. Grain PRODUCT_ID × PART_KIND × PART_ID × MONTH_START × PRODUCT_FLOW_TYPE (110,656 rows, no fan-out). `DEMAND_QUANTITY = QTY_PER_UNIT × PLANNED_PRODUCT_UNITS` holds on every row. Released-BOM basis, **primary sources only**, no alternates, no scrap. `PART_ID` → `COMPONENT_CATALOG.COMPONENT_ID`. Filter `IS_SOURCED_BY_US` and `PART_KIND = 'COMPONENT'` as the existing feeds do.
- Summed by year it equals `KPI_COMPONENT_DEMAND_BY_YEAR.TOTAL_DEMAND` to the unit (checked on ME_EC_0000001 and ME_EC_0000500, 2026 and 2027), so monthly and yearly tabs agree.
- **Product volumes:** the distinct product rows of the same view: PRODUCT_ID, PRODUCT_DISPLAY_NAME, EMS_NAME, PRODUCT_FLOW_TYPE, MONTH_START, PLANNED_PRODUCT_UNITS (1,424 product × month × flow rows, 43 products; 40 match `PRODUCT_CATALOG`).
- **Month meaning:** `MONTH_START` is the finished product's planned month, which equals the ProFlow committed shipment month at the EMS (rule dem-02). There is **no lead-time offset** and no per-component lead time in the platform. 2025–2026 months are shipment-driven; from 2027 a growing share, and from 2028 most months, are the annual plan spread evenly over 12 months.
- **BOM coverage** (share of planned units on a released BOM, `PRODUCT_DEMAND_BASIS`): 2025 46.8 %, 2026 83.5 %, 2027 96.5 %, 2028 95.4 %, 2029 93.4 %, 2030 88.3 %. Rule dem-01 asks for coverage next to any demand figure.
- **Price at demand:** `ANALYTICS.COMPONENT_PRICE_AT_DEMAND`, component × DEMAND_YEAR × EMS, 5,494 rows. Rule price-01: use this view (or the price matrix), never "the latest quote". price-03: EMS prices apply only to that EMS's demand; binding = EMS + LOA. price-02: EUR columns are at the day's rate and must be labelled.
- **Savings levers:** `ANALYTICS.COMPONENT_SAVINGS_LEVERS`, same grain and key as price at demand (`COMPONENT_ID, DEMAND_YEAR, EMS_ID`), 5,494 rows. Seven lever columns. Rule price-06 (MUST): never add lever columns together; `LOA_PASS_THROUGH_VALUE_EUR` is a **risk**, not a saving. `COMPONENT_SPEND_IN_YEAR_EUR` repeats on each EMS row (do not sum). Stale = carried-forward or expired quote.
- **Quotes:** `COMPONENT_PRICE_ITEMS` (already feeding `MECL_Price`) has `QUOTE_VALID_START/END`, `IS_VALID_TODAY` (open end = valid), `CREATED_AT`, `IS_BINDING`, `PRICE_TYPE`. LOA 14,218 items (7,734 expired, 4,059 open-ended); EMS 3,598 (3,224 expired). Expiry is the norm.
- **Sourcing:** `ANALYTICS.COMPONENT_SOURCING`, 642 rows, one per component that is a primary source on an active BOM: `SOURCING_LEVEL`, `TRUE_SINGLE_SOURCE_PLACEMENTS`, `SINGLE_SOURCE_REASONS`, `USABLE_ALTERNATES`. Rule des-02 (MUST): only `SOURCING_LEVEL = 'SINGLE_SOURCE'` is a true single source. des-03: interchangeability holds within one cluster only; never sum across clusters that share a member.
- Every analysis view is rebuilt nightly around 05:45 Berlin; its `REFRESHED_AT` goes onto the tab (required by the savings-levers dictionary).

## 5. New MasterData tabs

All base contract rules apply: headers in row 1, data from row 2, one row per key, blanks are empty, numbers are numbers, dates `YYYY-MM-DD`, columns only ever appended.

**Month window:** monthly columns run from `2025-01` to December of Y+10 (Y = run year), headed `YYYY-MM`, the same fixed-start rule as the yearly `Demand <year>` columns: each January appends twelve columns and none is removed. Yearly columns, where present, run 2025 … Y+10. Months with no plan are 0.

| Tab | One row per | Columns (in order) | Source | Rows today |
|---|---|---|---|---|
| `Product_Volumes` | product × flow (Series / Sample) | Product ID, Product Display Name, Project, Program, Customer, EMS, Flow, then `Units <year>` 2025 … Y+10, then monthly units `YYYY-MM` | `COMPONENT_DEMAND_FORECAST` distinct product rows, joined to `PRODUCT_CATALOG` for project/program/customer (blank when the product is not in the catalog) | ~80 |
| `Component_Demand_Monthly` | ME_EC with any demand in the window | ME_EC, MPN, Manufacturer, HW Category, HW Subcategory, Primary ME_MS, then monthly demand | `COMPONENT_DEMAND_FORECAST` summed over products and flows | ~620 |
| `BOM_Demand_Monthly` | ME_EC × product × flow | ME_EC, MPN, Manufacturer, Product, Product ID, EMS, Flow, Qty Per Unit, then monthly demand | `COMPONENT_DEMAND_FORECAST` | ~3,500 |
| `BOM_Sources` | BOM line × source, where a BOM line is product × primary ME_EC | Product, Product ID, EMS, BOM ME_EC (the primary on the BOM), ME_MS (the cluster the source comes from; blank for the primary), Source Position (1 = the BOM primary, then 2, 3 … ), Source ME_EC, Manufacturer, MPN, HW Category, HW Subcategory, Member Status, Is Usable, Volume Type (`Demand` for position 1, `Potential volume if sourced` otherwise), then `Volume <year>` 2025 … Y+10 (the BOM line's yearly demand, series + sample, the same figure on every source row of the line) | `COMPONENT_DEMAND_FORECAST` lines × `MULTISOURCE_PART_MEMBERS` | ~7,000 |
| `Price_At_Demand` | component × demand year × EMS | ME_EC, MPN, Manufacturer, Year, EMS, EMS Demand, Total Demand, EMS Price EUR, EMS Price Stage, LOA Price EUR, LOA Price Stage, Target Price EUR, Best Binding Price EUR, Best Binding Price Type, Expected Spend EUR, Target Spend EUR, Gap To Target EUR, Is Priced, Is Below Lowest Stage, Source Refreshed At | `COMPONENT_PRICE_AT_DEMAND` | ~5,500 |
| `Savings_Levers` | component × demand year × EMS | ME_EC, MPN, Manufacturer, Year, EMS, Spend Rank In Year, Cumulative Spend Share %, Expected Spend EUR, Component Spend In Year EUR, LOA Pass-Through Risk EUR, No LOA Spend EUR, EMS Harmonisation Saving EUR, Lowest EMS, Lowest EMS Price EUR, Alternative Saving EUR, Best Alternative MPN, Best Alternative Price EUR, Stale Price Spend EUR, Below Lowest Stage Spend EUR, Gap To Target EUR, Is Quote Expired, Is Carried Forward, Price Valid Until, Has LOA Price, Has Target Price, Source Refreshed At | `COMPONENT_SAVINGS_LEVERS` | ~5,500 |
| `Quote_Health` | ME_EC that has a quote or any demand | ME_EC, MPN, Manufacturer, HW Category, Next Demand Year, Demand Next 12 Months, Valid LOA Quotes, Expired LOA Quotes, LOA Valid Until (latest), Valid EMS Quotes, Expired EMS Quotes, EMS Valid Until (latest), Last Quoted On, Stale Price Spend EUR (current year, from levers, summed over EMS rows of the same year only), Status | `COMPONENT_PRICE_ITEMS` (linked quotes, by Resolved ME_EC as in `MECL_Price`), `COMPONENT_DEMAND_FORECAST`, `COMPONENT_SAVINGS_LEVERS` | ~1,100–2,800 |
| `Multisource_Health` | component that is a primary source on an active BOM | ME_EC, MPN, Manufacturer, HW Category, Sourcing Level, True Single Source Placements, Single Source Reasons, Usable Alternates, ME_MS (all clusters), Cluster Sourcing Health (of the Primary ME_MS), Products Using, Demand Current Year | `COMPONENT_SOURCING`, `MULTISOURCE_PARTS`, demand | ~640 |
| `BOM_Coverage` | plan year | Year, Planned Units, Released BOM Units, Released BOM Share % (the demand tabs' header notes point to this tab) | `PRODUCT_DEMAND_BASIS` | ~11 |

`Quote_Health.Status`, first match wins: `No quote` (no linked quote at all); `All expired` (quotes exist, none valid today); `Expires within 90 days` (the latest valid-until among valid binding quotes is within 90 days of the run date); `Valid`.

Every new tab gets a header-row note stating its grain and its rules: the build-month warning on every tab with months; "never add lever columns; LOA pass-through is a risk" on `Savings_Levers`; "EUR at today's rate, estimate based on quotes, not paid prices" on the price tabs; "only SINGLE_SOURCE is a true single source" on `Multisource_Health`; the BOM coverage per year on the demand tabs.

`BOM_Sources` rules: a BOM line's alternatives are the **usable** members (Is Usable = true) of every multisource cluster that contains the primary, primary excluded, each listed once per line even when it sits in two clusters (then ME_MS shows the cluster with the lowest member priority for it). Positions 2, 3 … follow Member Priority, ties broken by ME_EC. Volumes are never added across rows of the same line.

## 6. Create manufacturer file

**Menu:** `MasterData → Create manufacturer file…`, available to anyone who can open MasterData.

**Dialog:**
- Manufacturer name (free text, required; goes into the file name and the cover).
- Category tree: every HW Category with its HW Subcategories from the `Components` tab, as checkboxes (ticking a category ticks all its subcategories). Shows the number of matching parts per node.
- "Only parts we use" (default on): only components that are on a BOM line in `BOM_Sources` (as primary or as alternative). Off: every library component in the selection.
- Create → progress → a link to the new Google Sheet plus a "Download as Excel" link (the Drive xlsx export URL of the same file).

**Which parts go in:** a part is in the file when its HW Category/Subcategory is selected. A BOM line is in the file when **any** of its sources (primary or alternative) is in the selection, and then **all** its sources are shown, also those in categories that were not selected (the manufacturer must see what competes with what). With "Only parts we use" off, selected library components that are on no BOM line also appear in sheet 2, once each, with Product, EMS, Source Position and volumes blank and Volume Type `Not on a BOM` (builder's call). The per-node part counts in the dialog follow the toggle.

**Sharing:** the generator only creates the file (inside the company Drive folder, so it inherits that folder's access) and returns the link. Purchasing shares it with the manufacturer by hand through Google's Share button (normally adding the manufacturer's contact as Editor), or downloads the Excel and attaches it. No automatic sharing (builder's call). Protection of sheet 2 and of the read-only columns is best effort: an editor can still copy or delete tabs, and the Excel copy has no protection at all.

**Alternative rows:** an alternative's yearly and monthly volumes are the BOM line's volumes, month by month, whatever they are (0 included), labelled `Potential volume if sourced` (builder's call).

**Run time:** a broad selection can produce tens of thousands of rows. The generator writes in chunks and, when a selection does not fit one 6-minute execution, continues in the background and shows the link when finished (builder's mechanics).

**Generated file** (new Google Sheet in Drive folder `03_Master File from Snowflake/Manufacturer files/`, named `<Manufacturer> - component overview - YYYY-MM-DD`):

1. `Read me`: who it is for, generation date, MasterData refresh date, the selected categories, how to fill sheets 3 and 4, and the warnings in bold: months are the finished product's build/shipment month at the EMS with no lead-time offset; from 2028 months are an annual plan spread evenly; volumes on alternative sources are potential volumes if sourced, not demand, and must not be added to the primary's; volumes are plan, not orders.
2. `Our parts` (protected, read-only): one row per BOM line × source (from `BOM_Sources`) in the selection: Category, Subcategory, Product, EMS, BOM ME_EC, Source Position, ME_EC, Manufacturer, MPN, Description, ME_MS, Volume Type, then yearly volumes Y … Y+10, then monthly volumes for the current and next year only, `Y-01` … `(Y+1)-12` (from `BOM_Demand_Monthly` for the line's primary and product, series + sample). Decided by the user 2026-11-03: monthly for the current and next year, yearly thereafter; the MasterData tabs themselves keep every month. Grouped by category, subcategory, BOM ME_EC. Rows of alternative sources are visibly marked "Potential volume if sourced".
3. `Your alternatives` (input): one row per distinct ME_EC from sheet 2, with ME_EC, Manufacturer, MPN, Description read-only, then input columns: Your Alternative MPN, Drop-in Replacement (Yes/No), Differences, Datasheet Link, Comment.
4. `Your pricing` (input): one row per distinct ME_EC (and per alternative MPN the manufacturer proposes, which they add as new rows), with read-only identity columns, then input columns: Quoted MPN, Currency, MOQ, Lead Time (weeks), Price for each year Y … Y+4, Valid Until, Comment.

Sheet 2 is protected; in sheets 3 and 4 only the input columns are editable. The Excel download keeps the same four sheets (protection does not survive Excel; the read-me says the read-only columns must not be changed).

## 7. Refresh impact

Eight new feeds join the six existing ones in `sql/feeds.json` and the same nightly flow (health gate, COUNT, key-range pages, verify, shape, upload, Puller staging and swap, row-drop guard, snapshots, log). The health gate also checks the new source views. Wide tabs (~160 columns) make each page smaller in rows; the page sizer handles that. The Puller's staging slices are sized by cells, not a fixed 4,000 rows, so wide tabs stay within the 270 s budget. Expect roughly 15–20 more minutes of connector paging per run.

## 8. Builder's calls (open to change)

Tab names and column order as in §5; `Quote_Health` status rule and 90-day window; `BOM_Sources` alternative rule (usable members, cluster dedupe, priority order); "Only parts we use" default on; the manufacturer-file folder and file name; input columns of sheets 3 and 4; pricing for five years Y … Y+4 instead of volume stages; monthly volumes in the file from the BOM line's primary demand (series + sample).

## 9. Left to the builder

SQL text and page sizes, feed keys (ROW_KEY), how BOM coverage is shown in notes, staging slice sizing, dialog markup, sheet formatting and protection mechanics, grouping/sorting details, tests.

## 11. Amendment 2026-11-04 (decided by the user after seeing the first 15-tab fill)

This section overrides §2, §5 and §6 where they differ.

**Tabs (8 plus `_Refresh_Log`), in this order:** `Components`, `Multisource`, `Multisource_Members`, `Component_Usage`, `Products`, `MECL_Price`, `Product_Volumes`, `BOM_Coverage`.

**Removed:** `Component_Demand_Monthly` (duplicates Components), `BOM_Demand_Monthly` (= Product_Volumes × Qty Per Unit; Snowflake's identity `DEMAND_QUANTITY = QTY_PER_UNIT × PLANNED_PRODUCT_UNITS` holds on every row), `BOM_Sources` (alternatives are visible in `Multisource_Members`; the manufacturer file derives sources itself), `Price_At_Demand`, `Savings_Levers`, `Quote_Health`, `Multisource_Health`. Tabs that are no longer fed are deleted from MasterData by the script.

**Rolling demand layout** (user's words: "2025 will be only yearly, 2026 and 2027 will be monthly and yearly and 2028 onwards it should be again yearly"):
- Monthly columns exist only for the current year Y and the next year Y+1.
- Order: each year's months come directly before that year's total. Example for Y = 2026: `… | Demand 2025 | 2026-01 … 2026-12 | Demand 2026 | 2027-01 … 2027-12 | Demand 2027 | Demand 2028 | … | Demand 2036`.
- `Components` gets this layout (yearly from `KPI_COMPONENT_DEMAND_BY_YEAR` as today, months from `COMPONENT_DEMAND_FORECAST`, sourced, primary). `Product_Volumes` gets the same layout with `Units <year>`.
- It is a rolling window: each January the past year's 12 month columns disappear and next year's 12 appear. This replaces the "columns are only ever appended" rule for month columns only; yearly columns keep it. Consumers read columns by header name.
- `Component_Usage` stays yearly per product.

**Manufacturer file (§6) data sources:** lines = `Component_Usage` (one per ME_EC × Product ID, with Product, EMS, Qty Per Unit, yearly demand); alternatives = usable members of every `Multisource_Members` cluster that contains the line's primary, primary excluded, deduped by lowest Member Priority (ties: lowest ME_MS), positions 2, 3 … by Member Priority then ME_EC; monthly volume of a line = Σ over Series and Sample rows of `Product_Volumes` (same Product ID) of month units × Qty Per Unit; yearly volume = `Component_Usage` `Demand <year>`; categories, MPN, Manufacturer, Description from `Components` (HW Category / HW Subcategory come from MECL's `COMPONENT_CATALOG`). Everything else in §6 is unchanged (sheets, warnings, monthly only for Y and Y+1, protections).
