# MECL_PLATFORM.ANALYTICS — view reference

Column types from `INFORMATION_SCHEMA.COLUMNS`; meanings are the stored column comments verbatim-ish unless marked *(inferred)*.

---

## COMPONENT_DEMAND_FORECAST
Grain: month × customer product × part. 110,656 rows, 43 products.

| Column | Type | Meaning |
|---|---|---|
| MONTH_START | DATE | Planned month of the **finished** product. No lead-time offset applied. |
| DEMAND_YEAR | NUMBER(4,0) | Calendar year of MONTH_START. |
| PRODUCT_FLOW_TYPE | TEXT | `series` or `sample`, from the plan row. |
| PRODUCT_ID | NUMBER(38,0) | Customer product whose plan drives the demand. |
| PRODUCT_DISPLAY_NAME | TEXT | Customer product display name. |
| PRODUCT_PARTNUMBER | TEXT | Finished product part number. |
| PROGRAM_ID | NUMBER(38,0) | Programme id. |
| PROGRAM_NAME | TEXT | Programme name. |
| CUSTOMER_NAME | TEXT | Customer codename. |
| EMS_NAME | TEXT | EMS codename. |
| PART_KIND | TEXT(12) | COMPONENT / BOUGHT_ITEM / SUB_ASSEMBLY. |
| PART_ID | NUMBER(38,0) | Part id — **only unique within PART_KIND**. |
| PART_NUMBER | TEXT | Internal part number (ME_EC_ / ME_PN_). |
| MANUFACTURER_NAME | TEXT | Component manufacturer. |
| MPN | TEXT | Manufacturer part number. |
| PART_DESCRIPTION | TEXT | Part description. |
| IS_SOURCED_BY_US | BOOLEAN | The default filter: parts Purchasing sources. |
| IS_INSIDE_BOUGHT_ITEM | BOOLEAN | Part inside an item bought as a unit (the supplier's part). |
| QTY_PER_UNIT | NUMBER(38,6) | Parts per finished product. |
| PLANNED_PRODUCT_UNITS | NUMBER(38,2) | Planned finished units of the product in the month and flow type. |
| REALIZED_PRODUCT_UNITS | NUMBER(38,2) | Of which already realized. |
| DEMAND_QUANTITY | NUMBER(38,8) | QTY_PER_UNIT × PLANNED_PRODUCT_UNITS. Primary parts only; alternatives, scrap, lead time excluded. |
| REALIZED_DEMAND_QUANTITY | NUMBER(38,8) | QTY_PER_UNIT × REALIZED_PRODUCT_UNITS. |

## PRODUCT_CATALOG
Active MECL customer products with full hierarchy and part numbers. One row per customer product (56 rows; PRODUCT_ID and CUSTOMER_PRODUCT_ID both unique). **No column comments exist on this view** — meanings below are inferred from naming and platform rules.

**Quirk:** 11 columns appear twice, once quoted-lowercase and once uppercase (`product_id`/`PRODUCT_ID`, `name_suffix`, `partnumber_HW`, `partnumber_PROD`, `partnumber_customer`, `product_partnumber`, `start_of_production`, `end_of_production`, `end_of_life`, `created_at`, `updated_at`). I checked a sample of the pairs row-by-row: **0 mismatches** — they carry identical values. Unquoted SQL resolves to the uppercase twin; the lowercase ones are reachable only with double quotes.

| Column | Type | Meaning *(all inferred)* |
|---|---|---|
| CUSTOMER_PRODUCT_ID | NUMBER(38,0) | MECL `customer_products.id`. **Not** the BOM/demand/plan key. |
| PRODUCT_ID *(+ `product_id`)* | NUMBER(38,0) | `products.id` — the key every BOM, demand, where-used and plan object joins on. |
| PRODUCT_NAME | TEXT | Raw product name. Rule ident-01: never present this. |
| PRODUCT_DISPLAY_NAME | TEXT | The name to show. Not unique across products (rule ident-03). |
| PRODUCT_SAMPLE_PHASE | TEXT | Sample/series phase label (C2-Sample, Series…). |
| NAME_SUFFIX *(+ lower)* | TEXT | Variant suffix of the name. |
| PARTNUMBER_HW *(+ lower)* | NUMBER(38,0) | Hardware part number. |
| PARTNUMBER_PROD *(+ lower)* | TEXT | Production part number. |
| PARTNUMBER_CUSTOMER *(+ lower)* | TEXT | Customer's own part number. |
| PRODUCT_PARTNUMBER *(+ lower)* | TEXT | Assembled ME part number (ME_PN_…). |
| PRODUCT_TYPE / PRODUCT_SUBTYPE | TEXT | Product classification. |
| PRODUCT_CATEGORY | TEXT | Product category. |
| PRODUCT_PLATFORM | TEXT | Technical platform. |
| IS_AUTOMOTIVE | BOOLEAN | Inherited from the programme. |
| IS_CUSTOMER_PRODUCT_ACTIVE | BOOLEAN | `customer_products.is_active`. |
| IS_PRODUCT_ACTIVE | BOOLEAN | `products.is_active`. |
| PRODUCT_LINE_IS_ACTIVE / PROGRAM_IS_ACTIVE / PROJECT_IS_ACTIVE / CUSTOMER_IS_ACTIVE | BOOLEAN | Active flag of each hierarchy level. |
| IS_HIERARCHY_ACTIVE | BOOLEAN | Product, line, programme, project and customer all active. |
| START_OF_PRODUCTION / END_OF_PRODUCTION / END_OF_LIFE *(+ lower)* | DATE | SOP / EOP / EOL dates. |
| PRODUCT_LINE_ID, PRODUCT_LINE_DISPLAY_NAME | NUMBER / TEXT | Product line. |
| EMS_NAME | TEXT | EMS codename of the product line. |
| PROGRAM_ID, PROGRAM_NAME, PROGRAM_DISPLAY_NAME | NUMBER / TEXT | Programme. |
| PROJECT_ID, PROJECT_NAME, PROJECT_DISPLAY_NAME | NUMBER / TEXT | Project. |
| CUSTOMER_ID, CUSTOMER_NAME, CUSTOMER_DISPLAY_NAME | NUMBER / TEXT | Customer (animal codename). |
| CREATED_AT / UPDATED_AT *(+ lower)* | TIMESTAMP_NTZ | Record create / last change. |

## PRODUCT_DEMAND_BASIS
Materialized daily. One row per planned customer product × year. 253 rows, 253 distinct (PRODUCT_ID, PLAN_YEAR) — unique. PLAN_YEAR spans 2025–2035.

| Column | Type | Meaning |
|---|---|---|
| PRODUCT_ID | NUMBER(38,0) | Customer product (`products.id`). |
| PRODUCT_DISPLAY_NAME | TEXT | Display name. |
| PROGRAM_ID / PROGRAM_NAME | NUMBER / TEXT | Programme. |
| CUSTOMER_NAME | TEXT | Customer codename. |
| EMS_NAME | TEXT | EMS codename. |
| PLAN_YEAR | NUMBER(4,0) | Calendar year of the planned units. |
| SERIES_UNITS | NUMBER(38,2) | Planned series units in the year (plan rule of the P&L). |
| SAMPLE_UNITS | NUMBER(38,2) | Planned sample units in the year. |
| PLANNED_UNITS | NUMBER(38,2) | All planned units in the year. |
| BOM_STATE | TEXT(22) | Production BOM state (from PRODUCT_BOM_COVERAGE): ACTIVE_BOM, ACTIVE_PACKAGE_NO_BOM, DRAFT_PACKAGE_WITH_BOM, DRAFT_PACKAGE_NO_BOM, NO_PACKAGE. |
| DEMAND_BASIS | TEXT(12) | RELEASED_BOM \| DESIGN_BOM \| NONE. |
| DESIGN_PRODUCT_ID | NUMBER(38,0) | DESIGN_BOM basis: the design product of record. |
| DESIGN_PRODUCT_LABEL | TEXT | Its name. |
| DESIGN_CONFIGURATION_KEY | TEXT | DESIGN_BOM basis: the configuration whose parts drive demand. |
| IS_DESIGN_COMPLETE | BOOLEAN | Every sub-assembly the design places has an active design — no parts missing. |
| IS_DESIGN_BOUGHT_AS_UNIT | BOOLEAN | The design product itself is bought as a unit, so its parts are the supplier's. |
| REFRESHED_AT | TIMESTAMP_NTZ | When the materialized table was rebuilt (`UTIL.REFRESH_DESIGN_DEMAND`). |

## COMPONENT_PRICE_AT_DEMAND
5,494 rows; one row per component × demand year × EMS.

| Column | Type | Meaning |
|---|---|---|
| COMPONENT_ID | NUMBER(38,0) | Component (`components.id`). |
| PART_NUMBER | TEXT | Internal component part number (ME_EC_…). |
| MANUFACTURER_NAME | TEXT | Component manufacturer. |
| MPN | TEXT | Manufacturer part number. |
| PART_DESCRIPTION | TEXT | Component description. |
| DEMAND_YEAR | NUMBER(4,0) | Year of the demand (finished-product month basis, no lead-time offset). |
| EMS_ID | NUMBER(38,0) | EMS building the products that create this demand (NULL = no EMS recorded). |
| EMS_NAME | TEXT | EMS codename. |
| EMS_DEMAND | NUMBER(38,8) | Parts needed in the year for this EMS's products (sourced by us, BOM-covered products only). |
| TOTAL_DEMAND | NUMBER(38,8) | Parts needed in the year across every EMS. |
| EMS_PRICE_EUR | NUMBER(38,9) | This EMS's own price (EMS type) at the stage its own demand reaches. EUR at current rate. |
| EMS_PRICE_STAGE | NUMBER(38,0) | Volume stage used for the EMS price. |
| LOA_PRICE_EUR | NUMBER(38,9) | ME-owned LOA price at the stage TOTAL demand reaches. |
| LOA_PRICE_STAGE | NUMBER(38,0) | Volume stage used for the LOA price. |
| INDICATION_PRICE_EUR | NUMBER(38,9) | Indicative (non-binding) price at the total-demand stage. |
| META_PRICE_EUR | NUMBER(38,9) | Benchmark price at the total-demand stage. |
| TARGET_PRICE_EUR | NUMBER(38,9) | Internal target price at the total-demand stage. |
| IS_BELOW_LOWEST_STAGE | BOOLEAN | Demand below the lowest quoted stage; lowest stage's price used and flagged. |
| BEST_BINDING_PRICE_EUR | NUMBER(38,9) | Cheaper of EMS_PRICE_EUR and LOA_PRICE_EUR. |
| BEST_BINDING_PRICE_TYPE | TEXT | EMS or LOA — which one that is. |
| EXPECTED_SPEND_EUR | NUMBER(38,12) | EMS_DEMAND × BEST_BINDING_PRICE_EUR. |
| TARGET_SPEND_EUR | NUMBER(38,12) | EMS_DEMAND × TARGET_PRICE_EUR. |
| GAP_TO_TARGET_EUR | NUMBER(38,12) | EXPECTED_SPEND_EUR − TARGET_SPEND_EUR (positive = above target). |
| IS_PRICED | BOOLEAN | A binding price exists for this row. |
| REFRESHED_AT | **TIMESTAMP_LTZ** | Last refresh from `COMPONENT_PRICE_AT_DEMAND_SRC` (nightly 05:45 Berlin, `UTIL.REFRESH_MATERIALIZED_INPUTS`). |

## COMPONENT_SAVINGS_LEVERS
5,494 rows; same component × year × EMS grain as COMPONENT_PRICE_AT_DEMAND, with the levers bolted on.

| Column | Type | Meaning |
|---|---|---|
| COMPONENT_ID | NUMBER(38,0) | Component (`components.id`). |
| PART_NUMBER / MANUFACTURER_NAME / MPN / PART_DESCRIPTION | TEXT | Component identity. |
| DEMAND_YEAR | NUMBER(4,0) | Year of the demand (finished-product month basis). |
| EMS_ID | NUMBER(38,0) | EMS creating this demand (NULL = none recorded). |
| EMS_NAME | TEXT | EMS codename. |
| EMS_DEMAND | NUMBER(38,8) | Parts needed in the year for this EMS's products (primary parts, BOM-covered products only). |
| TOTAL_DEMAND | NUMBER(38,8) | Parts needed in the year across every EMS. |
| IS_PRICED | BOOLEAN | A binding quote (EMS or LOA) exists at the demand stage. |
| BEST_BINDING_PRICE_EUR | NUMBER(38,9) | Cheaper of the EMS and LOA quote at the demand stage. |
| BEST_BINDING_PRICE_TYPE | TEXT | EMS or LOA. |
| EXPECTED_SPEND_EUR | NUMBER(38,12) | EMS_DEMAND × BEST_BINDING_PRICE_EUR. Reconciles to COMPONENT_PRICE_AT_DEMAND. |
| COMPONENT_SPEND_IN_YEAR_EUR | NUMBER(38,12) | Component's expected spend in the year across every EMS — repeated on each EMS row, **do not sum**. |
| SPEND_RANK_IN_YEAR | NUMBER(18,0) | 1 = highest expected spend in the year. |
| CUMULATIVE_SPEND_SHARE_PCT | NUMBER(38,2) | Pareto share held by this component and every higher-ranked one. |
| EMS_PRICE_EUR | NUMBER(38,9) | This EMS's own quote at the stage its demand reaches. |
| LOA_PRICE_EUR | NUMBER(38,9) | ME-owned LOA quote at the stage total demand reaches. |
| HAS_LOA_PRICE | BOOLEAN | An LOA quote exists. |
| LOA_PASS_THROUGH_VALUE_EUR | NUMBER(38,12) | RISK: (EMS − LOA) × EMS_DEMAND where the EMS quote is higher. Expected spend already assumes the LOA price. |
| NO_LOA_SPEND_EUR | NUMBER(38,12) | Expected spend priced on an EMS quote with no LOA behind it — where an LOA negotiation starts. |
| LOWEST_EMS_PRICE_EUR | NUMBER(38,9) | Lowest EMS quote for the same component/year across EMS partners. |
| LOWEST_EMS_NAME | TEXT | EMS with that quote. |
| EMS_HARMONISATION_SAVING_EUR | NUMBER(38,12) | (BEST_BINDING − LOWEST_EMS) × EMS_DEMAND where another EMS quotes lower. |
| BEST_ALTERNATIVE_COMPONENT_ID | NUMBER(38,0) | Approved alternative (source 2+) on this component's placements that saves most at the same volume. |
| BEST_ALTERNATIVE_PART_NUMBER / _MPN / _MANUFACTURER | TEXT | Its identity. |
| BEST_ALTERNATIVE_PRICE_EUR | NUMBER(38,9) | Its best binding quote at this component's demand stage. |
| ALTERNATIVE_COVERED_DEMAND | NUMBER(38,8) | Parts of EMS_DEMAND on placements where that alternative is approved. |
| ALTERNATIVE_SAVING_EUR | NUMBER(38,12) | (BEST_BINDING − BEST_ALTERNATIVE) × ALTERNATIVE_COVERED_DEMAND. Approved, so no engineering change. |
| PRICE_CELL_SOURCE | TEXT(15) | EXACT / CARRIED_FORWARD / STAGE_CORRECTED. |
| PRICE_SOURCE_ID | NUMBER(38,0) | The price item (quote) behind the best binding price. |
| PRICE_SOURCE_YEAR | NUMBER(38,0) | Year that quote was for. |
| PRICE_QUOTED_ON | TIMESTAMP_NTZ | When that quote was created in MECL. |
| PRICE_VALID_UNTIL | DATE | Validity end of that quote (NULL = open). |
| IS_CARRIED_FORWARD | BOOLEAN | Price comes from an earlier year's quote. |
| IS_QUOTE_EXPIRED | BOOLEAN | That quote's validity ended before today. |
| STALE_PRICE_SPEND_EUR | NUMBER(38,12) | Expected spend priced on a carried-forward or expired quote. |
| IS_BELOW_LOWEST_STAGE | BOOLEAN | Demand below the lowest quoted stage; real price likely higher. |
| BELOW_LOWEST_STAGE_SPEND_EUR | NUMBER(38,12) | Expected spend on such rows. |
| TARGET_PRICE_EUR | NUMBER(38,9) | Internal target price at the total-demand stage. |
| HAS_TARGET_PRICE | BOOLEAN | A target price exists. |
| GAP_TO_TARGET_EUR | NUMBER(38,12) | EXPECTED_SPEND_EUR − EMS_DEMAND × TARGET_PRICE_EUR. |
| REFRESHED_AT | **TIMESTAMP_LTZ** | Last refresh from `COMPONENT_SAVINGS_LEVERS_SRC` (nightly 05:45 Berlin). Show it on any page built on this table. |

## COMPONENT_SOURCING
642 rows, one per component.

| Column | Type | Meaning |
|---|---|---|
| COMPONENT_ID | NUMBER(38,0) | `components.id` = PART_ID (PART_KIND COMPONENT) in every BOM, demand and pricing view. |
| PART_NUMBER / MANUFACTURER_NAME / MPN / PART_DESCRIPTION | TEXT | Component identity. |
| HW_CATEGORY | TEXT | MECL hardware category. |
| IS_INTEGRATED_CIRCUIT | BOOLEAN | The platform's one definition of a chip / IC. |
| COMPONENT_STATUS | TEXT | active = validated, pending = awaiting validation. |
| IS_SOURCED_BY_US | BOOLEAN | Placed at least once outside a bought-as-unit item, so Purchasing sources it. Default filter. |
| PRODUCTS_USING | NUMBER(18,0) | Customer products whose active production BOM uses it as primary source. |
| PLACEMENTS | NUMBER(18,0) | Primary placements on active production BOMs. |
| MULTI_SOURCED_PLACEMENTS | NUMBER(13,0) | Of which the release allows 2+ parts. |
| VALIDATED_ALT_NOT_RELEASED_PLACEMENTS | NUMBER(13,0) | Of which single in the release although a validated alternative exists in the design repo (a release action). |
| ALT_IN_VALIDATION_PLACEMENTS | NUMBER(13,0) | Of which single in the release, alternatives pending validation. |
| TRUE_SINGLE_SOURCE_PLACEMENTS | NUMBER(13,0) | Of which single with no usable alternative anywhere. |
| SOURCING_LEVEL | TEXT(32) | Weakest level across placements: SINGLE_SOURCE > ALTERNATE_IN_VALIDATION > VALIDATED_ALTERNATE_NOT_RELEASED > MULTI_SOURCED. |
| SINGLE_SOURCE_REASONS | TEXT | Distinct reasons of the single-sourced placements (see PLACEMENT_SOURCING). |
| MULTISOURCE_PARTS | TEXT | Clusters (ME_MS_…) the part belongs to. |
| USABLE_ALTERNATES | TEXT | Other usable members of those clusters: part number, manufacturer, MPN, status. |
| USED_ON | TEXT | Display names of the products using it, separated by `\|`. |

## MULTISOURCE_PARTS
One row per interchangeability cluster.

| Column | Type | Meaning |
|---|---|---|
| MULTISOURCE_ID | NUMBER(38,0) | Cluster id. |
| MS_PART_NUMBER | TEXT | ME_MS_… — one interchangeable part, the library part designers place. |
| HW_CATEGORY | TEXT | Hardware category of the cluster. |
| CLUSTER_TYPE | TEXT | electrical / mechanical. |
| CLUSTER_SUBTYPE | TEXT | standard / specific ME. |
| ECAD_ID | TEXT | ECAD library id (CMP-…): the key to Altium. |
| MEMBER_COUNT | NUMBER(18,0) | Members of the cluster. |
| VALIDATED_MEMBERS | NUMBER(13,0) | Members with status active. |
| PENDING_MEMBERS | NUMBER(13,0) | Members pending validation (usable, not ideal). |
| USABLE_MEMBERS | NUMBER(13,0) | Validated + pending. |
| MANUFACTURER_COUNT | NUMBER(18,0) | Distinct manufacturers among usable members. |
| SOURCING_HEALTH | TEXT(16) | MULTI_VALIDATED / ONE_VALIDATED / MULTI_PENDING / SINGLE_USABLE / NO_USABLE_MEMBER. |
| MEMBERS | TEXT | Members in priority order: part number, manufacturer, MPN, status. |
| MEMBERS_SHARED_WITH_OTHER_CLUSTERS | NUMBER(13,0) | Members that also sit in another cluster (legitimate when a part fits two circuits). |
| CURRENT_DESIGNS_PLACING | NUMBER(18,0) | Current designs that place this cluster. |
| ACTIVE_PRODUCTS_USING | NUMBER(18,0) | Customer products whose active production BOM has a placement from this cluster. |
| CREATED_AT | TIMESTAMP_NTZ | Cluster creation time. |
| UPDATED_AT | TIMESTAMP_NTZ | Last change of the cluster or its membership. |

## MULTISOURCE_PART_MEMBERS
895 rows, 864 distinct components; (MULTISOURCE_ID, COMPONENT_ID) is unique.

| Column | Type | Meaning |
|---|---|---|
| MULTISOURCE_ID | NUMBER(38,0) | Cluster id (`multicomponents.id`). |
| MS_PART_NUMBER | TEXT | ME_MS_… — the interchangeable part. |
| MEMBER_PRIORITY | NUMBER(38,0) | Priority of the member in the cluster (1 = preferred). |
| COMPONENT_ID | NUMBER(38,0) | `components.id` of the member. |
| PART_NUMBER | TEXT | Member internal part number (ME_EC_ / ME_MC_). |
| MANUFACTURER_NAME / MPN / PART_DESCRIPTION | TEXT | Member identity. |
| HW_CATEGORY / HW_SUBCATEGORY | TEXT | MECL hardware category / subcategory. |
| MEMBER_STATUS | TEXT | active = validated, pending = in use awaiting validation, draft = not usable, obsolete. |
| IS_VALIDATED | BOOLEAN | MEMBER_STATUS = active. |
| IS_USABLE | BOOLEAN | active or pending. |
| IS_PCN_PENDING | BOOLEAN | A product-change notice is pending on the member. |
| SE_LIFECYCLE | TEXT | SiliconExpert lifecycle (Active, NRND, LTB, Obsolete…). |
| YEARS_TO_END_OF_LIFE | NUMBER(38,2) | Estimated years to end of life. |
| AECQ_AUTOMOTIVE | TEXT | MECL AEC-Q (automotive) flag. |
| MAX_LEADTIME_DAYS | NUMBER(38,0) | Maximum lead time in days (component library). |
| IS_INTEGRATED_CIRCUIT | BOOLEAN | The platform's one definition of a chip / IC. |
| CLUSTERS_OF_COMPONENT | NUMBER(18,0) | How many clusters the member sits in. Clusters are **not transitive**: two clusters sharing a member are not interchangeable with each other. |
| IS_ON_ACTIVE_PRODUCTION_BOM | BOOLEAN | The member is a released source on at least one active production BOM. |
| MEMBER_ADDED_AT | TIMESTAMP_NTZ | When the member was added to the cluster. |

## COMPONENT_PRICE_ITEMS
Quote line items. One row per price item × linked component (an item linked to several components repeats).

| Column | Type | Meaning |
|---|---|---|
| COMPONENT_PRICE_ID | NUMBER(38,0) | MECL price item id. |
| COMPONENT_ID | NUMBER(38,0) | Linked component. NULL = quote not linked to any component. |
| PART_NUMBER / MANUFACTURER_NAME / MPN / PART_DESCRIPTION | TEXT | Identity of the **linked library component**. |
| PRICE_TYPE | TEXT | EMS / LOA / INDICATION / TARGET / META. |
| IS_BINDING | BOOLEAN | EMS or LOA: a price you can buy at. INDICATION and META are reference, TARGET is the goal. |
| PRICE_OWNER_KIND | TEXT(6), NOT NULL | ME, EMS or PERSON (entered by an employee, not published). |
| PRICE_OWNER_NAME | TEXT | ME or the EMS codename owning the price. NULL for PERSON. |
| EMS_ID | NUMBER(38,0) | EMS the price belongs to (EMS type only). |
| EMS_NAME | TEXT | EMS codename (NARWHAL, PENGUIN…). |
| VENDOR | TEXT | Quoting vendor as entered. |
| VENDOR_NORMALIZED | TEXT | Vendor upper-cased and trimmed, to group spelling variants. |
| VENDOR_PARTNUMBER | TEXT | Vendor order code. |
| PRICE_YEAR | NUMBER(38,0) | Year the price is for. |
| VOLUME_STAGE | NUMBER(38,0) | Annual units the price applies **from** (≥ threshold). Not the MOQ. |
| MINIMUM_ORDER_QUANTITY | NUMBER(38,0) | MOQ where quoted. |
| PRICE_PER_UNIT | NUMBER(38,9) | Price per unit in the **quoted** currency — the value to negotiate with. |
| CURRENCY | TEXT | Quoted currency. |
| PRICE_PER_UNIT_EUR_AT_CURRENT_RATE | NUMBER(38,9) | EUR at the **current** rate, recomputed nightly. Not the rate on the quote day. |
| QUOTED_MANUFACTURER | TEXT | Manufacturer named on the quote. |
| QUOTED_MANUFACTURER_PARTNUMBER | TEXT | MPN named on the quote. |
| QUOTED_UNIT_NORMALIZED | TEXT | PIECE, KG or TON (empty unit read as PIECE). |
| IS_PER_PIECE | BOOLEAN | Priced per piece. KG/TON items (coatings, overmoulding) cannot be multiplied by a BOM quantity. |
| QUOTE_REFERENCE | TEXT | Quote reference where recorded. |
| QUOTE_FILE | TEXT | Quote file name in MECL. |
| QUOTE_VALID_START / QUOTE_VALID_END | TIMESTAMP_NTZ | Quote validity window. |
| IS_VALID_TODAY | BOOLEAN | Today lies within validity (open end counts as valid). |
| INTERNAL_FLAG | TEXT | MECL internal check flag. |
| CREATED_AT | TIMESTAMP_NTZ | When the item was created in MECL — the "latest" basis of the price matrix. |
| IS_LINKED | BOOLEAN | The item is linked to at least one component. |

---

# Answers

### 1. COMPONENT_DEMAND_FORECAST

- **PRODUCT_FLOW_TYPE** distinct values: `series`, `sample` (no NULLs).
- **EMS_NAME constant per PRODUCT_ID:** yes. Products with >1 distinct EMS_NAME = **0** (of 43 products); rows with NULL EMS_NAME = 0.
- **QTY_PER_UNIT constant per PRODUCT_ID × PART_ID:** *almost* — **5** of 3,581 (PRODUCT_ID, PART_ID) pairs have more than one value. Adding PART_KIND drops it to **0**: QTY_PER_UNIT is constant per (PRODUCT_ID, PART_KIND, PART_ID). PART_ID alone is not a key — it collides across COMPONENT / BOUGHT_ITEM / SUB_ASSEMBLY. Always carry PART_KIND with PART_ID.
- **IS_SOURCED_BY_US:** yes, it is a BOOLEAN column here (ordinal 17), and it is the documented default filter. 107,560 of 110,656 rows are TRUE.

### 2. COMPONENT_PRICE_AT_DEMAND / COMPONENT_SAVINGS_LEVERS

- **REFRESHED_AT type: `TIMESTAMP_LTZ`** in both views (note: PRODUCT_DEMAND_BASIS.REFRESHED_AT is TIMESTAMP_NTZ instead — the three are not the same type).
- **(COMPONENT_ID, DEMAND_YEAR, EMS_ID) uniqueness:** unique in both. COMPONENT_PRICE_AT_DEMAND: 5,494 rows / 5,494 distinct keys. COMPONENT_SAVINGS_LEVERS: 5,494 / 5,494. (Counted with a NULL-safe concatenated key, so NULL EMS_IDs are not silently dropped.)
- **Can EMS_ID be NULL?** The column is nullable and both comments say "NULL = no EMS recorded" — but **today 0 rows have a NULL EMS_ID** in either view. Code defensively (`NVL`) rather than assuming NOT NULL.

### 3. COMPONENT_SOURCING

**COMPONENT_ID is unique.** 642 rows, 642 distinct COMPONENT_ID. One row per component.

### 4. MULTISOURCE_PART_MEMBERS

| Concept | Column |
|---|---|
| Cluster id | `MULTISOURCE_ID` |
| Cluster number (human-readable) | `MS_PART_NUMBER` (ME_MS_…) |
| Component id | `COMPONENT_ID` |
| Member priority | `MEMBER_PRIORITY` (1 = preferred) |
| Status | `MEMBER_STATUS` (+ derived `IS_VALIDATED`) |
| Usable flag | `IS_USABLE` (active or pending) |

**Can a component be in more than one usable cluster? Yes — 31 components.** 31 components sit in >1 cluster overall, and the same 31 when restricted to rows where `IS_USABLE` is true; the maximum `CLUSTERS_OF_COMPONENT` is 2. The view's own comment warns clusters are not transitive: two clusters sharing a member are **not** interchangeable with each other, so you cannot chain alternates through a shared component.

### 5. PRODUCT_DEMAND_BASIS — released-BOM coverage share

**There is no stored share column.** The flag is `DEMAND_BASIS` (`RELEASED_BOM` | `DESIGN_BOM` | `NONE`). Compute the share per year as:

```sql
SELECT PLAN_YEAR,
       SUM(CASE WHEN DEMAND_BASIS = 'RELEASED_BOM' THEN PLANNED_UNITS ELSE 0 END)
         / NULLIF(SUM(PLANNED_UNITS), 0) AS RELEASED_BOM_UNIT_SHARE
FROM MECL_PLATFORM.ANALYTICS.PRODUCT_DEMAND_BASIS
GROUP BY PLAN_YEAR;
```

**Grain: one row per PRODUCT_ID × PLAN_YEAR** — verified unique (253 rows / 253 distinct pairs), PLAN_YEAR 2025–2035. No product changes basis across years (0 products with >1 distinct DEMAND_BASIS), so basis is effectively a per-product attribute today.

Weight by `PLANNED_UNITS`, not by row count — the two diverge sharply:

| PLAN_YEAR | Products | Planned units | Share by units | Share by product count |
|---|---|---|---|---|
| 2025 | 61 | 597,505 | 46.8% | 34.4% |
| 2026 | 70 | 1,118,180 | 83.5% | 54.3% |
| 2027 | 32 | 2,040,462 | 96.5% | 84.4% |
| 2028 | 26 | 1,693,255 | 95.4% | 80.8% |
| 2029 | 19 | 1,464,965 | 93.4% | 89.5% |
| 2030 | 14 | 1,170,483 | 88.3% | 85.7% |
| 2031–2035 | 10 → 2 | 1,026,532 → 127,421 | 100% | 100% |

The equivalent on the sibling view PRODUCT_BOM_COVERAGE is `SUM(units WHERE IS_BOM_COVERED) / SUM(units)` — that one is a documented platform rule and excludes the DESIGN_BOM basis, which PRODUCT_DEMAND_BASIS adds as a separate, labelled tier.

### 6. COMPONENT_PRICE_ITEMS — PRICE_TYPE

| PRICE_TYPE | Rows | Distinct price items | Distinct components | Binding | Rows with no linked component |
|---|---|---|---|---|---|
| LOA | 14,218 | 13,466 | 1,036 | 14,218 | 4,814 |
| EMS | 3,598 | 3,422 | 638 | 3,598 | 85 |
| INDICATION | 2,560 | 2,381 | 108 | 0 | 1,222 |
| META | 291 | 281 | 4 | 0 | 275 |
| TARGET | 189 | 180 | 89 | 0 | 69 |

Rows exceed distinct price items because an item linked to several components appears once per component. `IS_BINDING` aligns exactly with PRICE_TYPE ∈ {LOA, EMS}. Note the large unlinked tail — 6,465 of 20,856 rows have `COMPONENT_ID IS NULL` (mostly LOA and INDICATION), so filter on `IS_LINKED` before joining to demand.
