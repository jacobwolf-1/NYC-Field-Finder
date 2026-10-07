import { buildCatalog } from "../lib/field-catalog.ts";
import { buildParkNames } from "../lib/park-names.ts";

const force = process.argv.includes("--refresh");
try {
  console.log("Building field catalog (cached unless --refresh is passed)…");
  await buildCatalog({ force });
  try {
    await buildParkNames(force);
  } catch (error) {
    console.warn("Park names unavailable; boroughs and field names remain usable.", error.message);
  }
  const fields = Object.values(await buildCatalog());
  console.log(`${fields.length} fields; ${fields.filter((field) => field.park_name).length} matched park names. Ready for npm run dev.`);
} catch (error) {
  console.error("Catalog build failed:", error);
  process.exitCode = 1;
}
