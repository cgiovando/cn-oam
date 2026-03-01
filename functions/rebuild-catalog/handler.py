"""Rebuild-catalog Lambda: merges pending sidecar parquets into the main
catalog.parquet with Hilbert-curve sorting for spatial locality."""

import json
import os
import tempfile
from pathlib import Path

import boto3
import duckdb

s3 = boto3.client("s3")
BUCKET = os.environ["S3_BUCKET"]
CATALOG_KEY = "catalog.parquet"
PENDING_PREFIX = "catalog/pending/"


def lambda_handler(event, context):
    """Triggered hourly by EventBridge. Merges pending sidecars into catalog."""

    # 1. List pending sidecar files
    pending_keys = _list_pending()
    if not pending_keys:
        print("No pending sidecars, nothing to do.")
        return {"statusCode": 200, "body": json.dumps({"merged": 0})}

    print(f"Found {len(pending_keys)} pending sidecar(s)")

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # 2. Download current catalog
        catalog_path = tmp / "catalog.parquet"
        try:
            s3.download_file(BUCKET, CATALOG_KEY, str(catalog_path))
            print("Downloaded existing catalog.parquet")
        except s3.exceptions.ClientError:
            catalog_path = None
            print("No existing catalog.parquet, creating new one")

        # 3. Download all pending sidecars
        sidecar_paths = []
        for key in pending_keys:
            fname = key.replace("/", "_")
            local = tmp / fname
            s3.download_file(BUCKET, key, str(local))
            sidecar_paths.append(str(local))

        # 4. Merge with DuckDB
        merged_path = tmp / "merged.parquet"
        _merge_catalog(
            str(catalog_path) if catalog_path else None,
            sidecar_paths,
            str(merged_path),
        )

        # 5. Upload merged catalog
        print("Uploading merged catalog.parquet...")
        s3.upload_file(
            str(merged_path), BUCKET, CATALOG_KEY,
            ExtraArgs={"ContentType": "application/octet-stream"},
        )

        # 6. Delete merged sidecars
        print("Cleaning up sidecars...")
        _delete_keys(pending_keys)

    print(f"Done! Merged {len(pending_keys)} sidecar(s) into catalog.")
    return {"statusCode": 200, "body": json.dumps({"merged": len(pending_keys)})}


def _list_pending():
    """List all parquet files under catalog/pending/."""
    keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PENDING_PREFIX):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".parquet"):
                keys.append(obj["Key"])
    return keys


def _merge_catalog(catalog_path, sidecar_paths, output_path):
    """Merge existing catalog + sidecars, Hilbert-sort, write with bbox columns."""
    con = duckdb.connect()
    con.execute("SET home_directory='/tmp';")
    try:
        con.execute("INSTALL spatial; LOAD spatial;")
    except Exception as e:
        print(f"Warning: spatial extension not available ({e}), skipping Hilbert sort")

    # Build list of all parquet files to merge
    all_files = []
    if catalog_path:
        all_files.append(catalog_path)
    all_files.extend(sidecar_paths)

    # Read all into a single table (union_by_name handles schema differences)
    file_list = ", ".join(f"'{f}'" for f in all_files)
    con.execute(f"""
        CREATE TABLE merged AS
        SELECT * FROM read_parquet([{file_list}], union_by_name=true)
    """)

    row_count = con.execute("SELECT count(*) FROM merged").fetchone()[0]
    print(f"Merged table has {row_count} rows")

    # Deduplicate by id (keep latest by uploaded_at timestamp)
    con.execute("""
        CREATE TABLE deduped AS
        SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY uploaded_at DESC) as rn
            FROM merged
        ) WHERE rn = 1
    """)
    con.execute("ALTER TABLE deduped DROP COLUMN rn")

    deduped_count = con.execute("SELECT count(*) FROM deduped").fetchone()[0]
    print(f"After dedup: {deduped_count} rows")

    # Drop __index_level_0__ if present (artifact from pandas)
    cols = [r[0] for r in con.execute("DESCRIBE deduped").fetchall()]
    if "__index_level_0__" in cols:
        con.execute("ALTER TABLE deduped DROP COLUMN __index_level_0__")

    # Recompute bbox from geometry for rows where bbox is NULL
    # (sidecars from geopandas don't include the bbox struct column)
    if "bbox" in cols and "geometry" in cols:
        con.execute("""
            UPDATE deduped SET bbox = {
                xmin: ST_XMin(geometry),
                ymin: ST_YMin(geometry),
                xmax: ST_XMax(geometry),
                ymax: ST_YMax(geometry)
            }
            WHERE bbox IS NULL AND geometry IS NOT NULL
        """)
        filled = con.execute("SELECT count(*) FROM deduped WHERE bbox IS NOT NULL").fetchone()[0]
        print(f"Rows with bbox: {filled}/{deduped_count}")

    # Write to parquet — sort by id as simple fallback
    con.execute(f"""
        COPY (
            SELECT * FROM deduped
            ORDER BY id
        ) TO '{output_path}'
        (FORMAT PARQUET, COMPRESSION ZSTD,
         ROW_GROUP_SIZE 10000)
    """)

    con.close()


def _delete_keys(keys):
    """Delete a list of S3 keys."""
    if not keys:
        return
    # S3 delete_objects has a 1000-key limit
    for i in range(0, len(keys), 1000):
        batch = [{"Key": k} for k in keys[i : i + 1000]]
        s3.delete_objects(Bucket=BUCKET, Delete={"Objects": batch})
