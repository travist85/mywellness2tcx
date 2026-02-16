import { FitWriter } from "@markw65/fit-file-writer";
import FitParser from "fit-file-parser";

function makeFit(workout) {
  const start = new Date(workout.startedAtISO ?? new Date().toISOString());
  const startMs = Number.isNaN(start.getTime()) ? Date.now() : start.getTime();
  const totalSeconds = Math.max(1, Math.round(workout.durationSec ?? 0));

  const fit = new FitWriter({ noCompressedTimestamps: false });
  const startFit = fit.time(new Date(startMs));

  fit.writeMessage(
    "file_id",
    {
      type: "activity",
      manufacturer: "garmin",
      product: 0,
      serial_number: 0,
      time_created: startFit,
      product_name: "mywellness2tcx",
    },
    null,
    true,
  );

  const points = [];
  if (Array.isArray(workout.series) && workout.series.length > 0) {
    const sorted = [...workout.series].sort((a, b) => a.tSec - b.tSec);
    const total = Math.max(totalSeconds, sorted.at(-1)?.tSec ?? 0);
    for (const p of sorted) {
      const t = Math.max(0, Math.round(p.tSec));
      points.push({
        tSec: t,
        distance: workout.distanceM ? workout.distanceM * (t / total) : 0,
        altitude: p.altitude,
        heart_rate: p.hr,
        cadence: p.cadence,
        power: p.watts,
      });
    }
  } else {
    const step = 5;
    const n = Math.max(2, Math.floor(totalSeconds / step) + 1);
    for (let i = 0; i < n; i++) {
      const t = Math.min(totalSeconds, i * step);
      points.push({
        tSec: t,
        distance: workout.distanceM ? workout.distanceM * (t / totalSeconds) : 0,
        altitude: workout.verticalM ? workout.verticalM * (t / totalSeconds) : undefined,
        heart_rate: workout.avgHr,
        cadence: workout.cadence,
        power: workout.watts,
      });
    }
  }

  for (const p of points) {
    fit.writeMessage("record", {
      timestamp: fit.time(new Date(startMs + p.tSec * 1000)),
      distance: p.distance,
      altitude: p.altitude,
      heart_rate: p.heart_rate,
      cadence: p.cadence,
      power: p.power,
    });
  }

  const endSec = points.at(-1)?.tSec ?? totalSeconds;
  const endFit = fit.time(new Date(startMs + endSec * 1000));

  fit.writeMessage(
    "lap",
    {
      timestamp: endFit,
      start_time: startFit,
      total_elapsed_time: endSec,
      total_timer_time: endSec,
      total_distance: workout.distanceM ?? 0,
      total_calories: workout.calories,
      avg_heart_rate: workout.avgHr,
      max_heart_rate: workout.maxHr,
      avg_power: workout.watts,
      avg_cadence: workout.cadence,
    },
    null,
    true,
  );

  fit.writeMessage(
    "session",
    {
      timestamp: endFit,
      start_time: startFit,
      total_elapsed_time: endSec,
      total_timer_time: endSec,
      total_distance: workout.distanceM ?? 0,
      total_calories: workout.calories,
      sport: workout.sport ?? "fitness_equipment",
      sub_sport: workout.subSport,
      num_laps: 1,
      avg_heart_rate: workout.avgHr,
      max_heart_rate: workout.maxHr,
      avg_power: workout.watts,
      avg_cadence: workout.cadence,
    },
    null,
    true,
  );

  fit.writeMessage(
    "activity",
    {
      timestamp: endFit,
      total_timer_time: endSec,
      num_sessions: 1,
      type: "manual",
    },
    null,
    true,
  );

  const data = fit.finish();
  const out = new Uint8Array(data.byteLength);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return Buffer.from(out.buffer);
}

async function parseFit(buffer) {
  const parser = new FitParser({
    force: false,
    mode: "list",
    elapsedRecordField: true,
  });
  return parser.parseAsync(buffer);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function validateParsed(label, parsed) {
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const laps = Array.isArray(parsed.laps) ? parsed.laps : [];
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  const activities = Array.isArray(parsed.activity)
    ? parsed.activity
    : parsed.activity != null
      ? [parsed.activity]
      : [];
  assert(activities.length >= 1, `${label}: missing activity message`);
  assert(sessions.length >= 1, `${label}: missing session message`);
  assert(laps.length >= 1, `${label}: missing lap message`);
  assert(records.length >= 1, `${label}: missing record messages`);

  let prevTs = -Infinity;
  for (const r of records) {
    if (typeof r.timestamp === "number") {
      assert(r.timestamp >= prevTs, `${label}: non-monotonic record timestamps`);
      prevTs = r.timestamp;
    }
  }

  let prevDist = -Infinity;
  for (const r of records) {
    if (typeof r.distance === "number") {
      assert(r.distance >= prevDist, `${label}: non-monotonic record distance`);
      prevDist = r.distance;
    }
  }
}

async function main() {
  const syntheticWorkout = {
    startedAtISO: "2026-02-15T08:10:00.000Z",
    durationSec: 1800,
    distanceM: 4500,
    verticalM: 120,
    calories: 320,
    avgHr: 138,
    maxHr: 162,
    cadence: 84,
    watts: 165,
    sport: "running",
  };

  const seriesWorkout = {
    startedAtISO: "2026-02-15T19:00:00.000Z",
    durationSec: 600,
    distanceM: 0,
    calories: 140,
    avgHr: 121,
    maxHr: 143,
    cadence: 58,
    watts: 138,
    sport: "fitness_equipment",
    subSport: "stair_climbing",
    series: Array.from({ length: 120 }, (_, i) => ({
      tSec: i * 5,
      hr: 110 + (i % 30),
      cadence: 55 + (i % 8),
      watts: 120 + (i % 25),
      altitude: i * 0.08,
    })),
  };

  const cases = [
    ["synthetic", syntheticWorkout],
    ["series", seriesWorkout],
  ];

  for (const [label, workout] of cases) {
    const fit = makeFit(workout);
    const parsed = await parseFit(fit);
    validateParsed(label, parsed);
    console.log(
      `[ok] ${label}: activities=${Array.isArray(parsed.activity) ? parsed.activity.length : parsed.activity ? 1 : 0}, sessions=${parsed.sessions?.length ?? 0}, laps=${parsed.laps?.length ?? 0}, records=${parsed.records?.length ?? 0}`,
    );
  }

  console.log("FIT validation checks passed.");
}

main().catch((err) => {
  console.error("FIT validation failed:", err?.message ?? err);
  process.exitCode = 1;
});
