"""Process-image Lambda: converts uploaded TIF to COG, generates thumbnail,
extracts metadata, and writes sidecar parquet for catalog merge."""

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
import geopandas as gpd
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import rasterio
from PIL import Image
from rasterio.warp import transform_bounds
from shapely.geometry import box

s3 = boto3.client("s3")
BUCKET = os.environ["S3_BUCKET"]


def lambda_handler(event, context):
    """Triggered by S3 event when staging/{upload_id}/image.tif is created."""
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = record["s3"]["object"]["key"]

    # Extract upload_id from key: staging/{upload_id}/image.tif
    parts = key.split("/")
    if len(parts) < 3:
        raise ValueError(f"Unexpected key format: {key}")
    upload_id = parts[1]

    print(f"Processing upload {upload_id} from {bucket}/{key}")

    status_key = f"uploads/{upload_id}/status.json"

    def _write_status(step, **extra):
        """Write intermediate status to S3 so the frontend can show progress."""
        body = {"status": "processing", "upload_id": upload_id, "step": step, **extra}
        s3.put_object(Bucket=BUCKET, Key=status_key,
                      Body=json.dumps(body), ContentType="application/json")

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            src_path = tmp / "source.tif"
            cog_path = tmp / "output.cog.tif"
            thumb_path = tmp / "thumbnail.webp"
            parquet_path = tmp / "sidecar.parquet"

            # 1. Download staging TIF
            _write_status("downloading")
            print("Downloading source image...")
            s3.download_file(bucket, key, str(src_path))

            # 2. Read user metadata
            meta = _read_meta(bucket, upload_id)

            # 3. Validate source image
            _write_status("validating")
            src_info = _validate_image(src_path)

            # 4. Convert to COG (EPSG:3857, 256x256 blocks, deflate, web-optimized)
            _write_status("converting")
            print("Converting to COG...")
            _convert_to_cog(src_path, cog_path)

            # 5. Read COG metadata
            cog_info = _read_cog_info(cog_path)

            # 6. Generate thumbnail
            _write_status("thumbnail")
            print("Generating thumbnail...")
            _generate_thumbnail(cog_path, thumb_path)

            # 7. Upload COG, thumbnail
            _write_status("uploading")
            cog_key = f"imagery/{upload_id}.tif"
            thumb_key = f"thumbnails/{upload_id}.webp"

            print("Uploading COG...")
            s3.upload_file(
                str(cog_path), BUCKET, cog_key,
                ExtraArgs={"ContentType": "image/tiff"},
            )
            print("Uploading thumbnail...")
            s3.upload_file(
                str(thumb_path), BUCKET, thumb_key,
                ExtraArgs={"ContentType": "image/webp"},
            )

            # 8. Write sidecar parquet
            _write_status("cataloging")
            print("Writing sidecar parquet...")
            _write_sidecar(parquet_path, upload_id, meta, cog_info)
            s3.upload_file(
                str(parquet_path), BUCKET,
                f"catalog/pending/{upload_id}.parquet",
                ExtraArgs={"ContentType": "application/octet-stream"},
            )

            # 9. Write final status JSON
            cog_url = f"https://{BUCKET}.s3.amazonaws.com/{cog_key}"
            thumb_url = f"https://{BUCKET}.s3.amazonaws.com/{thumb_key}"
            status = {
                "status": "complete",
                "step": "done",
                "upload_id": upload_id,
                "cog_url": cog_url,
                "thumbnail_url": thumb_url,
                "title": meta.get("title", ""),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }
            s3.put_object(
                Bucket=BUCKET, Key=status_key,
                Body=json.dumps(status), ContentType="application/json",
            )

            # 10. Cleanup staging files
            print("Cleaning up staging files...")
            _delete_staging(bucket, upload_id)

            print(f"Done! COG: {cog_url}, Thumbnail: {thumb_url}")
            return {"statusCode": 200, "body": json.dumps(status)}

    except Exception as e:
        # Write error status so the frontend can show the failure
        error_status = {
            "status": "error",
            "upload_id": upload_id,
            "error": str(e),
        }
        s3.put_object(Bucket=BUCKET, Key=status_key,
                      Body=json.dumps(error_status), ContentType="application/json")
        raise


def _read_meta(bucket, upload_id):
    """Read upload metadata from staging/{upload_id}/meta.json."""
    try:
        resp = s3.get_object(Bucket=bucket, Key=f"staging/{upload_id}/meta.json")
        return json.loads(resp["Body"].read())
    except Exception:
        return {}


def _validate_image(path):
    """Basic validation of the source image."""
    with rasterio.open(path) as src:
        if src.count == 0:
            raise ValueError("Image has no bands")
        if src.width < 10 or src.height < 10:
            raise ValueError(f"Image too small: {src.width}x{src.height}")
        file_size = os.path.getsize(path)
        if file_size > 500 * 1024 * 1024:
            raise ValueError(f"File too large: {file_size / 1024 / 1024:.0f}MB (max 500MB)")
        return {
            "crs": str(src.crs),
            "width": src.width,
            "height": src.height,
            "bounds": src.bounds,
            "bands": src.count,
        }


def _convert_to_cog(src_path, cog_path):
    """Convert source TIF to web-optimized COG in EPSG:3857.

    --web-optimized implies reprojection to EPSG:3857 and 256x256 tiles.
    --add-mask creates an internal mask band so areas outside the footprint
    are transparent instead of black after reprojection.
    """
    cmd = [
        "rio", "cogeo", "create",
        str(src_path), str(cog_path),
        "--cog-profile", "deflate",
        "--web-optimized",
        "--add-mask",
        "--blocksize", "256",
        "--overview-resampling", "nearest",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"COG conversion failed: {result.stderr}")
    if not cog_path.exists():
        raise RuntimeError("COG output file not created")


def _read_cog_info(cog_path):
    """Read metadata from the generated COG."""
    with rasterio.open(cog_path) as src:
        # Get bounds in EPSG:4326
        bounds_4326 = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        # Compute GSD (ground sample distance) in meters
        res_x = src.res[0]
        gsd = round(res_x, 4)
        return {
            "crs": str(src.crs),
            "width": src.width,
            "height": src.height,
            "bands": src.count,
            "bounds_4326": bounds_4326,
            "gsd": gsd,
            "file_size": os.path.getsize(cog_path),
        }


def _generate_thumbnail(cog_path, thumb_path, max_size=512):
    """Generate a WebP thumbnail from the COG, preserving mask transparency."""
    with rasterio.open(cog_path) as src:
        # Read at reduced resolution using overview
        out_shape = (src.count, max_size, max_size)
        data = src.read(out_shape=out_shape)

        # Read internal mask (from --add-mask) if available
        try:
            mask = src.read_masks(1, out_shape=(max_size, max_size))
            has_mask = not np.all(mask == 255)
        except Exception:
            mask = None
            has_mask = False

        # Handle different band counts
        if src.count >= 3:
            rgb = np.moveaxis(data[:3], 0, -1)
        elif src.count == 1:
            rgb = np.stack([data[0]] * 3, axis=-1)
        else:
            rgb = np.moveaxis(data[:3], 0, -1) if src.count >= 3 else np.stack([data[0]] * 3, axis=-1)

        # Normalize to 0-255 if needed
        if rgb.dtype != np.uint8:
            vmin, vmax = np.percentile(rgb[rgb > 0], [2, 98]) if np.any(rgb > 0) else (0, 1)
            if vmax > vmin:
                rgb = np.clip((rgb.astype(float) - vmin) / (vmax - vmin) * 255, 0, 255).astype(np.uint8)
            else:
                rgb = np.zeros_like(rgb, dtype=np.uint8)

    if has_mask and mask is not None:
        rgba = np.dstack([rgb, mask])
        img = Image.fromarray(rgba, mode="RGBA")
    else:
        img = Image.fromarray(rgb)
    img.save(str(thumb_path), "WEBP", quality=80)


def _write_sidecar(parquet_path, upload_id, meta, cog_info):
    """Write a 1-row GeoParquet sidecar matching existing catalog schema.

    Schema: id, title, datetime, gsd, platform_type, producer_name, license,
    cog_href, thumbnail_href, file_size, width, height, bands, epsg,
    uploaded_by, uploaded_at, geometry, bbox
    """
    bbox = cog_info["bounds_4326"]  # (minx, miny, maxx, maxy)
    geometry = box(*bbox)
    now = datetime.now(timezone.utc).isoformat()

    gdf = gpd.GeoDataFrame(
        [{
            "id": upload_id,
            "title": meta.get("title", "Untitled"),
            "datetime": meta.get("acquired", now[:10]),
            "gsd": cog_info["gsd"],
            "platform_type": meta.get("platform", ""),
            "producer_name": meta.get("provider", ""),
            "license": meta.get("license", "CC-BY 4.0"),
            "cog_href": f"https://{BUCKET}.s3.amazonaws.com/imagery/{upload_id}.tif",
            "thumbnail_href": f"https://{BUCKET}.s3.amazonaws.com/thumbnails/{upload_id}.webp",
            "file_size": cog_info["file_size"],
            "width": cog_info["width"],
            "height": cog_info["height"],
            "bands": cog_info["bands"],
            "epsg": 3857,
            "uploaded_by": "",
            "uploaded_at": now,
        }],
        geometry=[geometry],
        crs="EPSG:4326",
    )

    gdf.to_parquet(str(parquet_path), index=False)


def _delete_staging(bucket, upload_id):
    """Remove staging files after processing."""
    prefix = f"staging/{upload_id}/"
    resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    if "Contents" in resp:
        objects = [{"Key": obj["Key"]} for obj in resp["Contents"]]
        s3.delete_objects(Bucket=bucket, Delete={"Objects": objects})
