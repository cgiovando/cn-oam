"""Upload auth Lambda: validates API key and returns presigned S3 PUT URL."""

import json
import os
import uuid

import boto3

s3 = boto3.client("s3")
BUCKET = os.environ["S3_BUCKET"]
API_KEY = os.environ["UPLOAD_API_KEY"]
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json",
}


def lambda_handler(event, context):
    # Handle CORS preflight
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": CORS_HEADERS, "body": ""}

    # Validate API key
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if headers.get("x-api-key") != API_KEY:
        return {
            "statusCode": 401,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Invalid or missing API key"}),
        }

    # Parse metadata from query params
    params = event.get("queryStringParameters") or {}
    title = params.get("title", "Untitled")
    platform = params.get("platform", "")
    license_str = params.get("license", "CC-BY 4.0")

    upload_id = str(uuid.uuid4())
    staging_key = f"staging/{upload_id}/image.tif"

    # Store upload metadata
    meta = {
        "upload_id": upload_id,
        "title": title,
        "platform": platform,
        "license": license_str,
    }
    s3.put_object(
        Bucket=BUCKET,
        Key=f"staging/{upload_id}/meta.json",
        Body=json.dumps(meta),
        ContentType="application/json",
    )

    # Generate presigned PUT URL (1 hour expiry, 500MB max)
    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": BUCKET,
            "Key": staging_key,
            "ContentType": "image/tiff",
        },
        ExpiresIn=3600,
    )

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(
            {
                "upload_id": upload_id,
                "presigned_url": presigned_url,
                "expires_in": 3600,
            }
        ),
    }
