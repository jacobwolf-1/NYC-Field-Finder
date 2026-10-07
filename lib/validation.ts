import { SPORT_CODES, type SportCode } from "./types.ts";

export const MAX_DAYS = 7;
export const DEFAULT_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in strict YYYY-MM-DD form (e.g. rejects 2026-13-40). */
export function isValidDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export type AvailabilityQuery = { sport: SportCode; date: string; days: number };

export type ParseResult =
  | { ok: true; value: AvailabilityQuery }
  | { ok: false; error: string };

export function parseAvailabilityQuery(input: {
  sport: string | null;
  date: string | null;
  days: string | null;
}): ParseResult {
  const { sport, date } = input;
  if (!sport || !date) {
    return { ok: false, error: "Missing required params: sport, date" };
  }
  if (!Object.hasOwn(SPORT_CODES, sport)) {
    return { ok: false, error: "Unknown sport code." };
  }
  const parsed = parseDateQuery(input);
  if (!parsed.ok) return parsed;
  const { days } = parsed.value;
  return { ok: true, value: { sport: sport as SportCode, date, days } };
}

function parseDateQuery(input: { date: string | null; days: string | null }):
  | { ok: true; value: { date: string; days: number } }
  | { ok: false; error: string } {
  const { date } = input;
  if (!date) return { ok: false, error: "Missing required param: date" };
  if (!isValidDateString(date)) {
    return { ok: false, error: "Invalid date. Expected YYYY-MM-DD." };
  }
  const days = Number(input.days ?? String(DEFAULT_DAYS));
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return {
      ok: false,
      error: `Invalid days value. Expected an integer between 1 and ${MAX_DAYS}.`,
    };
  }
  const end = new Date(date + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + days - 1);
  if (!isValidDateString(end.toISOString().slice(0, 10))) {
    return { ok: false, error: "Date range exceeds supported calendar dates." };
  }
  return { ok: true, value: { date, days } };
}

export function isValidSystemId(system: string): boolean {
  return /^[MBQXR][A-Za-z0-9]{3,9}(?:-[A-Za-z0-9+]+)+$/.test(system) && system.length <= 100;
}

export function parseFieldDetailQuery(input: {
  system: string | null; date: string | null; days: string | null;
}) {
  if (!input.system || !isValidSystemId(input.system)) {
    return { ok: false as const, error: "Invalid field system ID." };
  }
  const parsed = parseDateQuery(input);
  if (!parsed.ok) return parsed;
  return { ok: true as const, value: { ...parsed.value, system: input.system } };
}
