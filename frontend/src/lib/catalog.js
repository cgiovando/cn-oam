/**
 * Catalog search powered by DuckDB-WASM querying a remote GeoParquet file.
 *
 * The catalog.parquet file sits on S3 and contains all image metadata.
 * DuckDB-WASM reads it via HTTP range requests — only fetching the
 * Parquet footer + relevant row groups. No API server needed.
 */

import * as duckdb from '@duckdb/duckdb-wasm';

// Vite-specific: use ?url imports for WASM bundles
import duckdb_wasm_mvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// Configurable catalog URL — override via env var
// DuckDB-WASM workers need absolute URLs, so resolve relative paths
const rawUrl = import.meta.env.VITE_CATALOG_URL
  || 'https://cn-oam.s3.amazonaws.com/catalog.parquet';
const CATALOG_URL = rawUrl.startsWith('http')
  ? rawUrl
  : new URL(rawUrl, window.location.origin).href;

let db = null;
let conn = null;
let initPromise = null;

/**
 * Initialize DuckDB-WASM (singleton, called once).
 */
export async function initCatalog() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const bundle = await duckdb.selectBundle({
      mvp: {
        mainModule: duckdb_wasm_mvp,
        mainWorker: mvp_worker,
      },
      eh: {
        mainModule: duckdb_wasm_eh,
        mainWorker: eh_worker,
      },
    });

    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule);

    conn = await db.connect();

    // Enable httpfs for reading remote Parquet files
    try {
      await conn.query("SET enable_http_metadata_cache = true;");
    } catch (e) {
      // Older versions may not support this setting
    }

    console.log('[catalog] DuckDB-WASM initialized');
    return { db, conn };
  })();

  return initPromise;
}

/**
 * Search the catalog with spatial + property filters.
 *
 * @param {Object} params
 * @param {number[]} params.bbox - [west, south, east, north]
 * @param {string} params.dateStart - ISO date string
 * @param {string} params.dateEnd - ISO date string
 * @param {string} params.platform - platform_type filter
 * @param {string} params.license - license filter
 * @param {number} params.maxGsd - max ground sampling distance
 * @param {string} params.query - text search on title
 * @param {number} params.limit - max results (default 200)
 * @returns {Object[]} Array of feature objects
 */
export async function searchCatalog({
  bbox = null,
  dateStart = '',
  dateEnd = '',
  platform = '',
  license = '',
  maxGsd = null,
  query = '',
  limit = 200
} = {}) {
  if (!conn) await initCatalog();

  const conditions = [];
  const params = [];

  // Spatial filter using bbox covering columns (fast: uses row group statistics)
  if (bbox) {
    const [west, south, east, north] = bbox;
    conditions.push(`bbox.xmax >= ? AND bbox.xmin <= ? AND bbox.ymax >= ? AND bbox.ymin <= ?`);
    params.push(west, east, south, north);
  }

  // Temporal filter
  if (dateStart) {
    conditions.push(`datetime >= ?`);
    params.push(dateStart);
  }
  if (dateEnd) {
    conditions.push(`datetime <= ?`);
    params.push(dateEnd + 'T23:59:59.999Z');
  }

  // Platform filter
  if (platform) {
    if (platform === 'uav') {
      conditions.push(`(LOWER(platform_type) = 'uav' OR LOWER(platform_type) = 'drone')`);
    } else {
      conditions.push(`LOWER(platform_type) = ?`);
      params.push(platform.toLowerCase());
    }
  }

  // License filter
  if (license) {
    conditions.push(`LOWER(license) LIKE ?`);
    params.push(`%${license.toLowerCase()}%`);
  }

  // GSD filter
  if (maxGsd) {
    conditions.push(`gsd <= ?`);
    params.push(maxGsd);
  }

  // Text search
  if (query) {
    conditions.push(`LOWER(title) LIKE ?`);
    params.push(`%${query.toLowerCase()}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      id,
      title,
      datetime,
      gsd,
      platform_type,
      producer_name,
      license,
      cog_href,
      thumbnail_href,
      file_size,
      width,
      height,
      bands,
      epsg,
      uploaded_by,
      uploaded_at,
      bbox.xmin as bbox_west,
      bbox.ymin as bbox_south,
      bbox.xmax as bbox_east,
      bbox.ymax as bbox_north
    FROM read_parquet('${CATALOG_URL}')
    ${where}
    ORDER BY datetime DESC
    LIMIT ${limit}
  `;

  const stmt = await conn.prepare(sql);
  const result = await stmt.query(...params);
  await stmt.close();

  // Convert Arrow table to plain JS objects, then to GeoJSON features
  // Note: DuckDB-WASM returns BigInt for integer columns — convert to Number
  const rows = result.toArray().map(row => row.toJSON());
  const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

  return rows.map(row => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [row.bbox_west, row.bbox_south],
        [row.bbox_east, row.bbox_south],
        [row.bbox_east, row.bbox_north],
        [row.bbox_west, row.bbox_north],
        [row.bbox_west, row.bbox_south],
      ]]
    },
    properties: {
      id: row.id,
      title: row.title || 'Untitled Image',
      datetime: row.datetime,
      date: row.datetime,
      gsd: row.gsd,
      platform: row.platform_type || 'unknown',
      platform_type: row.platform_type,
      producer_name: row.producer_name || 'Unknown',
      provider: row.producer_name || 'Unknown',
      license: row.license || 'Unknown',
      cog_href: row.cog_href,
      thumbnail: row.thumbnail_href,
      thumbnail_href: row.thumbnail_href,
      file_size: num(row.file_size),
      width: num(row.width),
      height: num(row.height),
      bands: num(row.bands),
      epsg: num(row.epsg),
      uploaded_by: row.uploaded_by,
      uploaded_at: row.uploaded_at,
    }
  }));
}

/**
 * Get catalog statistics (total count, date range, etc.)
 */
export async function getCatalogStats() {
  if (!conn) await initCatalog();

  try {
    const result = await conn.query(`
      SELECT
        COUNT(*) as total_images,
        MIN(datetime) as earliest,
        MAX(datetime) as latest,
        COUNT(DISTINCT platform_type) as platform_count,
        SUM(file_size) as total_size_bytes
      FROM read_parquet('${CATALOG_URL}')
    `);

    const row = result.toArray()[0]?.toJSON();
    if (!row) return { totalImages: 0, earliest: null, latest: null, platformCount: 0, totalSizeBytes: 0 };
    return {
      totalImages: Number(row.total_images),
      earliest: row.earliest,
      latest: row.latest,
      platformCount: Number(row.platform_count),
      totalSizeBytes: Number(row.total_size_bytes),
    };
  } catch (e) {
    console.warn('[catalog] Stats query failed (catalog may not exist yet):', e.message);
    return { totalImages: 0, earliest: null, latest: null, platformCount: 0, totalSizeBytes: 0 };
  }
}

/**
 * Get a single item by ID.
 */
export async function getItem(id) {
  if (!conn) await initCatalog();

  const result = await conn.query(`
    SELECT * FROM read_parquet('${CATALOG_URL}')
    WHERE id = '${id}'
    LIMIT 1
  `);

  if (result.numRows === 0) return null;
  const row = result.get(0);
  return row;
}
