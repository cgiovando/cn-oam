#!/usr/bin/env python3
"""
Import real imagery metadata from the OAM API into a cn-oam GeoParquet catalog.

Downloads thumbnails to S3 and references original TIF URLs.
Produces catalog.parquet ready for DuckDB-WASM browser queries.

Usage:
    python scripts/import_from_oam.py [--count 10] [--output catalog.parquet]
"""

import argparse
import json
import os
import subprocess
import tempfile
import urllib.request

import geopandas as gpd
import pandas as pd
from shapely.geometry import shape

OAM_API = "https://api.openaerialmap.org/meta"
S3_BUCKET = "cn-oam"
AWS_PROFILE = "admin"


def fetch_oam_images(count=10):
    """Fetch diverse recent imagery from OAM API."""
    url = f"{OAM_API}?limit={count}&acquisition_from=2024-01-01"
    print(f"Fetching {count} images from OAM API...")
    with urllib.request.urlopen(url) as resp:
        data = json.loads(resp.read())

    results = data.get("results", [])
    print(f"  Got {len(results)} results (API has {data['meta']['found']} total)")
    return results


def download_thumbnail(thumb_url, image_id):
    """Download thumbnail and upload to S3. Returns S3 URL."""
    if not thumb_url:
        return None

    try:
        # Download to temp file
        ext = ".png" if thumb_url.endswith(".png") else ".webp"
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp_path = tmp.name
            urllib.request.urlretrieve(thumb_url, tmp_path)

        # Upload to S3
        s3_key = f"thumbnails/{image_id}{ext}"
        s3_url = f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}"

        subprocess.run(
            [
                "aws", "--profile", AWS_PROFILE,
                "s3", "cp", tmp_path, f"s3://{S3_BUCKET}/{s3_key}",
                "--content-type", f"image/{'png' if ext == '.png' else 'webp'}",
            ],
            capture_output=True, text=True, check=True,
        )
        os.unlink(tmp_path)
        print(f"    Uploaded thumbnail: {s3_key}")
        return s3_url

    except Exception as e:
        print(f"    Thumbnail failed for {image_id}: {e}")
        return thumb_url  # fall back to original URL


def oam_to_record(item):
    """Convert an OAM API result to a catalog record."""
    props = item.get("properties", {})
    image_id = item["_id"]

    # Download and re-host thumbnail
    thumb_url = props.get("thumbnail", "")
    s3_thumb = download_thumbnail(thumb_url, image_id)

    # Parse geometry
    geojson = item.get("geojson", {})
    geom = shape(geojson) if geojson else None

    # The original TIF URL — this is the COG href
    cog_url = item.get("uuid", "")

    # GSD: OAM stores in degrees, convert roughly to meters
    gsd_deg = item.get("gsd")
    gsd_m = round(gsd_deg * 111320, 2) if gsd_deg else None

    return {
        "id": image_id,
        "title": item.get("title", "Untitled"),
        "datetime": item.get("acquisition_start", item.get("uploaded_at", "")),
        "gsd": gsd_m,
        "platform_type": (item.get("platform") or "unknown").lower(),
        "producer_name": item.get("provider", "Unknown"),
        "license": "CC-BY-4.0",  # OAM default
        "cog_href": cog_url,
        "thumbnail_href": s3_thumb,
        "file_size": item.get("file_size", 0),
        "width": None,  # Not in OAM API
        "height": None,
        "bands": 3,
        "epsg": 4326,
        "uploaded_by": item.get("contact", ""),
        "uploaded_at": item.get("uploaded_at", ""),
        "geometry": geom,
    }


def build_catalog(records, output_path):
    """Build GeoParquet catalog from records."""
    gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")

    # Remove rows with no geometry
    gdf = gdf[gdf.geometry.notnull()]

    # Sort by Hilbert curve for spatial locality
    try:
        gdf = gdf.sort_values("geometry", key=lambda col: col.hilbert_distance())
        print("  Sorted by Hilbert curve")
    except Exception:
        gdf = gdf.sort_values("datetime", ascending=False)
        print("  Sorted by datetime")

    # Write GeoParquet with bbox covering columns
    gdf.to_parquet(
        output_path,
        engine="pyarrow",
        write_covering_bbox=True,
        row_group_size=100,
    )

    file_size = os.path.getsize(output_path)
    print(f"\nCatalog written: {output_path}")
    print(f"  Records: {len(gdf)}")
    print(f"  File size: {file_size / 1024:.1f} KB")

    return output_path


def upload_catalog(local_path):
    """Upload catalog.parquet to S3."""
    s3_key = "catalog.parquet"
    subprocess.run(
        [
            "aws", "--profile", AWS_PROFILE,
            "s3", "cp", local_path, f"s3://{S3_BUCKET}/{s3_key}",
            "--content-type", "application/octet-stream",
        ],
        capture_output=True, text=True, check=True,
    )
    print(f"  Uploaded to s3://{S3_BUCKET}/{s3_key}")


def main():
    parser = argparse.ArgumentParser(description="Import OAM imagery to cn-oam catalog")
    parser.add_argument("--count", "-n", type=int, default=10)
    parser.add_argument("--output", "-o", default="catalog.parquet")
    parser.add_argument("--upload", action="store_true", help="Upload to S3 after building")
    args = parser.parse_args()

    items = fetch_oam_images(args.count)

    print(f"\nProcessing {len(items)} images...")
    records = []
    for item in items:
        print(f"  {item['_id'][:12]}: {item['title'][:50]}")
        records.append(oam_to_record(item))

    catalog_path = build_catalog(records, args.output)

    if args.upload:
        upload_catalog(catalog_path)

    print("\nDone!")


if __name__ == "__main__":
    main()
