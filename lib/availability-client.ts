/**
 * Client for the two public NYC Parks availability endpoints.
 *
 * Endpoint 1 — bulk datetime snapshot:
 *   GET /api/athletic-fields?datetime=YYYY-MM-DD+H:mm
 *   Returns { dusk: "HH:MM", l: ["SYSTEM-ID", ...] }
 *   `l` is the complete list of reserved/unavailable field IDs at that moment.
 *   All fields NOT in `l` are available at that datetime.
 *
 * Endpoint 2 — per-field weekly detail:
 *   GET /api/athletic-fields?location=SYSTEM-ID&date=YYYY-MM-DD
 *   Returns per-slot permit information for a 7-day window starting at `date`.
 *
 * Both endpoints work with plain HTTP GET — no session, auth, or cookies needed.
 * Rate limit: unknown; we add a small delay between date requests.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import type {
  DatetimeAvailabilityResponse,
  FieldDetailResponse,
  FieldRecord,
  FieldAvailability,
  DayAvailability,
  PermitSlot,
} from "./types.ts";
import type { DayStatus, DayPeriod } from "./types.ts";
import { isValidDateString, isValidSystemId } from "./validation.ts";
import { USER_AGENT, politeRequest } from "./data-access.ts";

const BASE = "https://www.nycgovparks.org";
export const SNAPSHOTS = [
  { time: "09:00", period: "Morning" },
  { time: "12:00", period: "Afternoon" },
  { time: "15:00", period: "Afternoon" },
  { time: "18:00", period: "Evening" },
] as const;

export const AVAILABILITY_NOTE = "Sampled at 09:00, 12:00, 15:00 and 18:00 New York time. Free = none booked; Partly booked = some; Busy = all four. Period labels identify booked samples, not continuous bookings. Reservations between checks can be missed; expand a field for slot detail.";

function cacheDir(): string {
  const dir = path.resolve(process.cwd(), "data/cache/availability");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fieldDetailCachePath(systemId: string, date: string): string {
  const dir = path.join(cacheDir(), "fields");
  mkdirSync(dir, { recursive: true });
  const safe = systemId.replace(/[^a-zA-Z0-9-]/g, "_");
  return path.join(dir, `${safe}_${date}.json`);
}

async function get<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://www.nycgovparks.org/permits/field-and-court/map",
      Accept: "application/json",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json() as Promise<T>;
}

/**
 * Returns the list of reserved field system IDs at a given date + time.
 * Results are cached to disk; the cache is considered fresh for 15 minutes.
 */
export async function getReservedIds(
  date: string,
  time: string = SNAPSHOTS[0].time,
  opts?: { maxAgeMs?: number }
): Promise<DatetimeAvailabilityResponse> {
  if (!isValidDateString(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("Invalid snapshot date or time");
  }
  const cacheKey = `${date}_${time.replace(":", "-")}`;
  const cachePath = path.join(cacheDir(), `snapshot_${cacheKey}.json`);
  const maxAge = opts?.maxAgeMs ?? 15 * 60 * 1000;

  return cachedJson<DatetimeAvailabilityResponse>(cachePath, maxAge,
    `${BASE}/api/athletic-fields?datetime=${date}+${time}`);
}

/**
 * Returns full per-slot permit detail for a field over a 7-day window.
 * Cache: 30 minutes (availability can change as permits are issued).
 */
export async function getFieldDetail(
  systemId: string,
  date: string,
  opts?: { maxAgeMs?: number }
): Promise<FieldDetailResponse> {
  if (!isValidSystemId(systemId) || !isValidDateString(date)) {
    throw new Error("Invalid field system ID or date");
  }
  const cachePath = fieldDetailCachePath(systemId, date);
  const maxAge = opts?.maxAgeMs ?? 30 * 60 * 1000;

  return cachedJson<FieldDetailResponse>(cachePath, maxAge,
    `${BASE}/api/athletic-fields?location=${encodeURIComponent(systemId)}&date=${date}`);
}

/**
 * Normalizes a FieldDetailResponse into per-day availability summary.
 *
 * The API returns a flat map of unix-timestamp → slot info. We group by date
 * and compute: the in-season issued/pending slots returned for each New York calendar date.
 */
export function normalizeFieldDetail(
  field: Pick<FieldRecord, "system" | "name">,
  detail: FieldDetailResponse,
  dateRange: string[]
): FieldAvailability {
  const days: DayAvailability[] = dateRange.map((date) => {
    const closingTime = detail.close?.[date] ?? "Unknown";
    const reservedSlots: PermitSlot[] = [];

    for (const [unixStr, slot] of Object.entries(detail.availability)) {
      const unix = Number(unixStr);
      const slotDate = new Date(unix * 1000)
        .toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      if (slotDate !== date) continue;
      if (slot.in_season && (slot.is_issued || slot.num_pending_permits > 0)) {
        reservedSlots.push({ unix, ...slot });
      }
    }

    return {
      date,
      isAvailable: reservedSlots.length === 0,
      reservedSlots: reservedSlots.sort((a, b) => a.unix - b.unix),
      closingTime,
    };
  });

  return { field, days };
}

const inFlight = new Map<string, Promise<unknown>>();

async function cachedJson<T>(cachePath: string, maxAge: number, url: string): Promise<T> {
  if (existsSync(cachePath)) {
    const { ts, data } = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Date.now() - ts < maxAge) return data as T;
  }
  const existing = inFlight.get(cachePath);
  if (existing) return existing as Promise<T>;
  const request = politeRequest(async () => {
    const data = await get<T>(url);
    writeFileSync(cachePath, JSON.stringify({ ts: Date.now(), data }));
    return data;
  });
  inFlight.set(cachePath, request);
  try { return await request; }
  finally { inFlight.delete(cachePath); }
}

export async function getDailySnapshots(dates: string[]): Promise<Set<string>[][]> {
  const result: Set<string>[][] = [];
  for (const date of dates) {
    const samples: Set<string>[] = [];
    for (const { time } of SNAPSHOTS) {
      samples.push(new Set((await getReservedIds(date, time)).l));
    }
    result.push(samples);
  }
  return result;
}

export function summarizeDay(system: string, date: string, samples: Set<string>[]): DayStatus {
  if (samples.length !== SNAPSHOTS.length) throw new Error("Incomplete daily snapshots");
  const booked = SNAPSHOTS.filter((_, index) => samples[index].has(system));
  return {
    date,
    status: booked.length === 0 ? "free" : booked.length === SNAPSHOTS.length ? "busy" : "partial",
    bookedPeriods: [...new Set<DayPeriod>(booked.map((sample) => sample.period))],
    bookedTimes: booked.map((sample) => sample.time),
  };
}

/** Generate an array of YYYY-MM-DD strings for [startDate, startDate+days) */
export function dateRange(startDate: string, days: number): string[] {
  const out: string[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
