# Cloud-Native OpenAerialMap (cn-oam)

## Overview
A radically lean reimagining of OpenAerialMap where the entire backend is files
on S3, queried by the browser. No databases, no tile servers, no Docker, no
24/7 services. Just cloud-native formats + serverless functions.

## Architecture (Static-First)
See `docs/architecture.md` for full design.

**Core idea:** S3 bucket = the backend
- `catalog.parquet` — GeoParquet catalog (searched client-side via DuckDB-WASM)
- `footprints.pmtiles` — vector tiles for map browsing (no API calls)
- `imagery/*.tif` — COGs read directly by browser (maplibre-cog-protocol)
- `thumbnails/*.webp` — image previews
- `app/*` — static frontend SPA

**What runs 24/7:** Nothing.

## Tech Stack
- **Frontend**: React + Vite + MapLibre GL JS + DuckDB-WASM + Tailwind CSS
- **Catalog**: GeoParquet on S3 (stac-geoparquet compatible, Hilbert-sorted)
- **Imagery**: COGs on S3 (EPSG:3857, 256x256, web-optimized)
- **Map tiles**: PMTiles on S3 (footprints) + maplibre-cog-protocol (imagery)
- **Search**: DuckDB-WASM in browser (SQL queries on remote GeoParquet)
- **Upload**: Presigned S3 URLs via Lambda + Step Functions pipeline
- **Auth**: login.hotosm.org (Hanko JWT) via @hotosm/hanko-auth
- **Interop**: Static STAC catalog on S3, optional rustac API

## Key Dependencies
```
# Frontend (npm)
maplibre-gl, pmtiles, @duckdb/duckdb-wasm
@geomatico/maplibre-cog-protocol, @hotosm/hanko-auth

# Ingest pipeline (Lambda container)
python 3.12, gdal, rasterio, rio-cogeo, duckdb, tippecanoe
```

## Project Structure
```
cn-oam/
├── docs/                       # Architecture docs
│   ├── architecture.md         # Static-first design (active)
│   └── architecture-traditional.md  # Traditional eoAPI approach (reference)
├── frontend/                   # React SPA (from oam-vibe)
├── functions/                  # Lambda functions
│   ├── upload-auth/            # JWT validation + presigned URL
│   ├── process-image/          # COG conversion + metadata extraction
│   └── rebuild-catalog/        # GeoParquet merge + PMTiles regen
├── scripts/                    # ETL and migration utilities
└── infra/                      # AWS CDK / SAM for Lambda + S3 + CloudFront
```

## Key Design Decisions
1. **No database** — GeoParquet IS the catalog
2. **No tile server** — COGs read directly by browser
3. **No API server** — DuckDB-WASM does search client-side
4. **No Docker** — Lambda container images for processing only
5. **Serverless only** — nothing runs when nobody is using it

## Cost: ~$60/month for 20K images

## References
- `hotosm/openaerialmap` — current OAM v2 (traditional approach)
- `hotosm/stactools-hotosm` — OAM STAC extension
- `hotosm/login` — HOT SSO (Hanko)
- `cgiovando/oam-vibe` — frontend starting point
- `developmentseed/stac-map` — DuckDB-WASM + GeoParquet reference
- `stac-utils/rustac` — Rust STAC CLI/server (optional API)

## Current Status
- **Phase**: Frontend prototype — compiles, builds, runs
- **Date**: 2026-02-28
- **Done**: Frontend scaffold, DuckDB-WASM catalog search, COG preview, sample GeoParquet (100 records), footprint markers on map, thumbnail placeholders
- **Next**: Upload UI, Lambda functions, real imagery testing

## Key Files
- `frontend/src/lib/catalog.js` — DuckDB-WASM integration (search, stats, getItem)
- `frontend/src/App.jsx` — Root component, wires catalog to map
- `frontend/src/components/Map.jsx` — MapLibre + COG protocol + PMTiles
- `frontend/.env` — VITE_CATALOG_URL for local dev
- `frontend/public/catalog.parquet` — Sample GeoParquet (100 test images)
- `scripts/generate_sample_catalog.py` — Python script to regenerate sample data

## Dev Notes
- DuckDB-WASM v1.32: use `?url` imports for Vite, `stmt.query(...params)` for prepared statements
- Arrow table rows: use `result.toArray().map(r => r.toJSON())` for plain JS objects
- **BigInt gotcha**: DuckDB-WASM returns BigInt for integer columns (file_size, width, height, bands, epsg). Must convert with `Number()` before passing to MapLibre GeoJSON sources or JSON.stringify.
- Catalog URL must be absolute for DuckDB worker context
- `npm run dev` serves from `frontend/`, catalog.parquet at `/cn-oam/catalog.parquet`
- Map uses two GeoJSON sources: `search-results` (polygons) + `search-centroids` (points) — circles visible at all zoom levels, polygon footprints fade in at zoom 8+
