# Purchasing Master — Design

Date: 2026-10-30 · Owner: a.khisti (Purchasing) · Status: **approved** (2026-10-30)

## 1. Intent

Replace the hand-fed Qlik workbook (`Qlik_Import_to_Googlespreadsheet`, ID `1W9b2U7lMSX5-h8F9ilkvhf4IJqzd4jWAcRLK0rmFJAo`) with **MasterData**: one Google Sheet refreshed every night from Snowflake (`MECL_PLATFORM.ANALYTICS`, which holds MECL, ProFlow and SAP data).

**Principle:** MasterData is the one source of company-system data for every purchasing script, sheet and activity. Snowflake is the source of truth. Logic lives in SQL, not in sheet formulas. Consumers read MasterData tabs by tab name and header.

## 2. Decided by the user

- Snowflake is the source of truth, also where its demand differs from Qlik (Qlik is about 1.8× higher, for example ME_EC_0000001 2026: 35,942 vs 19,993).
- Every Snowflake query runs through the Claude connector "Snowflake - ME Data" under the user's own login (Elevated). No service user.
- Refresh every morning at **07:00 Europe/Berlin**, after the platform refresh (changed from 05:00 by the user).
- MasterData and the raw snapshots live in Drive folder `03_Master File from Snowflake` (`1lP59mBX1dM24emOJlussSvMPbkBiTTUk`). No access restriction.
- One standalone Apps Script project bound to MasterData (no library, no bridge), in its own repo.
- **Only one kind of tab: new, clean, documented tabs.** No Qlik-compatible copies. Consumers (RFQ library, Alternatives DB, LOA tool) are adapted afterwards to read the clean tabs; this project must make sure the tabs contain everything they need (§6).

## 3. Goals, non-goals, anti-goals

Goals: unattended nightly refresh; a dated raw CSV of every query in Drive; clean tabs that cover every known consumer's needs; a run log.

Non-goals: changing consumer code in this project (RFQ, Alternatives DB and LOA adaptations are separate follow-up work); moving Purchasing's own working data (Alternatives DB rows, RFQ log, Sales Data, LOA register and supplier list, process-cost Quarterly Comparison) into MasterData; dashboards.

Anti-goals: a model re-typing data values; silent partial data replacing good data; numbers that break the platform's rules without anyone knowing.

## 4. Constraints

- **Connector truncates silently** at about 340k characters per result (a wide 5,000-row query returned 2,137 rows while `numRows` said 5,000). Results come as JSON (`result_set.data`, `resultSetMetaData.numRows`).
- Claude Code saves MCP results over 50,000 characters to a file automatically; smaller ones go into the conversation.
- Cloud scheduled tasks run with the laptop closed, act as the user, include the user's connectors, run Node/Python, clone a GitHub repo, use subscription usage, and reach non-connector hosts only through an allowlist.
- **Snowflake timing:** the main purchasing views refresh around 05:45 Berlin (`COMPONENT_WHERE_USED`, `COMPONENT_PRICE_MATRIX`, `PRODUCT_BOM_COVERAGE` on 2026-10-30), MECL snapshots load again at 10:00 and some views update in the afternoon. A 07:00 run therefore picks up that morning's refresh; the 10:00 MECL load arrives the next day.
- Platform rules (`ANALYTICS.PLATFORM_RULES`) bind the SQL: demand from `KPI_COMPONENT_DEMAND_BY_YEAR` with `IS_SOURCED_BY_US` (dem-01); per-product quantity from `COMPONENT_WHERE_USED.QTY_PER_UNIT` (ops-10); never sum across multisource clusters that share a member (des-03); prices in quoted currency, EUR-at-current-rate labelled as such (price-02); freshness by `PLATFORM_HEALTH.IS_PROBLEM` (ops-02).

## 5. Architecture

```
07:00 cloud scheduled task (user's account, Snowflake connector only)
  Claude session in a clone of the Purchasing-Master repo, following .claude/skills/nightly-refresh
  1. health gate: PLATFORM_HEALTH + REFRESHED_AT of each source view
  2. per feed: COUNT(*), then key-range pages sized under ~250k characters
     (a PostToolUse hook saves every sql result byte-for-byte to runs/<run-id>/)
  3. verify.js: each page returned == numRows, pages sum == COUNT(*), columns == manifest
  4. shape.js: tab payloads + raw CSV per feed
  5. push.js: gzip HTTPS POST to the MasterData web app with a shared token
MasterData Apps Script (bound, deployed as web app)
  6. check token, write to hidden staging tabs, validate counts (reject a drop > 20% vs last run),
     then swap into the live tabs
  7. save CSVs to Raw snapshots/YYYY-MM-DD/, delete folders older than 30 days
  8. append to _Refresh_Log and update the "last successful refresh" value consumers read
```

Any failure leaves last night's tabs in place and is recorded in `_Refresh_Log`.

**Fallback transport** (if the Workspace blocks the web app): the run commits the shaped CSVs to a `data` branch of the private repo; an Apps Script trigger (08:00) pulls them with a read-only GitHub token and runs steps 6–8.

**Repo** `askhisti/Purchasing-Master`: `apps-script/MasterData/` (TypeScript + clasp), `sql/feeds/*.sql` + `sql/feeds.json` manifest, `refresh/` (Node scripts), `.claude/` (hook + nightly-refresh skill), `docs/` (`sheets.md` = tab contracts), release and validate scripts copied from the RFQ repo conventions.

**Drive:** `03_Master File from Snowflake/MasterData` and `03_Master File from Snowflake/Raw snapshots/<date>/<feed>.csv`.

## 6. MasterData tabs (phase 1)

Contract rules: headers in row 1, data from row 2, one row per key, blanks are empty cells (not `-`), numbers are numbers, dates are `YYYY-MM-DD`. Columns are only ever appended; renaming or removing one is a breaking change. Y = current year at run time; demand columns are Y … Y+10.

| Tab | One row per | Source | Columns |
|---|---|---|---|
| `Components` | ME_EC (library, ~2,760) | `COMPONENT_CATALOG`, `KPI_COMPONENT_DEMAND_BY_YEAR`, `MULTISOURCE_PART_MEMBERS`, `SC_EMS_PART` | ME_EC, Manufacturer, MPN, Description, HW Category, HW Subcategory, Component Status, Lifecycle, Years To EOL, ME_MS (all clusters, comma-separated), Primary ME_MS, EMS Part Numbers (`EMS:part`, comma-separated), Is Sourced By Us, Demand Y … Demand Y+10 |
| `Multisource` | ME_MS (~420) | `MULTISOURCE_PARTS` + member demand | ME_MS, Sourcing Health, Member Count, Usable Member Count, Manufacturer Count, Demand Y … Demand Y+10 (sum of its own usable members only) |
| `Multisource_Members` | ME_MS × ME_EC | `MULTISOURCE_PART_MEMBERS` | ME_MS, ME_EC, Member Status, Is Usable, Member Priority, Manufacturer, MPN |
| `Component_Usage` | ME_EC × product (~3,300) | `COMPONENT_DEMAND_FORECAST`, `COMPONENT_WHERE_USED` | ME_EC, MPN, Manufacturer, Product, Product ID, Project, Program, Customer, EMS, Qty Per Unit, Demand Y … Demand Y+10 |
| `Products` | customer product | `PRODUCT_CATALOG` | Product ID, Product Display Name, Project, Program, Customer, Sample Phase, EMS, SOP, Is Hierarchy Active |
| `MECL_Price` | MECL quote × linked component (~20,900; a quote linked to two components appears twice, so the key is Price ID + ME_EC) | `COMPONENT_PRICE_ITEMS` | Price ID, ME_EC, Resolved ME_EC, Is Linked, Price Type, Price Owner, Vendor, Vendor Part Number, Volume Stage, Year, MOQ, Price, Currency, Price EUR (current rate), Quoted Unit, Quoted Manufacturer, Quoted MPN, Quote Reference, Quote File, Valid From, Valid Until, Is Valid Today, Is Binding, Created At |
| `_Refresh_Log` | run × feed | Apps Script | Run ID, Started, Finished, Feed, Rows, Source Refreshed At, Status, Message; plus a fixed "Last successful refresh" cell |

Definitions:
- **Primary ME_MS**: when a component is in several usable clusters (31 of 818 today), the highest-numbered cluster, which is what Qlik's row order made the RFQ pick. Consumers that need all clusters use `ME_MS` or `Multisource_Members`.
- **Resolved ME_EC**: `ME_EC` when the quote is linked; otherwise the single component whose MPN equals `Quoted MPN` (trimmed, upper-cased); blank if none or ambiguous. 4,814 of 14,218 LOA quotes are unlinked today, so consumers look prices up by `Resolved ME_EC`.
- **Demand** is released-BOM demand (`TOTAL_DEMAND`, series + sample). Design-basis demand is not included.
- **EMS part numbers** exist in Snowflake only for Sanmina; other EMS partners stay blank.
- **Supplier addresses** are not in Snowflake.

Expected size: about 30–40 connector calls per run, most of them the ~10–14 price pages.

## 7. What consumers need (for the follow-up adaptations)

The tabs above are designed so these reads have a direct replacement. This list is the checklist for the RFQ adaptation.

| Consumer read today | Replacement in MasterData |
|---|---|
| RFQ `importMS`: ME_EC → ME_MS (`_Helper_Combined_Data_Multisource` cols A/B) | `Components.Primary ME_MS` |
| RFQ `importLifetimeVolume`: ME_EC demand at SOP year (`Multisource_View` / `Component_View`) | `Components.Demand <year>` |
| RFQ `importMSLifetimeVolume`: ME_MS demand at SOP year (first `Totals` row) | `Multisource.Demand <year>` |
| RFQ Sales BOM Converter: ME_MS → member ME_EC + MFR + MPN | `Multisource_Members` |
| RFQ Sales BOM `Mapping MECL` fallback: MFR_PN → ME_EC | `Components.MPN` |
| RFQ `Cost_Facts`: Project / Product / Sample Phase | `Products` |
| RFQ MECL price import, `Clean MECL Price`, `Update MECL Price`, `Create MFR Quote Files` pre-fill (Supplier Part No., Annual Units, Year, Price Per Unit Currency, Currency, Quote Valid End, Price Type, Price Owner, Vendor, Link Type) | `MECL_Price` (Resolved ME_EC, Volume Stage, Year, Price, Currency, Valid Until, Price Type, Price Owner, Vendor, Is Linked) |
| RFQ 7-day MECL freshness check | `_Refresh_Log` last successful refresh (stale after 2 days) |
| Alternatives DB `MECL Mirror` | `Multisource_Members` + `Components` |
| LOA tool: user enters ME_EC or ME_MS, everything else from MasterData (price already in MECL) | `Multisource_Members` → `Components` → `MECL_Price` by `Resolved ME_EC`; `Vendor` = distributor |

Points to check when adapting the RFQ: year headers change from `2026` / `Usage 2026` to `Demand 2026`; blanks are empty rather than `-`; `Link Type` is replaced by `Is Linked` (the RFQ cleaner accepted all four link types anyway); Price Owner shows `ME` / EMS codename (Qlik showed e-mail addresses on about 1,800 rows — confirm the pre-fill rule `Price Owner = ME` still finds the right quotes).

## 8. Phases

- **Phase 0 — tests and reconciliation.** S1: the capture hook fires in a cloud run and receives full results. S2: the cloud run can POST to a bound web app ("Execute as me / Anyone") with `script.google.com` and `script.googleusercontent.com` allowlisted. S3: confirm the connector size limit. R1: explain the Qlik vs Snowflake demand gap on sample parts, to communicate it and catch SQL errors (not to match Qlik).
- **Phase 1 — MasterData.** Repo, Apps Script, SQL feeds, nightly task, the tabs in §6, raw snapshots, log. Runs beside the Qlik file.
- **Phase 2 — consumers** (separate designs): RFQ library adaptation first (§7), then Alternatives DB; the LOA tool by the user. The `MECL LOA Price` file and the Qlik file stop being fed once the RFQ has switched.
- **Phase 3 — purchasing analysis tabs**: price at demand, savings levers (never summing lever columns), expired/stale quotes, multisource health, EMS shortages and PCN/EOL, LOA-register vs MECL check. The Qlik file is archived after this.

## 9. Builder's calls (open to change)

Separate repo `askhisti/Purchasing-Master`; Node for refresh scripts; 30-day snapshot retention; reject a row drop over 20%; usable multisource members only (active + pending); year window Y … Y+10; web-app transport with GitHub-branch fallback; Primary ME_MS rule as above; `Resolved ME_EC` by exact MPN match only; tab and column names as in §6.

## 10. Left to the builder

SQL text, page sizes, payload chunking, staging/swap mechanics, skill wording, error messages, test strategy.
