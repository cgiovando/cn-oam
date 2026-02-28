#!/usr/bin/env python3
"""
Generate a sample catalog.parquet with realistic test imagery metadata.

This creates GeoParquet v1.1 with bbox covering columns so DuckDB-WASM can
do efficient spatial filtering via Parquet row group statistics.

Usage:
    python scripts/generate_sample_catalog.py [--output catalog.parquet] [--count 50]
"""

import argparse
import random
import uuid
from datetime import datetime, timedelta

import geopandas as gpd
import pandas as pd
from shapely.geometry import box


# Realistic sample locations (cities with HOT/humanitarian relevance)
LOCATIONS = [
    {"name": "Kathmandu", "lon": 85.32, "lat": 27.72, "country": "Nepal"},
    {"name": "Dhaka", "lon": 90.41, "lat": 23.81, "country": "Bangladesh"},
    {"name": "Port-au-Prince", "lon": -72.34, "lat": 18.54, "country": "Haiti"},
    {"name": "Maputo", "lon": 32.59, "lat": -25.97, "country": "Mozambique"},
    {"name": "Dar es Salaam", "lon": 39.28, "lat": -6.79, "country": "Tanzania"},
    {"name": "Manila", "lon": 120.98, "lat": 14.60, "country": "Philippines"},
    {"name": "Nairobi", "lon": 36.82, "lat": -1.29, "country": "Kenya"},
    {"name": "Jakarta", "lon": 106.85, "lat": -6.21, "country": "Indonesia"},
    {"name": "Freetown", "lon": -13.23, "lat": 8.48, "country": "Sierra Leone"},
    {"name": "Monrovia", "lon": -10.80, "lat": 6.30, "country": "Liberia"},
    {"name": "Kampala", "lon": 32.58, "lat": 0.35, "country": "Uganda"},
    {"name": "Lusaka", "lon": 28.28, "lat": -15.42, "country": "Zambia"},
    {"name": "Accra", "lon": -0.19, "lat": 5.56, "country": "Ghana"},
    {"name": "Addis Ababa", "lon": 38.75, "lat": 9.02, "country": "Ethiopia"},
    {"name": "Lima", "lon": -77.03, "lat": -12.05, "country": "Peru"},
    {"name": "Bogota", "lon": -74.07, "lat": 4.71, "country": "Colombia"},
    {"name": "Yangon", "lon": 96.20, "lat": 16.87, "country": "Myanmar"},
    {"name": "Suva", "lon": 178.44, "lat": -18.14, "country": "Fiji"},
    {"name": "Beira", "lon": 34.87, "lat": -19.84, "country": "Mozambique"},
    {"name": "Goma", "lon": 29.23, "lat": -1.68, "country": "DR Congo"},
]

PLATFORMS = ["satellite", "uav", "uav", "uav", "satellite", "aircraft"]
LICENSES = ["CC-BY-4.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC-BY-NC-4.0"]
PRODUCERS = [
    "HOT Drone Team", "MapGive", "Médecins Sans Frontières",
    "World Bank", "UNICEF Innovation", "OpenDroneMap Community",
    "Maxar Open Data", "Planet Labs", "Airbus DS",
    "Local Mapping Team", "USAID GeoCenter", "Missing Maps"
]

S3_BASE = "https://cn-oam.s3.amazonaws.com"


def random_bbox(center_lon, center_lat, platform):
    """Generate a realistic bbox around a center point based on platform type."""
    if platform == "satellite":
        # Satellite: larger area (0.05–0.2 degrees)
        half_w = random.uniform(0.05, 0.2)
        half_h = random.uniform(0.05, 0.15)
    elif platform == "uav":
        # Drone: small area (0.005–0.02 degrees)
        half_w = random.uniform(0.005, 0.02)
        half_h = random.uniform(0.005, 0.015)
    else:
        # Aircraft: medium
        half_w = random.uniform(0.02, 0.08)
        half_h = random.uniform(0.02, 0.06)

    # Add some random offset from center
    offset_lon = random.uniform(-0.1, 0.1)
    offset_lat = random.uniform(-0.1, 0.1)

    west = center_lon + offset_lon - half_w
    east = center_lon + offset_lon + half_w
    south = center_lat + offset_lat - half_h
    north = center_lat + offset_lat + half_h

    return west, south, east, north


def generate_sample_data(count=50):
    """Generate sample imagery metadata records."""
    records = []

    for i in range(count):
        loc = random.choice(LOCATIONS)
        platform = random.choice(PLATFORMS)
        license_type = random.choice(LICENSES)
        producer = random.choice(PRODUCERS)

        # Random date in the last 2 years
        days_ago = random.randint(1, 730)
        dt = datetime.now() - timedelta(days=days_ago)

        # Generate bbox
        west, south, east, north = random_bbox(loc["lon"], loc["lat"], platform)

        # GSD based on platform
        if platform == "satellite":
            gsd = round(random.uniform(0.3, 5.0), 2)
        elif platform == "uav":
            gsd = round(random.uniform(0.02, 0.15), 2)
        else:
            gsd = round(random.uniform(0.1, 1.0), 2)

        # Image dimensions
        if platform == "uav":
            width = random.choice([4000, 5472, 6000, 8000])
            height = random.choice([3000, 3648, 4000, 6000])
        else:
            width = random.choice([10000, 15000, 20000, 25000])
            height = random.choice([10000, 15000, 20000, 25000])

        file_size = width * height * 3 * random.uniform(0.3, 0.8)  # rough COG size

        image_id = str(uuid.uuid4())[:12]
        title = f"{loc['name']} {loc['country']} - {platform.capitalize()} {dt.strftime('%Y-%m-%d')}"

        records.append({
            "id": image_id,
            "title": title,
            "datetime": dt.isoformat() + "Z",
            "gsd": gsd,
            "platform_type": platform,
            "producer_name": producer,
            "license": license_type,
            "cog_href": f"{S3_BASE}/imagery/{image_id}.tif",
            "thumbnail_href": f"{S3_BASE}/thumbnails/{image_id}.webp",
            "file_size": int(file_size),
            "width": width,
            "height": height,
            "bands": 3 if platform != "satellite" else random.choice([3, 4]),
            "epsg": 3857,
            "uploaded_by": f"user-{random.randint(1000, 9999)}",
            "uploaded_at": (dt + timedelta(hours=random.randint(1, 48))).isoformat() + "Z",
            "geometry": box(west, south, east, north),
        })

    return records


def main():
    parser = argparse.ArgumentParser(description="Generate sample catalog.parquet")
    parser.add_argument("--output", "-o", default="catalog.parquet", help="Output file path")
    parser.add_argument("--count", "-n", type=int, default=50, help="Number of sample images")
    args = parser.parse_args()

    print(f"Generating {args.count} sample imagery records...")
    records = generate_sample_data(args.count)

    # Create GeoDataFrame
    gdf = gpd.GeoDataFrame(records, geometry="geometry", crs="EPSG:4326")

    # Sort by Hilbert curve for spatial locality (improves range request efficiency)
    try:
        gdf = gdf.sort_values("geometry", key=lambda col: col.hilbert_distance())
        print("  Sorted by Hilbert curve for spatial locality")
    except Exception:
        # Fallback: sort by datetime if hilbert not available
        gdf = gdf.sort_values("datetime", ascending=False)
        print("  Sorted by datetime (Hilbert sort not available)")

    # Write as GeoParquet v1.1 with bbox covering columns
    gdf.to_parquet(
        args.output,
        engine="pyarrow",
        write_covering_bbox=True,  # This creates bbox.xmin/xmax/ymin/ymax columns
        row_group_size=100,  # Small row groups = better predicate pushdown
    )

    file_size_kb = round(pd.io.common.file_exists(args.output) and
                         __import__("os").path.getsize(args.output) / 1024, 1)

    print(f"\nGenerated: {args.output}")
    print(f"  Records: {len(gdf)}")
    print(f"  File size: {file_size_kb} KB")
    print(f"  CRS: EPSG:4326")
    print(f"  Bbox covering columns: yes (bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax)")
    print(f"  Locations: {len(LOCATIONS)} cities")
    print(f"  Date range: {gdf['datetime'].min()[:10]} to {gdf['datetime'].max()[:10]}")


if __name__ == "__main__":
    main()
