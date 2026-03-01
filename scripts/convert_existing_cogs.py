"""One-time script to convert existing OAM images to web-optimized COGs.

Downloads each image from oin-hotosm-temp, converts to COG (EPSG:3857,
256x256 blocks, deflate, web-optimized, with mask for transparency),
uploads to cn-oam S3 bucket, and updates catalog cog_href entries.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3
import duckdb
import requests

S3_BUCKET = "cn-oam"
CATALOG_LOCAL = "frontend/public/catalog.parquet"

s3 = boto3.client("s3")


def get_oam_images():
    """Get images that still point to oin-hotosm-temp."""
    con = duckdb.connect()
    rows = con.execute(f"""
        SELECT id, cog_href FROM read_parquet('{CATALOG_LOCAL}')
        WHERE cog_href LIKE '%oin-hotosm%'
    """).fetchall()
    con.close()
    return rows


def download_image(url, dest_path):
    """Download an image from URL with progress."""
    resp = requests.get(url, stream=True)
    resp.raise_for_status()
    total = int(resp.headers.get("content-length", 0))
    downloaded = 0
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded * 100 // total
                print(f"\r  Downloading: {pct}% ({downloaded // 1048576}MB/{total // 1048576}MB)", end="", flush=True)
    print()


def convert_to_cog(src_path, cog_path):
    """Convert to web-optimized COG with mask."""
    cmd = [
        "rio", "cogeo", "create",
        str(src_path), str(cog_path),
        "--cog-profile", "deflate",
        "--web-optimized",
        "--add-mask",
        "--blocksize", "256",
        "--overview-resampling", "nearest",
    ]
    print(f"  Converting: {' '.join(cmd[-8:])}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr}")
        return False
    return True


def upload_cog(cog_path, image_id):
    """Upload COG to S3."""
    key = f"imagery/{image_id}.tif"
    file_size = os.path.getsize(cog_path)
    print(f"  Uploading: {key} ({file_size // 1048576}MB)")
    s3.upload_file(
        str(cog_path), S3_BUCKET, key,
        ExtraArgs={"ContentType": "image/tiff"},
    )
    return f"https://{S3_BUCKET}.s3.amazonaws.com/{key}"


def main():
    images = get_oam_images()
    print(f"Found {len(images)} images to convert\n")

    results = {}

    for i, (image_id, cog_href) in enumerate(images):
        print(f"[{i + 1}/{len(images)}] {image_id}")

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            src_path = tmp / "source.tif"
            cog_path = tmp / "output.cog.tif"

            # Download
            try:
                download_image(cog_href, src_path)
            except Exception as e:
                print(f"  SKIP (download failed): {e}\n")
                continue

            # Convert
            if not convert_to_cog(src_path, cog_path):
                print(f"  SKIP (conversion failed)\n")
                continue

            # Upload
            new_url = upload_cog(cog_path, image_id)
            results[image_id] = new_url
            print(f"  Done: {new_url}\n")

    # Update catalog
    if results:
        print(f"\nUpdating catalog ({len(results)} images)...")
        con = duckdb.connect()
        con.execute(f"CREATE TABLE catalog AS SELECT * FROM read_parquet('{CATALOG_LOCAL}')")

        for image_id, new_url in results.items():
            con.execute(
                "UPDATE catalog SET cog_href = ? WHERE id = ?",
                [new_url, image_id],
            )

        con.execute(f"""
            COPY (SELECT * FROM catalog ORDER BY id)
            TO '{CATALOG_LOCAL}'
            (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
        """)
        con.close()

        # Also upload updated catalog to S3
        print("Uploading updated catalog.parquet to S3...")
        s3.upload_file(
            CATALOG_LOCAL, S3_BUCKET, "catalog.parquet",
            ExtraArgs={"ContentType": "application/octet-stream"},
        )
        print("Done!")
    else:
        print("No images converted.")


if __name__ == "__main__":
    main()
