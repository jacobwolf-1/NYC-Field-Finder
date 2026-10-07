import { type NextRequest } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { buildCatalog } from "@/lib/field-catalog";
import { getDailySnapshots, summarizeDay, dateRange, AVAILABILITY_NOTE } from "@/lib/availability-client";
import { boroughForSystem, type DayStatus } from "@/lib/types";
import { parseAvailabilityQuery } from "@/lib/validation";

export const dynamic = "force-dynamic";

// Max fields to return so the table stays usable
const MAX_ROWS = 200;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = parseAvailabilityQuery({
    sport: searchParams.get("sport"),
    date: searchParams.get("date"),
    days: searchParams.get("days"),
  });
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { sport, date, days } = parsed.value;

  // Catalog construction is an explicit setup step.
  const catalogPath = path.resolve(process.cwd(), "data/cache/fields_catalog.json");
  if (!existsSync(catalogPath)) {
    return Response.json(
      {
        error: "Field catalog not built yet. Run: npm run catalog",
        hint: "This builds the tile catalog. Subsequent runs reuse the disk cache.",
      },
      { status: 503 }
    );
  }

  try {
    const catalog = await buildCatalog(); // loads from disk cache
    const sportFields = Object.values(catalog).filter(
      (f) => f.primary_sport === sport && f.permitable === "YES"
    );

    if (sportFields.length === 0) {
      return Response.json({ error: `No fields found for sport "${sport}"` }, { status: 404 });
    }

    const dates = dateRange(date, days);

    const snapshots = await getDailySnapshots(dates);

    type Row = {
      system: string;
      name: string;
      surface_type: string;
      close_at_dusk: string;
      opening_time: string;
      permit_parent: string;
      borough: string;
      park_name?: string;
      closing_time: string;
      days: DayStatus[];
      freeDayCount: number;
    };

    const rows: Row[] = sportFields.map((f) => {
      const days = dates.map((date, i) => summarizeDay(f.system, date, snapshots[i]));
      return {
        system: f.system,
        borough: boroughForSystem(f.system),
        park_name: f.park_name,
        closing_time: f.closing_time,
        name: f.name,
        surface_type: f.surface_type,
        close_at_dusk: f.close_at_dusk,
        opening_time: f.opening_time,
        permit_parent: f.permit_parent,
        days,
        freeDayCount: days.filter((d) => d.status === "free").length,
      };
    });

    // Prioritize fields with a mix of booked and free samples.
    // This ensures real reservations are visible and not cut off by the cap.
    function sortKey(r: Row): number {
      const busyDays = r.days.length - r.freeDayCount;
      if (r.days.some((d) => d.status === "partial") || (busyDays > 0 && r.freeDayCount > 0)) return 0;
      if (busyDays > 0) return 1;
      return 2;
    }
    rows.sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka !== kb ? ka - kb : a.system.localeCompare(b.system);
    });

    const total = rows.length;
    const limited = rows.slice(0, MAX_ROWS);

    return Response.json({
      sport,
      dates,
      total,
      shown: limited.length,
      fields: limited,
      note: AVAILABILITY_NOTE,
    });
  } catch (err) {
    console.error("[availability]", err);
    return Response.json({ error: "Unable to load availability. Please try again." }, { status: 500 });
  }
}
