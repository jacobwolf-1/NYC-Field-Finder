/** Original exploration CLI, updated to share the app's catalog and snapshots.
 * npm run poc -- SCR 2026-10-08 3 [SYSTEM_ID]
 * An optional field ID fetches detail for just that field.
 */
import { writeFileSync } from "node:fs";
import { buildCatalog } from "../lib/field-catalog.ts";
import { dateRange, getDailySnapshots, summarizeDay, getFieldDetail, normalizeFieldDetail, AVAILABILITY_NOTE } from "../lib/availability-client.ts";
import { parseAvailabilityQuery, isValidSystemId } from "../lib/validation.ts";

async function main() {
  const parsed = parseAvailabilityQuery({
    sport: process.argv[2] ?? "SCR",
    date: process.argv[3] ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    days: process.argv[4] ?? "3",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const { sport, date, days } = parsed.value;
  const catalog = await buildCatalog();
  const fields = Object.values(catalog).filter((field) => field.primary_sport === sport && field.permitable === "YES");
  const dates = dateRange(date, days);
  const snapshots = await getDailySnapshots(dates);
  const results = fields.map((field) => ({ field, days: dates.map((date, i) => summarizeDay(field.system, date, snapshots[i])) }));
  console.log(`${fields.length} ${sport} fields; ${dates[0]} through ${dates.at(-1)}.`);
  console.log(AVAILABILITY_NOTE);
  const system = process.argv[5];
  let detail;
  if (system) {
    if (!isValidSystemId(system) || !catalog[system]) throw new Error("Unknown field system ID");
    detail = normalizeFieldDetail(catalog[system], await getFieldDetail(system, date), dates);
    console.log(`${system}: ${detail.days.reduce((count, day) => count + day.reservedSlots.length, 0)} reserved slots returned.`);
  }
  writeFileSync("data/cache/poc_results.json", JSON.stringify({ results, detail }, null, 2));
  console.log("Saved data/cache/poc_results.json. Pass a field ID to inspect its slots.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
