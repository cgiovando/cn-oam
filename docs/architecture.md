# Cloud-Native OAM — Static-First Architecture

> **Design goal:** The entire platform is files on object storage, queried by
> the browser. Nothing runs 24/7. No databases, no tile servers, no Docker.

---

## Core Idea

What if the OAM "backend" is just a well-organized S3 bucket?

```
s3://oam/
├── catalog.parquet              ← GeoParquet: the entire searchable catalog
├── catalog/pending/*.parquet    ← sidecar files from recent uploads (pre-merge)
├── footprints.pmtiles           ← vector tiles for fast map browsing
├── imagery/{id}.tif             ← COGs (web-optimized, EPSG:3857)
├── thumbnails/{id}.webp         ← image thumbnails
├── stac/catalog.json            ← static STAC catalog (for interop)
└── app/                         ← frontend SPA (static files)
```

The browser does everything:
- **Search** → DuckDB-WASM queries `catalog.parquet` via HTTP range requests
- **Browse** → MapLibre loads `footprints.pmtiles` (no API calls on pan/zoom)
- **Preview** → `maplibre-cog-protocol` reads COGs directly from S3
- **Upload** → presigned S3 URL from a single Lambda function

---

## Architecture Diagram

```
                    ┌─────────────────────────────────────────────────┐
                    │            BROWSER (all the smarts)             │
                    │                                                 │
                    │  ┌─────────┐ ┌──────────┐ ┌────────────────┐  │
                    │  │MapLibre │ │ DuckDB   │ │  Upload Form   │  │
                    │  │+ PMTiles│ │  WASM    │ │  (presigned    │  │
                    │  │+ COG    │ │          │ │   S3 upload)   │  │
                    │  │protocol │ │ Queries  │ │                │  │
                    │  │         │ │ remote   │ │ Auth via       │  │
                    │  │zero tile│ │GeoParquet│ │ hanko-auth     │  │
                    │  │ server  │ │          │ │ web component  │  │
                    │  └────┬────┘ └────┬─────┘ └───────┬────────┘  │
                    │       │           │               │            │
                    └───────┼───────────┼───────────────┼────────────┘
                            │           │               │
          HTTP range reqs   │           │               │ JWT cookie
          (tiles + COGs)    │           │               │
                            ▼           ▼               ▼
                    ┌───────────────────────────────────────────┐
                    │              S3 BUCKET                     │
                    │                                           │
                    │  footprints.pmtiles  (vector tiles)       │
                    │  catalog.parquet     (metadata)           │
                    │  imagery/*.tif       (COGs)               │
                    │  thumbnails/*.webp   (previews)           │
                    │  stac/catalog.json   (interop)            │
                    │  app/*               (frontend SPA)       │
                    └──────────────┬────────────────────────────┘
                                   │
                                   │ S3 Event (on upload to staging/)
                                   ▼
┌──────────────┐         ┌─────────────────┐         ┌──────────────────┐
│ Upload Auth  │         │  Step Functions  │         │ Catalog Rebuild  │
│   Lambda     │         │  Pipeline        │         │ (scheduled)      │
│              │         │                  │         │                  │
│ - Validate   │         │ 1. Validate TIFF │         │ - Merge sidecars │
│   Hanko JWT  │         │ 2. Convert → COG │         │ - Hilbert sort   │
│ - Return     │         │ 3. Gen thumbnail │         │ - Regen PMTiles  │
│   presigned  │         │ 4. Extract meta  │         │ - Regen STAC     │
│   S3 URL     │         │ 5. Write sidecar │         │   catalog JSON   │
│              │         │    .parquet      │         │                  │
│ ~50ms/req    │         │ ~2-5 min/image   │         │ ~5 min/run       │
└──────────────┘         └─────────────────┘         └──────────────────┘

     ↑                                                      ↑
     │ Only serverless function                   Hourly EventBridge
     │ that needs auth                            (or on-demand trigger)
```

---

## What Runs 24/7: NOTHING

| Component | Runtime | Runs when |
|-----------|---------|-----------|
| Frontend SPA | S3 + CloudFront | On user visit (static files) |
| Catalog search | DuckDB-WASM in browser | On user search (client-side) |
| Map browsing | PMTiles via HTTP range reqs | On user pan/zoom (client-side) |
| Image preview | maplibre-cog-protocol | On user click (client-side) |
| Upload auth | Lambda | On upload request (~50ms) |
| COG processing | Step Functions + Lambda | On each upload (~2-5 min) |
| Catalog rebuild | Scheduled Lambda | Hourly (~5 min) |
| Login | login.hotosm.org | Managed by HOT (external) |

---

## The Five Modules

### Module 1: Static Frontend

**Tech:** React + Vite + MapLibre GL JS + Tailwind CSS
**Base:** Evolved from oam-vibe (already works with PMTiles + MapLibre)
**Deploy:** Static files on S3 + CloudFront (or GitHub Pages for dev)

New capabilities to add to oam-vibe:
- **DuckDB-WASM search engine** — spatial, temporal, property queries on catalog.parquet
- **COG preview** — `@geomatico/maplibre-cog-protocol` for in-browser tile rendering
- **Upload UI** — drag-and-drop with progress, presigned S3 upload
- **Auth** — `@hotosm/hanko-auth` web component for login/signup
- **Sharing** — permalink per image with metadata + COG URL + TMS link

Key browser dependencies:
```
maplibre-gl              # Map rendering
pmtiles                  # Vector tile protocol for footprints
@duckdb/duckdb-wasm      # Client-side catalog queries
@geomatico/maplibre-cog-protocol  # COG tile rendering (no server)
@hotosm/hanko-auth       # HOT SSO web component
```

### Module 2: GeoParquet Catalog

**The catalog IS a file.** One GeoParquet on S3 replaces PostgreSQL + pgSTAC.

Schema (stac-geoparquet compatible):
```
id              STRING     ← UUID
geometry        BLOB (WKB) ← footprint polygon
bbox.xmin       DOUBLE     ← } covering column for
bbox.ymin       DOUBLE     ← } row group statistics
bbox.xmax       DOUBLE     ← } (enables remote spatial
bbox.ymax       DOUBLE     ← } filtering without download)
datetime        TIMESTAMP  ← acquisition date
gsd             DOUBLE     ← ground sampling distance (m/px)
platform_type   STRING     ← uav | aircraft | satellite | balloon | kite
producer_name   STRING     ← who captured it
license         STRING     ← CC-BY-4.0 | CC-BY-SA-4.0 | CC-BY-NC-4.0
title           STRING     ← human-readable title
description     STRING     ← optional description
cog_href        STRING     ← s3://oam/imagery/{id}.tif
thumbnail_href  STRING     ← s3://oam/thumbnails/{id}.webp
file_size       INT64      ← COG file size in bytes
width           INT32      ← image width in pixels
height          INT32      ← image height in pixels
bands           INT32      ← number of bands (3 or 4)
epsg            INT32      ← CRS EPSG code
uploaded_by     STRING     ← Hanko user ID
uploaded_at     TIMESTAMP  ← upload timestamp
```

**Preparation for efficient remote queries:**
1. Hilbert-curve spatial sorting (via DuckDB `ST_Hilbert`)
2. bbox covering columns (GeoParquet v1.1)
3. Row group size ~10,000 rows
4. Result: DuckDB-WASM can spatially filter 100K+ items by reading
   only the Parquet metadata + relevant row groups (~few KB per query)

**Update strategy:**
- Each upload writes a tiny sidecar `.parquet` (1 row) to `catalog/pending/`
- Hourly scheduled job merges all sidecars into `catalog.parquet`:
  1. `DuckDB: SELECT * FROM read_parquet(['catalog.parquet', 'catalog/pending/*.parquet'])`
  2. Hilbert sort
  3. Write new `catalog.parquet`
  4. Delete merged sidecars
- Concurrency-safe: multiple uploads writing sidecars never conflict

### Module 3: COG Imagery Layer

**All imagery stored as COGs on S3, accessed directly by browsers.**

COG specification for cn-oam imagery:
- **Projection:** EPSG:3857 (Web Mercator) — required for maplibre-cog-protocol
- **Tile size:** 256x256
- **Compression:** DEFLATE (lossless) or WebP (for RGB)
- **Overviews:** Internal, down to ~256px smallest dimension
- **Tiling scheme:** GoogleMapsCompatible (web-optimized)
- **Creation command:**
  ```bash
  rio cogeo create input.tif output.tif \
    --cog-profile deflate \
    --web-optimized \
    --blocksize 256 \
    --overview-resampling average
  ```

How imagery is accessed:
| Consumer | Method | Server needed |
|----------|--------|---------------|
| Browser (MapLibre) | maplibre-cog-protocol (HTTP range reqs) | No |
| QGIS / ArcGIS | GDAL /vsicurl/ on COG URL | No |
| JOSM / iD | TMS URL via TiTiler Lambda (optional) | Optional |
| Python / rasterio | Direct COG URL | No |
| Download | Direct S3 URL | No |

**Optional: TiTiler Lambda** for consumers needing standard TMS/WMTS:
- Deployed as a Lambda behind API Gateway
- Only needed for WMTS, complex mosaics, or band math
- Can be added later without changing anything else
- Cost: ~$0 when idle (pay per tile request)

### Module 4: Upload Pipeline (Serverless)

**The only server-side code in the entire system.** Two pieces:

#### 4a. Upload Auth Function
A single Lambda (or edge function) that:
1. Validates Hanko JWT from cookie
2. Creates upload record (writes a small JSON to S3)
3. Returns presigned S3 PUT URL for direct browser→S3 upload

```python
# ~30 lines of code
import boto3, jwt, jwcrypto

def handler(event, context):
    token = event['headers'].get('cookie', '').split('hanko=')[1]
    user = validate_hanko_jwt(token)  # verify against JWKS
    upload_id = str(uuid4())
    presigned = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': 'oam', 'Key': f'staging/{upload_id}/image.tif'},
        ExpiresIn=3600
    )
    return {'upload_id': upload_id, 'presigned_url': presigned}
```

#### 4b. Processing Pipeline (Step Functions + Lambda)
Triggered by S3 event when file lands in `staging/`:

```
S3 Event (staging/) → EventBridge → Step Functions
    │
    ├─ Step 1: Validate
    │  - Is it a valid GeoTIFF?
    │  - Has CRS? Valid bounds? Not null island?
    │  - File size within limits?
    │  → fail fast with error status if invalid
    │
    ├─ Step 2: Convert to COG
    │  - rio cogeo create (web-optimized, EPSG:3857, 256x256)
    │  - Write to s3://oam/imagery/{id}.tif
    │
    ├─ Step 3: Generate thumbnail
    │  - rasterio → 512px wide WebP
    │  - Write to s3://oam/thumbnails/{id}.webp
    │
    ├─ Step 4: Extract metadata + write sidecar
    │  - Read CRS, bbox, GSD, dimensions, bands from COG
    │  - Combine with user-provided metadata (title, platform, license)
    │  - Write 1-row GeoParquet to s3://oam/catalog/pending/{id}.parquet
    │
    └─ Step 5: Update status
       - Write status JSON to s3://oam/uploads/{id}/status.json
       - {status: "complete", image_id: "...", cog_url: "..."}
```

Lambda container image includes: Python 3.12, GDAL, rasterio, rio-cogeo.
~2-5 minutes per image. ~$0.02 per image processed.

#### 4c. Catalog Rebuild (Scheduled)
Hourly EventBridge trigger → Lambda:
1. Read `catalog.parquet` + all `catalog/pending/*.parquet`
2. Merge with DuckDB, Hilbert-sort, write new `catalog.parquet`
3. Generate `footprints.pmtiles` via Tippecanoe
4. Generate static STAC JSON catalog (optional, for interop)
5. Upload all to S3, delete merged sidecars

### Module 5: Auth (login.hotosm.org)

**We don't build auth.** We use HOT's managed SSO.

- **Protocol:** Hanko cookie-based JWT on `.hotosm.org`
- **Frontend:** `@hotosm/hanko-auth` web component (npm)
- **Backend:** Validate JWT against `login.hotosm.org/.well-known/jwks.json`
- **Requirement:** Frontend deployed on `oam.hotosm.org`, API on `api.oam.hotosm.org`

Permissions model:
| Action | Auth |
|--------|------|
| Browse / search / view | Public |
| Preview COG on map | Public |
| Download COG | Public |
| Get TMS/WMTS URL | Public |
| Upload imagery | Authenticated |
| View own uploads | Authenticated |
| Edit own image metadata | Authenticated (future) |
| Delete own image | Authenticated (future) |
| Admin moderation | Admin role (future) |

---

## How Search Works (No API Server)

The frontend loads DuckDB-WASM and queries `catalog.parquet` on S3:

```javascript
import * as duckdb from '@duckdb/duckdb-wasm';

const db = await duckdb.AsyncDuckDB.create();
await db.query("INSTALL spatial; LOAD spatial;");

// Spatial search: images in the current map viewport
const results = await db.query(`
  SELECT id, title, datetime, gsd, platform_type,
         thumbnail_href, cog_href,
         ST_AsGeoJSON(geometry) as geojson
  FROM read_parquet('https://oam.hotosm.org/catalog.parquet')
  WHERE bbox.xmin >= ${west} AND bbox.xmax <= ${east}
    AND bbox.ymin >= ${south} AND bbox.ymax <= ${north}
    AND datetime >= '${startDate}'
    AND gsd <= ${maxGsd}
  ORDER BY datetime DESC
  LIMIT 100
`);
```

**Why this works efficiently on a remote file:**
1. DuckDB reads only the Parquet footer first (~few KB)
2. bbox covering columns have min/max statistics per row group
3. Row groups outside the viewport are skipped entirely (predicate pushdown)
4. Only matching row groups are fetched (~few KB to few MB)
5. Hilbert sorting ensures spatial locality within row groups

**Performance expectations (20K items, ~2MB Parquet file):**
- First query: ~200-500ms (fetch footer + relevant row groups)
- Subsequent queries: ~50-100ms (Parquet footer cached by browser)
- At 1M items (~100MB file): still fast thanks to row group pruning

---

## Cost Estimate

For a platform with ~20,000 images, ~100 uploads/month:

| Component | Monthly Cost |
|-----------|-------------|
| S3 storage (2 TB imagery) | ~$46 |
| S3 requests (reads) | ~$5 |
| CloudFront CDN (frontend + catalog) | ~$5 |
| Lambda (upload auth) | ~$0.10 |
| Lambda (COG processing, 100 images) | ~$2 |
| Lambda (hourly catalog rebuild) | ~$1 |
| Step Functions | ~$0.25 |
| **Total** | **~$60/month** |

Compare to traditional architecture:
- RDS PostgreSQL: ~$50-200/month
- ECS/EKS for TiTiler + STAC API: ~$100-500/month
- Redis: ~$15-50/month
- **Traditional total: $200-800/month+**

---

## STAC Interoperability

While the primary interface is browser-based GeoParquet search, we maintain
STAC compatibility for the wider ecosystem:

1. **Static STAC catalog** — generated during catalog rebuild, JSON files on S3.
   Browsable by stac-browser, pystac, etc.

2. **stac-geoparquet** — `catalog.parquet` follows the stac-geoparquet spec,
   directly usable by pystac-client, rustac, stac-map, etc.

3. **Optional: rustac API** — if a standard STAC API endpoint is needed for
   external consumers, deploy `rustac` (single Rust binary, reads the same
   GeoParquet). Zero new infrastructure, just reads existing files.

---

## Migration from Current OAM

1. **Existing COGs** — already on S3 (OIN bucket). No data migration needed.
   Register them by building `catalog.parquet` from existing metadata.

2. **Existing metadata** — use `stactools-hotosm` to convert OAM API metadata
   to stac-geoparquet format. One-time batch job.

3. **PMTiles** — already generated in oam-vibe's ETL. Same approach, just
   regenerated from the new catalog.

4. **Frontend** — oam-vibe already handles PMTiles + MapLibre. Add DuckDB-WASM
   search, COG protocol, and upload UI.

---

## Tradeoffs (Honest Assessment)

| What we gain | What we accept |
|-------------|---------------|
| Zero running infrastructure | New uploads visible after merge (~1 hour delay) |
| ~$60/month vs $200-800+ | DuckDB-WASM spatial ext is experimental (but works) |
| No database to manage | COGs must be EPSG:3857 for browser preview |
| No Docker, no K8s | No real-time WMTS without TiTiler Lambda add-on |
| Scales with S3 (infinite) | Browser does more work (acceptable on modern devices) |
| Modular (swap any piece) | Parquet catalog needs periodic rebuild (not instant) |
| STAC-compatible output | Search limited to what DuckDB-WASM can do client-side |

**Mitigations:**
- The 1-hour delay can be reduced (run rebuild every 15 min, or trigger on upload)
- EPSG:3857 constraint is handled by the ingest pipeline (auto-reproject)
- DuckDB-WASM bbox filtering works even WITHOUT the spatial extension
  (just use `WHERE bbox.xmin >= x AND bbox.xmax <= x2` — it's basic SQL)
- TiTiler Lambda is a drop-in add-on if WMTS is needed later

---

## Technology Validation

Every piece of this architecture has been proven in production:

| Component | Proven by |
|-----------|-----------|
| DuckDB-WASM + GeoParquet in browser | Overture Maps, stac-map (Dev Seed), GeoQuack |
| maplibre-cog-protocol | Geomatico (FOSS4G 2025), 12GB DEM demo |
| stac-geoparquet catalog | Microsoft Planetary Computer, Overture Maps |
| PMTiles on S3 | Protomaps, oam-vibe (already working) |
| Lambda COG processing | NASA (goes-to-cog), ESA (sentinel-2-cog) |
| Tippecanoe in Lambda | MIERUNE (published pattern) |
| Hanko SSO for HOT apps | Drone-TM, fAIr, Export Tool |
| S3 presigned uploads | Standard AWS pattern |

---

## What's NOT in scope (v1)

- Real-time WMTS endpoint (add TiTiler Lambda later if needed)
- Federation / cross-catalog search (future module)
- Private imagery (OAM is open commons)
- Multi-band analysis / band math (not a browser task)
- User roles beyond basic auth (uploader = uploader)
- Mobile-optimized UI (desktop-first, responsive later)
