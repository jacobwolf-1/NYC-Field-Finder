// Sport codes used by the NYC Parks permit system
export const SPORT_CODES = {
  SCR: "Soccer",
  BSB: "Baseball",
  SFB: "Softball",
  BKB: "Basketball",
  TRK: "Track and Field",
  FTB: "Football",
  HDB: "Handball",
  HKY: "Hockey",
  VLB: "Volleyball",
  CRK: "Cricket",
  BOC: "Bocce",
  NTB: "Netball",
  RBY: "Rugby",
  MPPA: "Multi-purpose Play Area",
  TNS: "Tennis",
} as const;

export type SportCode = keyof typeof SPORT_CODES;

export interface FieldRecord {
  system: string;       // "M071-18-SOCCER-1" — the key used in all API calls
  name: string;         // "101st St-Soccer-04 C"
  primary_sport: string;
  sports: string;       // encoded multi-sport values; filter by primary_sport
  surface_type: string; // "Grass", "Asphalt", "Turf", etc.
  close_at_dusk: string; // "TRUE" | "FALSE"
  gispropnum: string;
  park_name?: string;
  closing_time: string;
  opening_time: string; // "8:00 AM"
  permit_parent: string; // park GIS ID e.g. "M071"
  permitable: string;   // "YES" | "NO"
}

// One time-slot entry from /api/athletic-fields?location=...&date=...
export interface PermitSlot {
  unix: number;
  in_season: boolean;
  permit_is_for_overlapping_field: boolean;
  num_pending_permits: number;
  permit_number: number | null;
  is_issued: boolean;
  permit_holder: string | null;
  permit_type: string | null;
}

// Per-field weekly detail response
export interface FieldDetailResponse {
  fieldName: string;
  // keys are unix timestamp strings, values are slot info
  availability: Record<string, Omit<PermitSlot, "unix">>;
  // keys are ISO date strings, values are closing time "HH:MM"
  close: Record<string, string>;
}

// Bulk datetime response — just reserved IDs
export interface DatetimeAvailabilityResponse {
  dusk: string;
  l: string[]; // system IDs that are reserved at this datetime
}

// Normalized availability result for a single field on a single date
export interface DayAvailability {
  date: string;        // "2026-04-22"
  isAvailable: boolean; // true = no in-season issued/pending slots returned
  reservedSlots: PermitSlot[];
  closingTime: string;   // "20:15"
}

// Normalized per-field result across a date range
export interface FieldAvailability {
  field: Pick<FieldRecord, "system" | "name">;
  days: DayAvailability[];
}

export type BookingStatus = "free" | "partial" | "busy";
export type DayPeriod = "Morning" | "Afternoon" | "Evening";
export interface DayStatus {
  date: string;
  status: BookingStatus;
  bookedPeriods: DayPeriod[];
  bookedTimes: string[];
}

export function boroughForSystem(system: string): string {
  const boroughs: Record<string, string> = {
    M: "Manhattan", B: "Brooklyn", Q: "Queens", X: "Bronx", R: "Staten Island",
  };
  return boroughs[system[0]] ?? "Unknown";
}
