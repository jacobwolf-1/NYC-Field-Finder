/**
 * Builds and caches a catalog of all permittable athletic fields in NYC.
 *
 * Source: vector tiles at maps.nycgovparks.org/athletic_facility/{z}/{x}/{y}
 * These are the same tiles the permit map renders — the data is authoritative
 * and comes from the public permit workflow, not from Open Data datasets.
 *
 * The catalog is written to data/cache/fields_catalog.json on first run
 * and reused until explicitly refreshed.
 */

import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";

import { gunzipSync } from "zlib";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import type { FieldRecord } from "./types.ts";

import { USER_AGENT } from "./data-access.ts";
import { cachedParkNames } from "./park-names.ts";

const TILE_BASE = "https://maps.nycgovparks.org/athletic_facility";
const ZOOM = 13;
// Tiles covering all five NYC boroughs at zoom 13
function lonToX(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToY(lat: number, z: number) {
  const r = Math.PI / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(lat * r) + 1 / Math.cos(lat * r)) / Math.PI) / 2) *
      2 ** z
  );
}

const NYC = { minLon: -74.26, maxLon: -73.7, minLat: 40.49, maxLat: 40.92 };
const X_RANGE = { min: lonToX(NYC.minLon, ZOOM), max: lonToX(NYC.maxLon, ZOOM) };
const Y_RANGE = { min: latToY(NYC.maxLat, ZOOM), max: latToY(NYC.minLat, ZOOM) };

async function fetchTile(z: number, x: number, y: number): Promise<FieldRecord[]> {
  const url = `${TILE_BASE}/${z}/${x}/${y}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Referer: "https://www.nycgovparks.org/" },
    });
  } catch {
    return [];
  }
  if (!resp.ok) return [];

  const raw = Buffer.from(await resp.arrayBuffer());
  if (raw.length < 10) return [];

  // Tiles may be gzip-compressed depending on request headers
  let data = raw;
  if (raw[0] === 0x1f && raw[1] === 0x8b) data = gunzipSync(raw);

  try {
    const tile = new VectorTile(new Pbf(new Uint8Array(data)));
    const layer =
      tile.layers["athletic_facility_permitable"] ??
      tile.layers["athletic_facility"];
    if (!layer) return [];

    const out: FieldRecord[] = [];
    for (let i = 0; i < layer.length; i++) {
      const props = layer.feature(i).properties as unknown as FieldRecord;
      if (props?.system) out.push(props);
    }
    return out;
  } catch {
    return [];
  }
}

function catalogPath(): string {
  const root = path.resolve(process.cwd(), "data/cache");
  mkdirSync(root, { recursive: true });
  return path.join(root, "fields_catalog.json");
}

export async function buildCatalog(opts?: {
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<Record<string, FieldRecord>> {
  const cachePath = catalogPath();
  if (!opts?.force && existsSync(cachePath)) {
    const raw = readFileSync(cachePath, "utf8");
    return withParkNames(JSON.parse(raw) as Record<string, FieldRecord>);
  }

  const fields: Record<string, FieldRecord> = {};
  const tiles: [number, number][] = [];
  for (let x = X_RANGE.min; x <= X_RANGE.max; x++) {
    for (let y = Y_RANGE.min; y <= Y_RANGE.max; y++) {
      tiles.push([x, y]);
    }
  }

  const BATCH = 5;
  for (let i = 0; i < tiles.length; i += BATCH) {
    const batch = tiles.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(([x, y]) => fetchTile(ZOOM, x, y))
    );
    results.flat().forEach((f) => {
      if (!fields[f.system]) fields[f.system] = f;
    });
    opts?.onProgress?.(Math.min(i + BATCH, tiles.length), tiles.length);
    if (i + BATCH < tiles.length) await new Promise((r) => setTimeout(r, 200));
  }

  if (!Object.keys(fields).length) throw new Error("No fields returned; catalog was not replaced");
  writeFileSync(cachePath, JSON.stringify(fields, null, 2));
  return withParkNames(fields);
}

function withParkNames(fields: Record<string, FieldRecord>): Record<string, FieldRecord> {
  const names = cachedParkNames();
  return Object.fromEntries(Object.entries(fields).map(([system, field]) =>
    [system, { ...field, park_name: names[field.gispropnum] }]
  ));
}
