# Data Access Plan — NYC Parks Field Availability

## What I Found

The NYC Parks public permit map (`nycgovparks.org/permits/field-and-court/map`) renders availability data by calling two undocumented but fully public JSON endpoints. Both respond to plain `GET` requests with no authentication, cookies, or session required.

I confirmed this by loading the permit map page with a real browser UA (Playwright for discovery, curl for verification), intercepting network traffic, and reading the 43 KB of inline JavaScript that drives the map.

---

## Confirmed Public Endpoints

### 1. Bulk snapshot — all reserved fields at a given datetime

```
GET https://www.nycgovparks.org/api/athletic-fields?datetime=YYYY-MM-DD+H:mm
```

**Response shape:**
```json
{
  "dusk": "20:15",
  "l": ["M071-18-SOCCER-1", "Q005-05-BASKETBALL-1", ...]
}
```

- `dusk` — closing time (HH:MM, 24h) for that day  
- `l` — array of **system IDs** that are reserved at the queried moment. All IDs **not** in this list are available.

**Usage:** Sample each date at **09:00, 12:00, 15:00 and 18:00 New York time** (defined in `SNAPSHOTS` in `lib/availability-client.ts`). Free means no sampled instants booked; Partly booked means some; Busy means all four. Morning, afternoon and evening labels identify booked samples, not whole periods. Bookings between samples can be missed.

### 2. Per-field weekly detail

```
GET https://www.nycgovparks.org/api/athletic-fields?location=SYSTEM_ID&date=YYYY-MM-DD
```

**Response shape:**
```json
{
  "fieldName": "101st St-Soccer-04 C",
  "close": { "2026-04-22": "20:15", ... },
  "availability": {
    "1776862800": {
      "in_season": true,
      "permit_is_for_overlapping_field": false,
      "num_pending_permits": 0,
      "permit_number": 911496,
      "is_issued": true,
      "permit_holder": "BASIS Independent Manhattan",
      "permit_type": "Special Event"
    },
    ...
  }
}
```

- Keys of `availability` are Unix timestamps (30-minute slots).
- A slot is **reserved** if `is_issued === true` OR `num_pending_permits > 0`.
- `close` gives closing time per calendar date.
- The date window covers 7 days starting at `date`.

**Usage:** Fetch only when a user expands a field, including fields marked Free. One call covers up to seven days of slot detail.

---

## Field Catalog Source

**Field metadata does not come from these availability endpoints.** Field names, sport types, surface types, and locations are stored in MapLibre GL vector tiles:

```
https://maps.nycgovparks.org/athletic_facility/{z}/{x}/{y}
```

- Format: MapBox Vector Tiles (protobuf). Responses may be gzip-compressed; the decoder handles either form.
- Source layer name: `athletic_facility_permitable` (permittable fields only; falls back to `athletic_facility`).
- **Zoom 13** covers all of NYC in 182 tiles. Each tile can be decoded with `@mapbox/vector-tile` + `pbf`.

**Verified catalog size:** 5,207 unique fields in the October 2026 refresh across all five boroughs.

### Field record schema (from tile properties)

| Field | Example | Notes |
|-------|---------|-------|
| `system` | `M071-18-SOCCER-1` | Primary key used in all API calls |
| `name` | `Soccer-01` | Short display name from Parks data |
| `primary_sport` | `SCR` | Sport code; see mapping below |
| `sports` | `"4"` | Encoded multi-sport value (not human-readable codes; use `primary_sport` for filtering) |
| `surface_type` | `Synthetic - Large/Full` | Grass, Natural, Asphalt, Turf, etc. |
| `close_at_dusk` | `TRUE` | If `TRUE`, field closes at dusk, not a fixed time |
| `opening_time` | `8:00 AM` | Fixed open time |
| `closing_time` | `10:00pm` | Fixed closing time when not closing at dusk |
| `gispropnum` | `M071` | Exact join key to NYC Open Data Parks Properties |
| `permit_parent` | `M071` | Permit parent identifier |
| `permitable` | `YES` | Filter to `YES` to match the permit workflow |

### Sport codes

| Code | Sport | Code | Sport |
|------|-------|------|-------|
| SCR | Soccer | BSB | Baseball |
| SFB | Softball | BKB | Basketball |
| FTB | Football | HDB | Handball |
| HKY | Hockey | VLB | Volleyball |
| CRK | Cricket | BOC | Bocce |
| TRK | Track and Field | NTB | Netball |
| RBY | Rugby | MPPA | Multi-purpose Play Area |
| TNS | Tennis | | |

---

## Implemented Architecture

```text
scripts/catalog.mjs          # catalog-only setup, optionally --refresh
scripts/poc.mjs              # original exploration CLI, now imports shared lib
lib/field-catalog.ts         # decodes vector tiles and loads cached park names
lib/park-names.ts            # exact GIS property → park-name lookup
lib/availability-client.ts   # bulk snapshots, detail, disk cache, normalization
lib/data-access.ts           # honest User-Agent and serial request queue
lib/validation.ts            # shared date/day validation and system-ID checks
lib/types.ts                 # shared types, sport codes and borough mapping
data/cache/
  fields_catalog.json        # catalog, reused until explicit refresh
  park_names.json            # park lookup, reused until explicit refresh
  availability/
    snapshot_YYYY-MM-DD_HH-MM.json # time-specific snapshot (15 min TTL)
    fields/SYSID_DATE.json   # per-field detail (30 min TTL)
```

### Park-name join

[NYC Open Data Parks Properties (`enfh-gkve`)](https://data.cityofnewyork.us/Recreation/Parks-Properties/enfh-gkve)
exposes `gispropnum` and `name311`. The lookup requests only those two columns.
On October 7, 2026, the 2,061 property records had unique GIS keys. An exact join
initially matched 5,142 of 5,208 older cached fields; after a fresh tile sweep it
matched **5,200 of 5,207** fields. Examples: `R153` → Fairview Park,
`R045` → Schmul Park. Unmatched fields retain their field name and borough;
there is no fuzzy matching. Borough comes from the system-ID prefix:
M = Manhattan, B = Brooklyn, Q = Queens, X = Bronx, R = Staten Island.

### Query flow

1. Run `npm run catalog`: decode 182 tiles in batches of five, with 200 ms between
   batches; cache the catalog and park-name lookup. Existing caches are reused.
2. Filter the catalog by `primary_sport` and `permitable === "YES"`.
3. For each date, fetch four bulk snapshots at 09:00, 12:00, 15:00 and 18:00.
   Uncached availability calls are serialized with a 200 ms delay; concurrent
   requests for the same cache entry share one upstream call.
4. Derive each field's sampled status and booked periods from the reserved-ID sets.
   Return up to 200 rows, prioritizing fields with mixed availability.
5. Fetch weekly slot detail only when a row is expanded. Group issued/pending,
   in-season slots by New York date. Show the returned reserved-slot count,
   permit holders and closing time without estimating the number of free slots.

A cold search costs **four bulk calls per day**, independent of field count,
plus one detail call per expanded field. The CLI uses the same sampling logic.

---

## Risks and Limitations

| Risk | Severity | Notes |
|------|----------|-------|
| Endpoints are undocumented | Medium | No SLA or change notice. The page JS references them directly so they're unlikely to disappear, but the shape could change. |
| Undocumented data access | Low | Both JSON endpoints and a decoded vector tile were verified with the honest `NYCFieldFinder/0.1` User-Agent. Tiles redirect to `www.nycgovparks.org/maps/athletic_facility/…`; no browser spoofing is used. The HTML map is not fetched by the app. |
| Rate limits unknown | Low | No published limit. Use serial availability requests with 200 ms delays and five-tile batches with 200 ms pauses; reuse disk caches. |
| `sports` field is not human-readable codes | Low | The tile's `sports` property appears to be a bitmask, not sport code strings. Filter by `primary_sport` instead. |
| System IDs ≠ sport in all cases | Low | Some multi-use fields have `primary_sport=SCR` but system IDs with `FOOTBALL` in the name. This is a data inconsistency in Parks' own system, not a scraping artifact. |
| Catalog staleness | Low | Fields are added/removed infrequently. Refreshing the catalog weekly or monthly is sufficient. |
| 7-day window on per-field detail | Low | Endpoint 2 always returns 7 days from `date`. This MVP intentionally caps the UI/API to 7 days. |
| Sampling gaps | Medium | Four snapshots cannot prove all-day availability or continuous bookings. Expand any row to inspect returned slots; confirm permits with Parks. |
| Incomplete slot data | Low | Zero returned reservations does not prove a field is open or bookable. Missing closing times display as unknown. |

---

## Out-of-Scope Extensions

1. **Background catalog refresh** — cron or on-demand rebuild of `fields_catalog.json`.
2. **Pagination for a broader product** — if the 7-day cap were removed in a future version, chain endpoint 2 calls behind the scenes.

---

## Setup and the exploration CLI

Requires Node 22.6+ for native TypeScript stripping.

```bash
npm install && npm run catalog && npm run dev

# Refresh field metadata and park names explicitly
npm run catalog -- --refresh

# Original exploration CLI, now using shared library logic
npm run poc -- SCR 2026-10-08 3

# Optionally fetch slot detail for one field
npm run poc -- SCR 2026-10-08 3 M071-18-SOCCER-1
```

Catalog setup fetches metadata only. A cold build makes 182 tile requests and
one park lookup; elapsed time depends on upstream latency. The CLI prints a
short summary and writes `data/cache/poc_results.json`, without automatically
requesting detail for hundreds of fields.
