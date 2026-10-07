import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFieldDetailQuery, isValidSystemId } from "../lib/validation.ts";
import { getDailySnapshots, getReservedIds, getFieldDetail, summarizeDay, SNAPSHOTS } from "../lib/availability-client.ts";
import { boroughForSystem } from "../lib/types.ts";
import { indexParkNames } from "../lib/park-names.ts";

const system = "M071-18-SOCCER-1";
const date = "2026-10-08";

test("daily sampling catches afternoon and evening bookings missed at noon", () => {
  const samples = [new Set(), new Set(), new Set([system]), new Set([system])];
  assert.deepEqual(summarizeDay(system, date, samples), {
    date, status: "partial", bookedPeriods: ["Afternoon", "Evening"], bookedTimes: ["15:00", "18:00"],
  });
  assert.equal(summarizeDay("Q001-SOCCER-1", date, samples).status, "free");
  assert.equal(summarizeDay(system, date, SNAPSHOTS.map(() => new Set([system]))).status, "busy");
  assert.throws(() => summarizeDay(system, date, samples.slice(1)), /Incomplete/);
});

test("periods are deduplicated when both afternoon samples are booked", () => {
  assert.deepEqual(summarizeDay(system, date, [new Set(), new Set([system]), new Set([system]), new Set()]).bookedPeriods, ["Afternoon"]);
});

test("field detail rejects unsafe dates, systems and day counts", () => {
  for (const badDate of ["../../../evil", "2026-02-30", "2026-1-01", null]) {
    assert.equal(parseFieldDetailQuery({ system, date: badDate, days: "1" }).ok, false);
  }
  for (const badSystem of ["X", "../evil", "M071/../../evil", "M071-SOCCER-1?x=y", null]) {
    assert.equal(parseFieldDetailQuery({ system: badSystem, date, days: "1" }).ok, false);
  }
  for (const days of ["0", "8", "1.5", "NaN"]) {
    assert.equal(parseFieldDetailQuery({ system, date, days }).ok, false);
  }
  assert.equal(parseFieldDetailQuery({ system, date, days: null }).value.days, 3);
  assert.equal(isValidSystemId("B223Ob-BASKETBALL-1"), true);
  assert.equal(isValidSystemId("M010-ZN10+11-VOLLEYBALL-2"), true);
});

test("unsafe cache inputs cause neither a fetch nor a filesystem write", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "field-validation-"));
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected fetch"); };
  process.chdir(dir);
  try {
    await assert.rejects(getFieldDetail(system, "../../../evil"), /Invalid/);
    await assert.rejects(getFieldDetail("../evil", date), /Invalid/);
    await assert.rejects(getReservedIds(date, "../../evil"), /Invalid/);
    assert.equal(calls, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    process.chdir(cwd); globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true });
  }
});

test("four serial snapshots per date reuse separate disk entries and deduplicate concurrent misses", async () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "field-snapshots-"));
  const realFetch = globalThis.fetch;
  const urls = [];
  let active = 0;
  globalThis.fetch = async (url) => {
    assert.equal(++active, 1);
    urls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { ok: true, json: async () => ({ dusk: "18:30", l: url.endsWith("15:00") ? [system] : [] }) };
  };
  process.chdir(dir);
  try {
    const first = await getDailySnapshots([date]);
    assert.equal(urls.length, 4);
    assert.deepEqual(urls.map((url) => url.split("+")[1]), ["09:00", "12:00", "15:00", "18:00"]);
    assert.equal(summarizeDay(system, date, first[0]).status, "partial");
    await getDailySnapshots([date]);
    assert.equal(urls.length, 4);
    await Promise.all([getReservedIds("2026-10-09", "09:00"), getReservedIds("2026-10-09", "09:00")]);
    assert.equal(urls.length, 5);
  } finally {
    process.chdir(cwd); globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true });
  }
});

test("location uses exact GIS property keys and handles missing names", () => {
  assert.deepEqual(["M", "B", "Q", "X", "R"].map(boroughForSystem), ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island"]);
  assert.equal(boroughForSystem("?"), "Unknown");
  const names = indexParkNames([{ gispropnum: "M071", name311: "Riverside Park" }, { gispropnum: "B001" }]);
  assert.equal(names.M071, "Riverside Park");
  assert.equal(names.B001, undefined);
  assert.throws(() => indexParkNames([{ gispropnum: "M071", name311: "A" }, { gispropnum: "M071", name311: "B" }]), /Ambiguous/);
});
