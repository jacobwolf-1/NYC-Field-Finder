import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { USER_AGENT } from "./data-access.ts";

// NYC Parks Properties: exact GIS property identifiers, not fuzzy park names.
export const PARKS_URL = "https://data.cityofnewyork.us/resource/enfh-gkve.json?$select=gispropnum,name311&$limit=5000";
type ParkProperty = { gispropnum: string; name311?: string };

export function indexParkNames(rows: ParkProperty[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const row of rows) {
    if (!row.gispropnum || !row.name311) continue;
    if (names[row.gispropnum] && names[row.gispropnum] !== row.name311) {
      throw new Error(`Ambiguous park property: ${row.gispropnum}`);
    }
    names[row.gispropnum] = row.name311;
  }
  return names;
}

function cachePath() { return path.resolve(process.cwd(), "data/cache/park_names.json"); }

export function cachedParkNames(): Record<string, string> {
  return existsSync(cachePath()) ? JSON.parse(readFileSync(cachePath(), "utf8")) : {};
}

export async function buildParkNames(force = false): Promise<Record<string, string>> {
  if (!force && existsSync(cachePath())) return cachedParkNames();
  const response = await fetch(PARKS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`Park properties HTTP ${response.status}`);
  const rows: ParkProperty[] = await response.json();
  if (rows.length === 0 || rows.length >= 5000) throw new Error("Empty or truncated parks dataset");
  const names = indexParkNames(rows);
  mkdirSync(path.dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(names, null, 2));
  return names;
}
