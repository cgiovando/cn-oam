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
- **Upload**: Presigned S3 URLs via Lambda, single-Lambda processing pipeline
- **Auth**: Simple API key (prototype — not on *.hotosm.org so no Hanko cookie SSO)
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
│   ├── upload-auth/            # API key validation + presigned URL (zip)
│   ├── process-image/          # COG conversion + thumbnail + metadata (container)
│   └── rebuild-catalog/        # GeoParquet merge + Hilbert sort (container)
├── infra/                      # SAM template + config
│   ├── template.yaml           # SAM: API Gateway + 3 Lambdas + S3 triggers
│   └── samconfig.toml          # SAM deploy config (us-east-1, profile admin)
├── scripts/                    # ETL and migration utilities
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
- **Phase**: Upload pipeline deployed and working
- **Date**: 2026-02-28
- **Live**: https://cgiovando.github.io/cn-oam/
- **Repo**: https://github.com/cgiovando/cn-oam
- **Done**: Frontend with search + upload UI, SAM stack deployed (3 Lambdas + API Gateway), upload-auth tested, S3 event trigger configured, GitHub secrets set
- **Next**: Test end-to-end upload flow (upload GeoTIFF → COG conversion → catalog rebuild), add OAM logo

## Deployment
- **GitHub Pages**: auto-deploys on push to `main` via `.github/workflows/deploy.yml`
- **S3 bucket**: `cn-oam` in us-east-1 (AWS account 738775879282)
- **AWS profile**: `--profile admin` (claude-code IAM user, AdministratorAccess)
- **Secrets**: `VITE_MAPBOX_TOKEN` + `VITE_UPLOAD_API_URL` in GitHub repo secrets
- **Catalog URL**: build uses `https://cn-oam.s3.amazonaws.com/catalog.parquet`
- **SAM stack**: `cn-oam-pipeline` — deploy with `cd infra && sam build --use-container && sam deploy --profile admin`
- **Upload API**: `https://uiu7x65oge.execute-api.us-east-1.amazonaws.com/prod`
- **Upload API key**: stored in SSM `/cn-oam/upload-api-key` (pass as parameter override during deploy)
- **S3 trigger**: configured manually via `put-bucket-notification-configuration` (staging/ prefix → process-image Lambda)
- **Architecture**: arm64 (all Lambdas)

## Key Files
- `frontend/src/lib/catalog.js` — DuckDB-WASM integration (search, stats, getItem)
- `frontend/src/App.jsx` — Root component, wires catalog + upload modal to map
- `frontend/src/components/Map.jsx` — MapLibre + COG protocol + PMTiles + centroid circles
- `frontend/src/components/ImageCard.jsx` — Image card with thumbnail fallback
- `frontend/src/components/UploadModal.jsx` — Upload UI (drag-drop, progress, status polling)
- `frontend/src/components/Sidebar.jsx` — Image list + Upload button
- `frontend/.env` — VITE_CATALOG_URL + VITE_MAPBOX_TOKEN + VITE_UPLOAD_API_URL (gitignored)
- `frontend/public/catalog.parquet` — Real GeoParquet (10 OAM images)
- `infra/template.yaml` — SAM template (API Gateway + 3 Lambdas)
- `functions/upload-auth/handler.py` — API key auth + presigned URL generation
- `functions/process-image/handler.py` — COG conversion + thumbnail + sidecar parquet
- `functions/rebuild-catalog/handler.py` — Merge sidecars into catalog.parquet
- `scripts/generate_sample_catalog.py` — Generate synthetic sample data
- `scripts/import_from_oam.py` — Import real images from OAM API to S3 + catalog
- `.github/workflows/deploy.yml` — GitHub Pages deploy workflow

## Dev Notes
- DuckDB-WASM v1.32: use `?url` imports for Vite, `stmt.query(...params)` for prepared statements
- Arrow table rows: use `result.toArray().map(r => r.toJSON())` for plain JS objects
- **BigInt gotcha**: DuckDB-WASM returns BigInt for integer columns (file_size, width, height, bands, epsg). Must convert with `Number()` before passing to MapLibre GeoJSON sources or JSON.stringify.
- Catalog URL must be absolute for DuckDB worker context
- `npm run dev` serves from `frontend/`, catalog.parquet at `/cn-oam/catalog.parquet`
- Map uses two GeoJSON sources: `search-results` (polygons) + `search-centroids` (points) — circles visible at all zoom levels, polygon footprints fade in at zoom 8+
