# Cloud-Native OpenAerialMap — Architecture

## Design Principles

1. **Cloud-native first** — COGs on object storage, HTTP range requests, no tile pre-generation
2. **Standards-based** — STAC v1.1.0, COG, OGC TMS, WMTS, GeoJSON
3. **Lean** — minimal services, managed databases, serverless where it makes sense
4. **Static frontend** — SPA on CDN, no server-side rendering needed
5. **Federable** — any organization can run their own instance and cross-catalog search

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                   │
│                                                                         │
│   oam-vibe (React + Vite + MapLibre GL JS + Tailwind)                  │
│   Static SPA on CDN (S3 + CloudFront / GitHub Pages)                   │
│                                                                         │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│   │ Map View │  │ Sidebar  │  │ Upload   │  │ Auth (hanko-auth)  │    │
│   │ (browse) │  │ (search) │  │ (ingest) │  │ Web Component      │    │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────────┘    │
│        │              │              │                  │                │
└────────┼──────────────┼──────────────┼──────────────────┼───────────────┘
         │              │              │                  │
         │ XYZ tiles    │ STAC search  │ Upload API       │ JWT cookie
         ▼              ▼              ▼                  ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
│   TiTiler   │  │  STAC API   │  │ Ingest API  │  │ login.hotosm │
│  (pgstac)   │  │ (fastapi-   │  │  (FastAPI)  │  │   .org       │
│             │  │  pgstac)    │  │             │  │  (Hanko SSO) │
│ Dynamic     │  │             │  │ - Presigned │  └──────────────┘
│ raster      │  │ - /search   │  │   S3 upload │
│ tiles from  │  │ - /collecti │  │ - COG valid │
│ COGs on S3  │  │ - /items    │  │ - Thumbnail │
│             │  │ - CQL2      │  │ - Register  │
│ Endpoints:  │  │ - WMTS      │  │   STAC item │
│ /tiles      │  │             │  │             │
│ /tilejson   │  │             │  │             │
│ /wmts       │  │             │  │             │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                 │
       │   ┌────────────┘                 │
       │   │                              │
       ▼   ▼                              │
┌──────────────────┐                      │
│   PostgreSQL     │                      │
│   + pgSTAC       │                      │
│   + PostGIS      │                      │
│                  │◄─────────────────────┘
│  STAC metadata   │
│  Spatial indexes  │
│  CQL2 search     │
└──────────────────┘

       ┌──────────────────────────────────┐
       │     S3-Compatible Storage        │
       │     (AWS S3 / MinIO / R2)        │
       │                                  │
       │  /imagery/{collection}/{id}.tif  │  ← COGs (HTTP range requests)
       │  /thumbnails/{id}.webp           │  ← Thumbnails
       │  /mosaic/footprints.pmtiles      │  ← Vector footprint tiles
       └──────────────────────────────────┘
```

---

## Services (5 total)

### 1. STAC API — Metadata & Search
**What:** stac-fastapi v6.x with pgSTAC backend
**Why:** Industry-standard catalog API, OGC-compliant, CQL2 filtering

Provides:
- `GET /search` — spatial, temporal, property search with CQL2
- `GET /collections` — list imagery collections
- `GET /collections/{id}/items` — browse collection items
- `POST /collections/{id}/items` — register new imagery (auth required)
- `GET /collections/{id}/items/{id}` — single item metadata
- STAC extensions: filter, sort, fields, free-text, transaction

Collections:
- `community` — user-uploaded drone/aerial imagery
- `maxar-open-data` — harvested from Maxar Open Data STAC
- Additional collections for other providers (federated)

### 2. TiTiler — Dynamic Tile Serving
**What:** titiler-pgstac, reads COGs directly from S3
**Why:** No pre-generated tiles needed, serves TMS/WMTS/XYZ on the fly

Provides:
- `/collections/{id}/items/{item_id}/tiles/{z}/{x}/{y}` — single image tiles
- `/searches/{search_id}/tiles/{z}/{x}/{y}` — mosaic tiles from STAC search
- `/collections/{id}/tiles/{z}/{x}/{y}` — collection-level mosaic
- `/collections/{id}/items/{item_id}/tilejson.json` — TileJSON for MapLibre
- `/collections/{id}/items/{item_id}/WMTSCapabilities.xml` — WMTS for GIS clients
- Output formats: PNG, JPEG, WebP, GeoTIFF

### 3. Ingest API — Upload & Processing
**What:** Custom FastAPI service for imagery upload workflow
**Why:** Missing piece in current OAM — clean upload path with validation

Upload flow:
```
1. Client requests presigned S3 URL   →  POST /upload/initiate  (auth required)
2. Client uploads directly to S3       →  PUT {presigned_url}    (browser → S3)
3. Client confirms upload complete     →  POST /upload/complete
4. Worker picks up job:
   a. Validate GeoTIFF (has CRS, valid bounds, not null island)
   b. Convert to COG if needed (rio-cogeo)
   c. Generate thumbnail (WebP)
   d. Extract metadata (bbox, datetime, GSD, bands, projection)
   e. Create STAC Item + register in pgSTAC via Transaction API
   f. Update upload status → "complete"
5. Client polls status                 →  GET /upload/{id}/status
```

Key design decisions:
- **Presigned URLs** — client uploads directly to S3, no proxy bottleneck
- **Async processing** — upload returns immediately, worker processes in background
- **Validation** — reject invalid imagery early (no CRS, corrupt files, null island)
- **Idempotent** — safe to retry any step

### 4. PostgreSQL + pgSTAC — Catalog Database
**What:** pgSTAC v0.9.9 on managed PostgreSQL (RDS / Neon / Supabase)
**Why:** Battle-tested STAC storage with spatial indexing and CQL2 support

Schema:
- pgSTAC tables: `collections`, `items`, `searches` (auto-partitioned by collection)
- Custom tables: `uploads` (upload tracking), `users` (Hanko user mapping)
- Spatial indexes on item geometries
- LISTEN/NOTIFY for downstream event triggers

### 5. Frontend — oam-vibe evolution
**What:** React SPA with MapLibre GL JS, deployed as static files
**Why:** Already built, just needs STAC API + auth integration

Changes from current oam-vibe:
- Replace static PMTiles-only data source with live STAC API search
- Keep PMTiles for fast footprint browsing (as a complementary layer)
- Add TiTiler tile URLs for image preview (replacing CORS-proxied thumbnails)
- Add upload UI (drag-and-drop → presigned S3 upload)
- Add `@hotosm/hanko-auth` web component for login
- Add user profile (my uploads, upload status tracking)

---

## Authentication

**Provider:** login.hotosm.org (Hanko-based SSO)
**Protocol:** Cookie-based JWT on `.hotosm.org` domain

### Flow
1. User clicks "Sign In" → `<hotosm-auth>` web component renders
2. Component redirects to `login.hotosm.org/app`
3. User authenticates (email/password, Google, or passkey)
4. Hanko sets `hanko` cookie (JWT, RS256) on `.hotosm.org`
5. All API requests to `api.oam.hotosm.org` automatically include cookie
6. Backend validates JWT via JWKS at `login.hotosm.org/.well-known/jwks.json`

### Backend middleware (FastAPI)
```python
from hotosm_auth import AuthConfig
from hotosm_auth_fastapi import init_auth, CurrentUser, OptionalUser

config = AuthConfig.from_env()  # HANKO_API_URL=https://login.hotosm.org
init_auth(config)

# Public endpoints (browsing, search) — no auth
@app.get("/search")
async def search(user: OptionalUser): ...

# Protected endpoints (upload, edit) — auth required
@app.post("/upload/initiate")
async def upload(user: CurrentUser): ...
```

### Authorization levels
| Action | Auth Required |
|--------|--------------|
| Browse/search imagery | No |
| View metadata | No |
| View tiles (TMS/WMTS) | No |
| Upload imagery | Yes |
| Edit own imagery metadata | Yes |
| Delete own imagery | Yes |
| Admin actions | Yes + admin role |

### Deployment requirement
App must be on `*.hotosm.org` subdomain for cookie SSO:
- Frontend: `oam.hotosm.org`
- STAC API: `api.oam.hotosm.org`
- TiTiler: `tiles.oam.hotosm.org`
- Ingest API: `api.oam.hotosm.org/ingest/`

---

## Data Model — STAC Item

Each uploaded image becomes a STAC Item:

```json
{
  "type": "Feature",
  "stac_version": "1.1.0",
  "stac_extensions": [
    "https://stac-extensions.github.io/projection/v2.0.0/schema.json",
    "https://stac-extensions.github.io/eo/v2.0.0/schema.json",
    "https://hot.github.io/stac-extension/v1.0.0/schema.json"
  ],
  "id": "uuid-here",
  "collection": "community",
  "geometry": { "type": "Polygon", "coordinates": [...] },
  "bbox": [lon_min, lat_min, lon_max, lat_max],
  "properties": {
    "datetime": "2026-01-15T10:30:00Z",
    "gsd": 0.05,
    "oam:platform_type": "uav",
    "oam:producer_name": "HOT Field Team",
    "license": "CC-BY-4.0",
    "proj:epsg": 32637,
    "created": "2026-02-27T12:00:00Z",
    "updated": "2026-02-27T12:00:00Z"
  },
  "assets": {
    "visual": {
      "href": "s3://oam-imagery/community/uuid-here.tif",
      "type": "image/tiff; application=geotiff; profile=cloud-optimized",
      "title": "COG",
      "roles": ["data", "visual"]
    },
    "thumbnail": {
      "href": "s3://oam-imagery/thumbnails/uuid-here.webp",
      "type": "image/webp",
      "title": "Thumbnail",
      "roles": ["thumbnail"]
    }
  },
  "links": [
    {
      "rel": "tiles",
      "href": "https://tiles.oam.hotosm.org/collections/community/items/uuid-here/tilejson.json",
      "type": "application/json",
      "title": "TileJSON"
    }
  ]
}
```

---

## Footprint Mosaic (PMTiles)

For fast map browsing without hitting the STAC API on every pan:

1. **Scheduled job** (daily or on-change via pgSTAC NOTIFY):
   - Query all items from pgSTAC
   - Export as GeoJSON (id, bbox, datetime, gsd, platform, thumbnail URL)
   - Run through Tippecanoe → PMTiles (zooms 0-14)
   - Upload to S3: `s3://oam-imagery/mosaic/footprints.pmtiles`

2. **Frontend** loads PMTiles via MapLibre + `pmtiles` protocol:
   - Shows footprints at all zooms (no API calls)
   - Click footprint → fetch full STAC item from API
   - Filter client-side by properties embedded in vector tiles

This is exactly the pattern already working in oam-vibe.

---

## Ingest Pipeline Detail

```
                                      ┌───────────────┐
                                      │  S3 Staging   │
  ┌──────────┐    presigned URL       │  Bucket       │
  │  Browser  │ ──────────────────►   │               │
  │  (upload  │    direct upload      │  /staging/    │
  │   form)   │                       │  {upload_id}/ │
  └─────┬─────┘                       └───────┬───────┘
        │                                     │
        │ POST /upload/complete               │ S3 event / poll
        ▼                                     ▼
  ┌───────────┐                       ┌───────────────┐
  │ Ingest    │ ─── enqueue job ───►  │    Worker     │
  │ API       │                       │               │
  └───────────┘                       │ 1. Validate   │
                                      │ 2. → COG      │
        ┌─────────────────────────    │ 3. Thumbnail  │
        │  GET /upload/{id}/status    │ 4. Metadata   │
        │  (poll or webhook)          │ 5. Register   │
        │                             │    STAC Item  │
        ▼                             └───────┬───────┘
  ┌──────────┐                                │
  │  Browser  │                               ▼
  │  (status) │                       ┌───────────────┐
  └──────────┘                        │ S3 Permanent  │
                                      │ /imagery/     │
                                      │ /thumbnails/  │
                                      └───────────────┘
```

### Worker responsibilities
- **Validate**: Check CRS, bounds (not null island), file integrity, band count
- **COG convert**: `rio cogeo create` with DEFLATE compression, 512x512 tiles, internal overviews
- **Thumbnail**: Generate WebP thumbnail (256px wide) via rasterio
- **Metadata extract**: bbox, datetime, GSD, projection, bands → STAC Item
- **Register**: POST to STAC Transaction API to create Item in pgSTAC
- **Cleanup**: Remove staging file after successful processing

### Worker implementation options
| Option | Pros | Cons |
|--------|------|------|
| **Celery + Redis** | Simple, proven | Needs Redis |
| **arq (async Redis)** | Lightweight, async | Needs Redis |
| **PostgreSQL LISTEN/NOTIFY** | No extra infra | Limited scaling |
| **AWS Lambda** | True serverless, scales to zero | Cold starts, 15min limit |
| **Simple polling loop** | Simplest possible | Not great scaling |

**Recommendation**: Start with **arq + Redis** for the worker queue. Simple, async, and Redis is a single container in dev. In production, can use ElastiCache or swap to Lambda later.

---

## Deployment

### Local Development (Docker Compose)
```yaml
services:
  db:         # PostgreSQL 16 + pgSTAC + PostGIS
  redis:      # Job queue for workers
  stac-api:   # stac-fastapi-pgstac
  tiler:      # titiler-pgstac
  ingest-api: # Upload API (FastAPI)
  worker:     # COG conversion worker (arq)
  minio:      # S3-compatible local storage
  frontend:   # Vite dev server
```

### Production (Kubernetes)
- Base on **eoapi-k8s** Helm charts
- Add ingest-api + worker deployments
- Managed PostgreSQL (RDS with pgSTAC migrations via pypgstac)
- S3 for imagery storage
- ALB/Ingress routing:
  - `oam.hotosm.org` → frontend (S3 + CloudFront)
  - `api.oam.hotosm.org` → STAC API + Ingest API
  - `tiles.oam.hotosm.org` → TiTiler
- HPA autoscaling on TiTiler and worker pods

### Minimal production (single VM alternative)
For initial launch or low-traffic deployment:
- Single VM (e.g., t3.xlarge) running Docker Compose
- Managed PostgreSQL (RDS Free Tier or Neon)
- S3 for storage
- Caddy or nginx reverse proxy with Let's Encrypt
- Total cost: ~$50-100/month

---

## API Endpoints Summary

### STAC API (`api.oam.hotosm.org`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | No | Landing page |
| GET | `/search` | No | Search items (GET with query params) |
| POST | `/search` | No | Search items (POST with CQL2 body) |
| GET | `/collections` | No | List collections |
| GET | `/collections/{id}` | No | Collection detail |
| GET | `/collections/{id}/items` | No | List items |
| GET | `/collections/{id}/items/{id}` | No | Item detail |
| POST | `/collections/{id}/items` | Yes | Create item (used by worker) |
| PUT | `/collections/{id}/items/{id}` | Yes | Update item |
| DELETE | `/collections/{id}/items/{id}` | Yes | Delete item |

### Ingest API (`api.oam.hotosm.org/ingest`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/upload/initiate` | Yes | Get presigned S3 URL |
| POST | `/upload/complete` | Yes | Confirm upload, start processing |
| GET | `/upload/{id}/status` | Yes | Check processing status |
| GET | `/uploads/mine` | Yes | List user's uploads |
| DELETE | `/upload/{id}` | Yes | Cancel/delete upload |

### TiTiler (`tiles.oam.hotosm.org`)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/collections/{id}/items/{item_id}/tiles/{z}/{x}/{y}` | No | Single image tiles |
| GET | `/collections/{id}/items/{item_id}/tilejson.json` | No | TileJSON spec |
| GET | `/collections/{id}/items/{item_id}/WMTSCapabilities.xml` | No | WMTS endpoint |
| GET | `/searches/{search_id}/tiles/{z}/{x}/{y}` | No | Mosaic from search |

---

## Migration Path from Current OAM

### Phase 1: Parallel catalog
- Ingest existing OAM metadata into cn-oam pgSTAC (one-time + incremental sync)
- Use stactools-hotosm for conversion (already exists)
- COGs already on S3 (OIN bucket) — just register them, no data migration

### Phase 2: Frontend switch
- Deploy cn-oam frontend at oam.hotosm.org
- Point at new STAC API + TiTiler
- Keep legacy API running for any missing features

### Phase 3: Upload cutover
- Enable new upload pipeline
- Disable legacy upload
- Decommission legacy API + MongoDB

---

## What's NOT in scope (keep it lean)

- **No server-side rendering** — static SPA is sufficient
- **No Kubernetes initially** — Docker Compose on a VM is fine to start
- **No custom tile cache** — TiTiler + CDN cache headers are enough
- **No user roles beyond basic** — uploader vs admin is sufficient
- **No private imagery** — OAM is an open commons (CC-BY/CC-BY-SA only)
- **No multi-tenant isolation** — single shared catalog
- **No real-time features** — polling for upload status is fine
