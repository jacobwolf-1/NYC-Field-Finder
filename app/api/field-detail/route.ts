import { type NextRequest } from "next/server";
import { getFieldDetail, dateRange } from "@/lib/availability-client";
import { normalizeFieldDetail } from "@/lib/availability-client";
import { parseFieldDetailQuery } from "@/lib/validation";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const parsed = parseFieldDetailQuery({
    system: searchParams.get("system"),
    date: searchParams.get("date"),
    days: searchParams.get("days"),
  });
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { system, date, days } = parsed.value;

  try {
    const detail = await getFieldDetail(system, date);
    const dates = dateRange(date, days);

    const normalized = normalizeFieldDetail({ system, name: detail.fieldName }, detail, dates);

    // Serialize each day's slots with a human-readable time
    const result = normalized.days.map((day) => ({
      date: day.date,
      isAvailable: day.isAvailable,
      closingTime: day.closingTime,
      reservedSlots: day.reservedSlots.map((s) => ({
        time: new Date(s.unix * 1000).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York",
        }),
        unix: s.unix,
        is_issued: s.is_issued,
        permit_holder: s.permit_holder,
        permit_type: s.permit_type,
        num_pending_permits: s.num_pending_permits,
      })),
    }));

    return Response.json({ system, fieldName: detail.fieldName, days: result });
  } catch (err) {
    console.error("[field-detail]", err);
    return Response.json({ error: "Unable to load field detail. Please try again." }, { status: 500 });
  }
}
