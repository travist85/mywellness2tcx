import { Fragment, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import JSZip from "jszip";
import { FitWriter } from "@markw65/fit-file-writer";

type WorkoutExportOpts = {
  includeHrSeries: boolean;
  includeCadenceSeries: boolean;
  includePowerSeries: boolean;
  includeMetricsInNotes: boolean;
  includeCalories: boolean;
  includeDistance: boolean;
  includeVerticalAsAltitude: boolean;
};

type Workout = {
  uid: string;
  source: "indoor" | "outdoor";
  id: string;
  startedAtISO?: string;
  startedAtDisplay: string;
  activityName: string;

  durationSec?: number;
  calories?: number;
  distanceM?: number;
  // Mywellness exports use different keys:
  // - indoor stair: "Floors" behaves like vertical metres
  // - outdoor: "Elevation" is vertical metres
  verticalM?: number;
  cadenceSpm?: number;

  exportOpts: WorkoutExportOpts;

  // schema-inspector
  metrics: Record<string, number>;
  metricKeys: string[];
  series?: SeriesPoint[];

  raw: unknown;
};

type SeriesPoint = {
  tSec: number;
  hr?: number;
  watts?: number;
  cadence?: number;
  verticalM?: number;
};

type ImportMode = "zip" | "json";
type ExportFormat = "tcx" | "fit";

function safeNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => safeNumber(x)).filter((x): x is number => x != null);
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((acc, x) => acc + x, 0) / values.length;
}

function parseDurationString(s: string): number | undefined {
  const trimmed = s.trim();
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const sec = Number(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(sec)) return m * 60 + sec;
  }
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const sec = Number(parts[2]);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(sec)) {
      return h * 3600 + m * 60 + sec;
    }
  }
  return undefined;
}

function toMetersFromUnit(value: number, unitRaw: unknown): number {
  const unit = typeof unitRaw === "string" ? unitRaw.trim().toLowerCase() : "";
  if (!unit) return value;
  if (
    unit === "m" ||
    unit === "meter" ||
    unit === "meters" ||
    unit === "metre" ||
    unit === "metres"
  ) {
    return value;
  }
  if (unit === "km" || unit === "kilometer" || unit === "kilometers") {
    return value * 1000;
  }
  if (unit === "mi" || unit === "mile" || unit === "miles" || unit === "mls") {
    return value * 1609.344;
  }
  if (unit === "ft" || unit === "foot" || unit === "feet") {
    return value * 0.3048;
  }
  return value;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDateHuman(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function pickSport(activityName: string): "Running" | "Biking" | "Other" {
  const a = (activityName || "").toLowerCase();
  if (a.includes("run")) return "Running";
  if (a.includes("cycle") || a.includes("bike") || a.includes("ride"))
    return "Biking";
  return "Other";
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadTextFile(
  filename: string,
  contents: string,
  mime = "application/xml",
) {
  downloadBlob(filename, new Blob([contents], { type: mime }));
}

function prToMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};

  const rawRec = asRecord(raw);
  const performedData = asRecord(rawRec?.performedData);
  const physicalActivityData = asRecord(rawRec?.physicalActivityData);

  const pr =
    performedData?.pr ??
    physicalActivityData?.pr ??
    performedData?.PR ??
    physicalActivityData?.PR;

  if (!Array.isArray(pr)) return out;

  for (const item of pr) {
    const itemRec = asRecord(item);
    const name = itemRec?.n;
    const val = safeNumber(itemRec?.v);
    if (typeof name === "string" && val != null) out[name] = val;
  }
  return out;
}

function pickDistanceM(metrics: Record<string, number>): number | undefined {
  return (
    metrics["HDistance"] ??
    metrics["Distance"] ??
    metrics["DistanceMeters"] ??
    (metrics["Km"] != null ? metrics["Km"] * 1000 : undefined)
  );
}

function pickVerticalM(metrics: Record<string, number>): number | undefined {
  return metrics["Elevation"] ?? metrics["Floors"];
}

function pickCadenceSpm(metrics: Record<string, number>): number | undefined {
  return metrics["AvgSpm"] ?? metrics["Cadence"];
}

function safeDateToken(iso?: string): string {
  const parsed = iso ? new Date(iso) : new Date();
  const dt = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return dt.toISOString().replace(/[:]/g, "").replace(/\..+/, "Z");
}

function pickFitSport(
  w: Workout,
): {
  sport: "running" | "cycling" | "fitness_equipment" | "generic";
  subSport?: "stair_climbing";
} {
  const a = (w.activityName || "").toLowerCase();
  if (a.includes("run")) return { sport: "running" };
  if (a.includes("cycle") || a.includes("bike") || a.includes("ride")) return { sport: "cycling" };
  if (a.includes("stair") || a.includes("climb") || a.includes("floor")) {
    return { sport: "fitness_equipment", subSport: "stair_climbing" };
  }
  if (w.source === "indoor") return { sport: "fitness_equipment" };
  return { sport: "generic" };
}

function workoutToTCX(w: Workout, opts: WorkoutExportOpts): string {
  const rawRec = asRecord(w.raw);
  const rawStartISO =
    typeof rawRec?.on === "string"
      ? rawRec.on
      : typeof rawRec?.performedDate === "string"
        ? rawRec.performedDate
        : undefined;
  const startISO =
    (typeof w.startedAtISO === "string" && w.startedAtISO) ||
    rawStartISO ||
    new Date().toISOString();

  const start = new Date(startISO);
  const validStartMs = Number.isNaN(start.getTime()) ? Date.now() : start.getTime();
  const startForTCX = Number.isNaN(start.getTime())
    ? new Date().toISOString()
    : start.toISOString();

  const totalSeconds = Math.max(0, Math.round(w.durationSec ?? 0));

  const calories = opts.includeCalories ? w.calories : undefined;
  const totalDistanceM = opts.includeDistance ? w.distanceM : undefined;
  const totalVerticalM =
    opts.includeVerticalAsAltitude && w.verticalM != null ? w.verticalM : undefined;

  // Approximate series (only if user opts in)
  const avgHr = w.metrics["AvgHr"];
  const maxHr = w.metrics["MaxHr"];

  const avgPower = w.metrics["AvgPower"];
  const watts =
    opts.includePowerSeries && avgPower != null ? Math.round(avgPower) : undefined;

  // cadence in SPM:
  // - Outdoor run: AvgSpm
  // - Indoor: derive from Move/Duration when AvgSpm not present
  const spmFromField = pickCadenceSpm(w.metrics);
  const move = w.metrics["Move"];
  const dur = w.metrics["Duration"] ?? w.durationSec ?? 0;

  const cadenceSpm =
    opts.includeCadenceSeries
      ? spmFromField ??
      (move != null && dur > 0 ? move / (dur / 60) : undefined)
      : undefined;

  const cadence = cadenceSpm != null ? Math.round(cadenceSpm) : undefined;

  const points: string[] = [];
  const hasSeries = Array.isArray(w.series) && w.series.length > 0;
  if (hasSeries) {
    const sortedSeries = [...(w.series ?? [])].sort((a, b) => a.tSec - b.tSec);
    const seriesTotalSec = Math.max(
      totalSeconds,
      sortedSeries[sortedSeries.length - 1]?.tSec ?? 0,
    );
    for (const p of sortedSeries) {
      const t = Math.max(0, Math.round(p.tSec));
      const time = new Date(validStartMs + t * 1000).toISOString();
      const hr =
        opts.includeHrSeries
          ? p.hr != null
            ? Math.round(p.hr)
            : undefined
          : undefined;
      const pointCadence =
        opts.includeCadenceSeries
          ? p.cadence != null
            ? Math.round(p.cadence)
            : cadence
          : undefined;
      const pointWatts =
        opts.includePowerSeries
          ? p.watts != null
            ? Math.round(p.watts)
            : watts
          : undefined;
      const dist =
        totalDistanceM != null && seriesTotalSec > 0
          ? totalDistanceM * (t / seriesTotalSec)
          : 0;
      const alt =
        opts.includeVerticalAsAltitude
          ? p.verticalM != null
            ? p.verticalM
            : totalVerticalM != null && seriesTotalSec > 0
              ? totalVerticalM * (t / seriesTotalSec)
              : undefined
          : undefined;

      points.push(`
        <Trackpoint>
          <Time>${time}</Time>
          ${alt != null ? `<AltitudeMeters>${alt.toFixed(1)}</AltitudeMeters>` : ""}
          <DistanceMeters>${dist.toFixed(1)}</DistanceMeters>
          ${hr != null ? `<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>` : ""}
          ${pointCadence != null ? `<Cadence>${pointCadence}</Cadence>` : ""}
          ${pointWatts != null
          ? `<Extensions>
                  <tpx:TPX>
                    <tpx:Watts>${pointWatts}</tpx:Watts>
                  </tpx:TPX>
                </Extensions>`
          : ""
        }
        </Trackpoint>`);
    }
  } else {
    // Fallback synthetic trackpoints every 5 seconds (Strava-friendly)
    const step = 5;
    const n =
      totalSeconds > 0 ? Math.max(2, Math.floor(totalSeconds / step) + 1) : 2;
    for (let i = 0; i < n; i++) {
      const t = Math.min(totalSeconds, i * step);
      const time = new Date(validStartMs + t * 1000).toISOString();

      // HR: export as constant AvgHr (explicitly approximate)
      const hr =
        opts.includeHrSeries && (avgHr != null || maxHr != null)
          ? Math.round(avgHr ?? maxHr)
          : undefined;

      const dist =
        totalDistanceM != null && totalSeconds > 0
          ? totalDistanceM * (t / totalSeconds)
          : 0;

      const alt =
        totalVerticalM != null && totalSeconds > 0
          ? totalVerticalM * (t / totalSeconds)
          : undefined;

      points.push(`
        <Trackpoint>
          <Time>${time}</Time>
          ${alt != null ? `<AltitudeMeters>${alt.toFixed(1)}</AltitudeMeters>` : ""}
          <DistanceMeters>${dist.toFixed(1)}</DistanceMeters>
          ${hr != null ? `<HeartRateBpm><Value>${hr}</Value></HeartRateBpm>` : ""}
          ${cadence != null ? `<Cadence>${cadence}</Cadence>` : ""}
          ${watts != null
          ? `<Extensions>
                  <tpx:TPX>
                    <tpx:Watts>${watts}</tpx:Watts>
                  </tpx:TPX>
                </Extensions>`
          : ""
        }
        </Trackpoint>`);
    }
  }

  const sport = pickSport(w.activityName);

  const notes =
    opts.includeMetricsInNotes
      ? `Mywellness metrics: ${Object.entries(w.metrics)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`
      : "Generated from Mywellness export.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:tpx="http://www.garmin.com/xmlschemas/ActivityExtension/v2"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="${sport}">
      <Id>${startForTCX}</Id>
      <Lap StartTime="${startForTCX}">
        <TotalTimeSeconds>${totalSeconds}</TotalTimeSeconds>
        <DistanceMeters>${totalDistanceM != null ? totalDistanceM.toFixed(1) : "0"}</DistanceMeters>
        ${calories != null ? `<Calories>${Math.max(0, Math.round(calories))}</Calories>` : ""}
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>${points.join("\n")}
        </Track>
      </Lap>
      <Notes>${notes}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

function workoutToFIT(
  w: Workout,
  opts: WorkoutExportOpts,
  enhancedCompatibility = false,
): ArrayBuffer {
  const rawRec = asRecord(w.raw);
  const rawStartISO =
    typeof rawRec?.on === "string"
      ? rawRec.on
      : typeof rawRec?.performedDate === "string"
        ? rawRec.performedDate
        : undefined;
  const startISO =
    (typeof w.startedAtISO === "string" && w.startedAtISO) ||
    rawStartISO ||
    new Date().toISOString();
  const start = new Date(startISO);
  const startMs = Number.isNaN(start.getTime()) ? Date.now() : start.getTime();

  const totalSeconds = Math.max(0, Math.round(w.durationSec ?? 0));
  const totalDistanceM = opts.includeDistance ? w.distanceM : undefined;
  const totalVerticalM =
    opts.includeVerticalAsAltitude && w.verticalM != null ? w.verticalM : undefined;
  const calories = opts.includeCalories && w.calories != null ? Math.max(0, Math.round(w.calories)) : undefined;

  const avgHr = w.metrics["AvgHr"];
  const maxHr = w.metrics["MaxHr"];
  const avgPower = w.metrics["AvgPower"];

  const spmFromField = pickCadenceSpm(w.metrics);
  const move = w.metrics["Move"];
  const dur = w.metrics["Duration"] ?? w.durationSec ?? 0;
  const defaultCadence =
    opts.includeCadenceSeries
      ? spmFromField ?? (move != null && dur > 0 ? move / (dur / 60) : undefined)
      : undefined;
  const defaultWatts = opts.includePowerSeries && avgPower != null ? Math.round(avgPower) : undefined;

  const fit = new FitWriter({ noCompressedTimestamps: false });
  const startFit = fit.time(new Date(startMs));

  fit.writeMessage("file_id", {
    type: "activity",
    manufacturer: "garmin",
    product: 0,
    serial_number: 0,
    time_created: startFit,
    product_name: "mywellness2tcx",
  }, null, true);

  if (enhancedCompatibility) {
    fit.writeMessage("file_creator", {
      software_version: 100,
      hardware_version: 1,
    }, null, true);

    fit.writeMessage("device_info", {
      timestamp: startFit,
      device_index: 0,
      manufacturer: "garmin",
      product: 0,
      serial_number: 0,
      software_version: 1.0,
    }, null, true);

    fit.writeMessage("event", {
      timestamp: startFit,
      event: "timer",
      event_type: "start",
      event_group: 0,
    });
  }

  const hasSeries = Array.isArray(w.series) && w.series.length > 0;
  const records: Array<{
    tSec: number;
    hr?: number;
    cadence?: number;
    watts?: number;
    alt?: number;
    dist: number;
  }> = [];

  if (hasSeries) {
    const sortedSeries = [...(w.series ?? [])].sort((a, b) => a.tSec - b.tSec);
    const hrAnchors = sortedSeries
      .filter((p): p is SeriesPoint & { hr: number } => p.hr != null)
      .sort((a, b) => a.tSec - b.tSec);
    const hrAt = (tSec: number): number | undefined => {
      if (!opts.includeHrSeries || hrAnchors.length === 0) return undefined;
      if (hrAnchors.length === 1) return hrAnchors[0].hr;
      if (tSec <= hrAnchors[0].tSec) return hrAnchors[0].hr;
      const last = hrAnchors[hrAnchors.length - 1];
      if (tSec >= last.tSec) return last.hr;
      for (let i = 1; i < hrAnchors.length; i++) {
        const a = hrAnchors[i - 1];
        const b = hrAnchors[i];
        if (tSec <= b.tSec) {
          const span = b.tSec - a.tSec;
          if (span <= 0) return b.hr;
          const ratio = (tSec - a.tSec) / span;
          return a.hr + (b.hr - a.hr) * ratio;
        }
      }
      return last.hr;
    };
    const seriesTotalSec = Math.max(totalSeconds, sortedSeries[sortedSeries.length - 1]?.tSec ?? 0);
    for (const p of sortedSeries) {
      const t = Math.max(0, Math.round(p.tSec));
      const hrRaw = hrAt(t);
      const hr =
        opts.includeHrSeries && hrRaw != null ? Math.round(hrRaw) : undefined;
      const cadence =
        opts.includeCadenceSeries
          ? p.cadence != null
            ? Math.round(p.cadence)
            : defaultCadence != null
              ? Math.round(defaultCadence)
              : undefined
          : undefined;
      const watts =
        opts.includePowerSeries
          ? p.watts != null
            ? Math.round(p.watts)
            : defaultWatts
          : undefined;
      const dist =
        totalDistanceM != null && seriesTotalSec > 0
          ? totalDistanceM * (t / seriesTotalSec)
          : 0;
      const alt =
        opts.includeVerticalAsAltitude
          ? p.verticalM != null
            ? p.verticalM
            : totalVerticalM != null && seriesTotalSec > 0
              ? totalVerticalM * (t / seriesTotalSec)
              : undefined
          : undefined;
      records.push({ tSec: t, hr, cadence, watts, alt, dist });
    }
    if (opts.includeHrSeries && records.length > 0) {
      let firstKnown: number | undefined;
      for (const r of records) {
        if (r.hr != null) {
          firstKnown = r.hr;
          break;
        }
      }
      const fallbackHr =
        firstKnown ??
        (avgHr != null ? Math.round(avgHr) : maxHr != null ? Math.round(maxHr) : undefined);
      if (fallbackHr != null) {
        let prev = fallbackHr;
        for (const r of records) {
          if (r.hr == null) r.hr = prev;
          else prev = r.hr;
        }
      }
    }
  } else {
    const step = 5;
    const n =
      totalSeconds > 0 ? Math.max(2, Math.floor(totalSeconds / step) + 1) : 2;
    for (let i = 0; i < n; i++) {
      const t = Math.min(totalSeconds, i * step);
      const hr =
        opts.includeHrSeries && (avgHr != null || maxHr != null)
          ? Math.round(avgHr ?? maxHr)
          : undefined;
      const dist =
        totalDistanceM != null && totalSeconds > 0
          ? totalDistanceM * (t / totalSeconds)
          : 0;
      const alt =
        totalVerticalM != null && totalSeconds > 0
          ? totalVerticalM * (t / totalSeconds)
          : undefined;
      const cadence = defaultCadence != null ? Math.round(defaultCadence) : undefined;
      records.push({ tSec: t, hr, cadence, watts: defaultWatts, alt, dist });
    }
  }

  const lastTSec = records.length ? records[records.length - 1].tSec : totalSeconds;
  const totalTime = Math.max(1, lastTSec);
  const avgSpeed = totalDistanceM != null && totalTime > 0 ? totalDistanceM / totalTime : undefined;
  const maxSpeed = avgSpeed != null ? avgSpeed * 1.08 : undefined;
  const totalAscent = totalVerticalM != null ? Math.max(0, totalVerticalM) : undefined;
  const totalDescent = totalVerticalM != null ? 0 : undefined;
  const totalWork =
    avgPower != null
      ? Math.max(0, Math.round(avgPower * totalTime))
      : undefined;

  for (const r of records) {
    fit.writeMessage("record", {
      timestamp: fit.time(new Date(startMs + r.tSec * 1000)),
      distance: r.dist,
      heart_rate: r.hr,
      cadence: r.cadence,
      power: r.watts,
      altitude: r.alt,
    });
  }

  const sport = pickFitSport(w);
  const endFit = fit.time(new Date(startMs + Math.max(1, lastTSec) * 1000));

  fit.writeMessage("lap", {
    timestamp: endFit,
    start_time: startFit,
    total_elapsed_time: totalTime,
    total_timer_time: totalTime,
    total_distance: totalDistanceM ?? 0,
    total_calories: calories,
    total_ascent: totalAscent,
    total_descent: totalDescent,
    avg_speed: avgSpeed,
    max_speed: maxSpeed,
    avg_heart_rate: avgHr != null ? Math.round(avgHr) : undefined,
    max_heart_rate: maxHr != null ? Math.round(maxHr) : undefined,
    avg_power: avgPower != null ? Math.round(avgPower) : undefined,
    total_work: totalWork,
    avg_cadence: defaultCadence != null ? Math.round(defaultCadence) : undefined,
  }, null, true);

  fit.writeMessage("session", {
    timestamp: endFit,
    start_time: startFit,
    total_elapsed_time: totalTime,
    total_timer_time: totalTime,
    total_distance: totalDistanceM ?? 0,
    total_calories: calories,
    total_ascent: totalAscent,
    total_descent: totalDescent,
    avg_speed: avgSpeed,
    max_speed: maxSpeed,
    total_work: totalWork,
    sport: sport.sport,
    sub_sport: sport.subSport,
    num_laps: 1,
    avg_heart_rate: avgHr != null ? Math.round(avgHr) : undefined,
    max_heart_rate: maxHr != null ? Math.round(maxHr) : undefined,
    avg_power: avgPower != null ? Math.round(avgPower) : undefined,
    avg_cadence: defaultCadence != null ? Math.round(defaultCadence) : undefined,
  }, null, true);

  fit.writeMessage("activity", {
    timestamp: endFit,
    total_timer_time: totalTime,
    num_sessions: 1,
    type: "manual",
  }, null, true);

  if (enhancedCompatibility) {
    fit.writeMessage("event", {
      timestamp: endFit,
      event: "timer",
      event_type: "stop_all",
      event_group: 0,
    }, null, true);

    fit.writeMessage("device_info", {
      timestamp: endFit,
      device_index: 0,
      manufacturer: "garmin",
      product: 0,
      serial_number: 0,
      software_version: 1.0,
    }, null, true);
  }

  const data = fit.finish();
  const out = new Uint8Array(data.byteLength);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return out.buffer;
}

function extractWorkoutsFromIndoorJSON(obj: unknown): Workout[] {

  const items = Array.isArray(obj) ? obj : [];
  return items.map((raw: unknown, idx: number) => {
    const rawRec = asRecord(raw);
    const metrics = prToMap(raw);
    const startedAt = rawRec?.on;
    const durationSec = metrics["Duration"];
    const calories = metrics["Calories"];
    const distanceM = pickDistanceM(metrics);
    const verticalM = pickVerticalM(metrics);
    const cadenceSpm = pickCadenceSpm(metrics);

    // Best-effort naming (improve later using facility metadata if present)
    const activityName =
      rawRec?.activityName ||
      (verticalM != null ? "Stair climber" : "Indoor workout");

    const id = String(rawRec?.id ?? `${startedAt ?? "ind"}-${idx}`);
    const uid = `indoor-${String(startedAt ?? "unknown")}-${id}-${idx}`;

    return {
      uid,
      source: "indoor",
      id,
      startedAtISO: typeof startedAt === "string" ? startedAt : undefined,
      startedAtDisplay:
        typeof startedAt === "string" ? formatDateHuman(startedAt) : "—",
      activityName: String(activityName),
      durationSec,
      distanceM,
      calories,
      verticalM,
      cadenceSpm,
      metrics,
      metricKeys: Object.keys(metrics).sort(),
      raw,

      exportOpts: {
        includeHrSeries: metrics["AvgHr"] != null || metrics["MaxHr"] != null,
        includeCadenceSeries: cadenceSpm != null || metrics["AvgSpm"] != null || metrics["Cadence"] != null,
        includePowerSeries: metrics["AvgPower"] != null,
        includeMetricsInNotes: false,
        includeCalories: calories != null,
        includeDistance: distanceM != null,
        includeVerticalAsAltitude: verticalM != null,
      },
    };
  });
}

function extractWorkoutsFromOutdoorJSON(obj: unknown): Workout[] {
  const objRec = asRecord(obj);
  const items = Array.isArray(obj)
    ? obj
    : (objRec?.items ?? objRec?.activities ?? objRec?.data ?? []);
  if (!Array.isArray(items)) return [];

  return items.map((raw: unknown, idx: number) => {
    const rawRec = asRecord(raw);
    const metrics = prToMap(raw);
    const durationSec =
      metrics["Duration"] ??
      safeNumber(rawRec?.duration) ??
      safeNumber(rawRec?.Duration);
    const calories =
      metrics["Calories"] ??
      safeNumber(rawRec?.calories) ??
      safeNumber(rawRec?.Calories);
    const distanceM = pickDistanceM(metrics);
    const verticalM = pickVerticalM(metrics);
    const cadenceSpm = pickCadenceSpm(metrics);

    const startedAt = rawRec?.performedDate ?? rawRec?.on;
    const activityName = rawRec?.activityName ?? "Outdoor workout";
    const id = String(rawRec?.id ?? rawRec?.uuid ?? `${startedAt ?? "out"}-${idx}`);
    const uid = `outdoor-${String(startedAt ?? "unknown")}-${id}-${idx}`;

    return {
      uid,
      source: "outdoor",
      id,
      startedAtISO: typeof startedAt === "string" ? startedAt : undefined,
      startedAtDisplay:
        typeof startedAt === "string" ? formatDateHuman(startedAt) : "—",
      activityName: String(activityName),
      durationSec,
      calories,
      distanceM,
      verticalM,
      cadenceSpm,
      metrics,
      metricKeys: Object.keys(metrics).sort(),
      raw,

      exportOpts: {
        includeHrSeries: metrics["AvgHr"] != null || metrics["MaxHr"] != null,
        includeCadenceSeries: cadenceSpm != null || metrics["AvgSpm"] != null || metrics["Cadence"] != null,
        includePowerSeries: metrics["AvgPower"] != null,
        includeMetricsInNotes: false,
        includeCalories: calories != null,
        includeDistance: distanceM != null,
        includeVerticalAsAltitude: verticalM != null,
      },
    };
  });
}
void extractWorkoutsFromOutdoorJSON;

function extractWorkoutFromSinglePageJSON(
  obj: unknown,
  preferredStartTime?: string,
): Workout | null {
  const root = asRecord(obj);
  const core = asRecord(root?.data) ?? root;
  if (!core) return null;

  const analytics = asRecord(core.analitics);
  const descriptors = Array.isArray(analytics?.descriptor) ? analytics.descriptor : [];
  const samples = Array.isArray(analytics?.samples) ? analytics.samples : [];
  const hrSamples = Array.isArray(analytics?.hr) ? analytics.hr : [];
  const summaryData = Array.isArray(core.data) ? core.data : [];

  const descriptorByIndex = new Map<number, string>();
  const descriptorUnitByIndex = new Map<number, string>();
  for (const d of descriptors) {
    const rec = asRecord(d);
    const i = safeNumber(rec?.i);
    const pr = asRecord(rec?.pr);
    const name = typeof pr?.name === "string" ? pr.name : undefined;
    const unit = typeof pr?.um === "string" ? pr.um : undefined;
    if (i != null && name) descriptorByIndex.set(i, name);
    if (i != null && unit) descriptorUnitByIndex.set(i, unit);
  }

  const hrByT = new Map<number, number>();
  for (const h of hrSamples) {
    const rec = asRecord(h);
    const t = safeNumber(rec?.t);
    const hr = safeNumber(rec?.hr);
    if (t != null && hr != null) hrByT.set(Math.round(t), hr);
  }
  const hrAnchors = [...hrByT.entries()]
    .map(([tSec, hr]) => ({ tSec, hr }))
    .sort((a, b) => a.tSec - b.tSec);
  const hrAt = (tSec: number): number | undefined => {
    if (hrAnchors.length === 0) return undefined;
    if (hrAnchors.length === 1) return hrAnchors[0].hr;
    if (tSec <= hrAnchors[0].tSec) return hrAnchors[0].hr;
    const last = hrAnchors[hrAnchors.length - 1];
    if (tSec >= last.tSec) return last.hr;
    for (let i = 1; i < hrAnchors.length; i++) {
      const a = hrAnchors[i - 1];
      const b = hrAnchors[i];
      if (tSec <= b.tSec) {
        const span = b.tSec - a.tSec;
        if (span <= 0) return b.hr;
        const ratio = (tSec - a.tSec) / span;
        return a.hr + (b.hr - a.hr) * ratio;
      }
    }
    return last.hr;
  };

  const series: SeriesPoint[] = [];
  let sampleDistanceM: number | undefined;
  for (const s of samples) {
    const rec = asRecord(s);
    const t = safeNumber(rec?.t);
    const vs = asNumberArray(rec?.vs);
    if (t == null) continue;

    const point: SeriesPoint = { tSec: Math.max(0, Math.round(t)) };
    for (let idx = 0; idx < vs.length; idx++) {
      const key = descriptorByIndex.get(idx)?.toLowerCase();
      const value = vs[idx];
      if (!key) continue;
      if (key === "power" || key === "runningpower") point.watts = value;
      if (key === "spm" || key === "rpm" || key === "cadence" || key === "runningcadence") {
        point.cadence = value;
      }
      if (key === "floors" || key === "elevation") {
        point.verticalM = toMetersFromUnit(value, descriptorUnitByIndex.get(idx));
      }
      if (key === "hdistance" || key === "distance") {
        const distM = toMetersFromUnit(value, descriptorUnitByIndex.get(idx));
        sampleDistanceM = sampleDistanceM == null ? distM : Math.max(sampleDistanceM, distM);
      }
    }
    const hr = hrAt(point.tSec);
    if (hr != null) point.hr = Math.round(hr);
    series.push(point);
  }

  series.sort((a, b) => a.tSec - b.tSec);

  let durationSec = series.length ? series[series.length - 1].tSec : undefined;
  let move: number | undefined;
  let summaryDistanceM: number | undefined;
  let summaryVerticalM: number | undefined;
  let calories: number | undefined;
  for (const item of summaryData) {
    const rec = asRecord(item);
    const property = typeof rec?.property === "string" ? rec.property.toLowerCase() : "";
    const name = typeof rec?.name === "string" ? rec.name.toLowerCase() : "";
    const unit = typeof rec?.uM === "string" ? rec.uM : "";
    const rawValue = safeNumber(rec?.rawValue);
    if (property.includes("duration") || name.includes("duration")) {
      const fromRawMin = rawValue;
      const fromText = typeof rec?.value === "string" ? parseDurationString(rec.value) : undefined;
      durationSec = fromText ?? (fromRawMin != null ? Math.round(fromRawMin * 60) : durationSec);
    }
    if (property.includes("move") || name.includes("move")) {
      move = rawValue;
    }
    if (
      property.includes("distance") ||
      property.includes("hdistance") ||
      name.includes("distance")
    ) {
      if (rawValue != null) {
        summaryDistanceM = toMetersFromUnit(rawValue, unit);
      }
    }
    if (property.includes("elevation") || property.includes("floors") || name.includes("elevation")) {
      if (rawValue != null) {
        summaryVerticalM = toMetersFromUnit(rawValue, unit);
      }
    }
    if (property.includes("calories") || name.includes("calories")) {
      calories = rawValue;
    }
  }

  const hrValues = series.map((p) => p.hr).filter((x): x is number => x != null);
  const powerValues = series.map((p) => p.watts).filter((x): x is number => x != null);
  const cadenceValues = series.map((p) => p.cadence).filter((x): x is number => x != null);
  const verticalValues = series.map((p) => p.verticalM).filter((x): x is number => x != null);

  const metrics: Record<string, number> = {};
  if (durationSec != null) metrics["Duration"] = durationSec;
  if (move != null) metrics["Move"] = move;
  if (hrValues.length) {
    const avgHr = average(hrValues);
    if (avgHr != null) metrics["AvgHr"] = avgHr;
    metrics["MaxHr"] = Math.max(...hrValues);
  }
  if (powerValues.length) {
    const avgPower = average(powerValues);
    if (avgPower != null) metrics["AvgPower"] = avgPower;
  }
  if (cadenceValues.length) {
    const avgSpm = average(cadenceValues);
    if (avgSpm != null) metrics["AvgSpm"] = avgSpm;
  }
  if (verticalValues.length) {
    metrics["Floors"] = Math.max(...verticalValues);
  }
  const distanceM = sampleDistanceM ?? summaryDistanceM;
  if (distanceM != null) metrics["HDistance"] = distanceM;
  if (summaryVerticalM != null && metrics["Floors"] == null) metrics["Floors"] = summaryVerticalM;

  const dateStr = typeof core.date === "string" ? core.date : undefined;
  const parsedDate = dateStr ? new Date(dateStr) : undefined;
  let startedAtISO = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : undefined;
  if (startedAtISO && preferredStartTime) {
    const match = preferredStartTime.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (match) {
      const hh = Number(match[1]);
      const mm = Number(match[2]);
      const ss = Number(match[3] ?? "0");
      if (
        Number.isFinite(hh) && hh >= 0 && hh < 24 &&
        Number.isFinite(mm) && mm >= 0 && mm < 60 &&
        Number.isFinite(ss) && ss >= 0 && ss < 60
      ) {
        const dt = new Date(startedAtISO);
        dt.setHours(hh, mm, ss, 0);
        startedAtISO = dt.toISOString();
      }
    }
  }

  const activityName =
    typeof core.physicalActivityName === "string"
      ? core.physicalActivityName
      : typeof core.name === "string"
        ? core.name
        : typeof core.equipmentType === "string"
          ? core.equipmentType
          : "MyWellness workout";

  const id =
    typeof core.cardioLogId === "string"
      ? core.cardioLogId
      : typeof core.physicalActivityId === "string"
        ? core.physicalActivityId
        : `json-${Date.now()}`;

  const verticalM = verticalValues.length ? Math.max(...verticalValues) : summaryVerticalM;
  const cadenceSpm = average(cadenceValues);
  const hasDistance = pickDistanceM(metrics) != null;

  return {
    uid: `json-${id}`,
    source: "indoor",
    id,
    startedAtISO,
    startedAtDisplay: startedAtISO ? formatDateHuman(startedAtISO) : "—",
    activityName,
    durationSec,
    calories,
    distanceM: pickDistanceM(metrics),
    verticalM,
    cadenceSpm: cadenceSpm != null ? cadenceSpm : undefined,
    metrics,
    metricKeys: Object.keys(metrics).sort(),
    raw: core,
    series,
    exportOpts: {
      includeHrSeries: hrValues.length > 0,
      includeCadenceSeries: cadenceValues.length > 0,
      includePowerSeries: powerValues.length > 0,
      includeMetricsInNotes: false,
      includeCalories: calories != null,
      includeDistance: hasDistance,
      includeVerticalAsAltitude: verticalM != null,
    },
  };
}

function computeSummary(ws: Workout[]) {
  const totalSec = ws.reduce((acc, w) => acc + (w.durationSec ?? 0), 0);
  const totalDistM = ws.reduce((acc, w) => acc + (w.distanceM ?? 0), 0);
  const totalVertM = ws.reduce((acc, w) => acc + (w.verticalM ?? 0), 0);
  return { totalSec, totalDistM, totalVertM };
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const FEEDBACK_URL =
    "https://github.com/travist85/mywellness2tcx/issues/new/choose";


  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zipName, setZipName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [didParse, setDidParse] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("json");
  const [lastImportMode, setLastImportMode] = useState<ImportMode | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("tcx");
  const [enhancedFitCompatibility, setEnhancedFitCompatibility] = useState(false);
  const [jsonInput, setJsonInput] = useState("");
  const [jsonStartTime, setJsonStartTime] = useState("12:00");
  const [showJsonHelp, setShowJsonHelp] = useState(false);

  const sortedWorkouts = useMemo(() => {
    return [...workouts].sort((a, b) => {
      const ta = a.startedAtISO ? new Date(a.startedAtISO).getTime() : 0;
      const tb = b.startedAtISO ? new Date(b.startedAtISO).getTime() : 0;
      return tb - ta;
    });
  }, [workouts]);

  const summary = useMemo(() => computeSummary(sortedWorkouts), [sortedWorkouts]);

  function resetParsedState() {
    setError(null);
    setWorkouts([]);
    setZipName(null);
    setDidParse(false);
    setLastImportMode(null);
  }

  async function onZipSelected(file: File | null) {
    resetParsedState();

    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("Please choose a .zip file exported from MyWellness.");
      return;
    }

    setIsLoading(true);
    try {
      const zip = await JSZip.loadAsync(file);
      setZipName(file.name);

      // Privacy-by-design:
      // Parse only indooractivities* for machine workouts.
      // Ignore all other files (including masterdata* and biometrics*).
      const fileEntries = Object.keys(zip.files);

      const targetNames = fileEntries.filter((n) => {
        const lower = n.toLowerCase();
        const basename = lower.split("/").pop() ?? lower;
        return basename.startsWith("indooractivities-") && basename.endsWith(".json");
      });

      if (targetNames.length === 0) {
        setError(
          "Could not find indooractivities-*.json in this ZIP. Make sure it’s a full MyWellness export.",
        );
        return;
      }

      const all: Workout[] = [];

      for (const name of targetNames) {
        const lower = name.toLowerCase();
        const basename = lower.split("/").pop() ?? lower;
        const text = await zip.files[name].async("string");
        let obj: unknown;
        try {
          obj = JSON.parse(text);
        } catch {
          continue;
        }

        if (basename.startsWith("indooractivities-")) {
          all.push(...extractWorkoutsFromIndoorJSON(obj));
        }
      }

      if (all.length === 0) {
        setError(
          "Found activity files but couldn’t parse any workouts. The export schema may differ.",
        );
        return;
      }

      setWorkouts(all);
      setDidParse(true);
      setLastImportMode("zip");
    } catch (e: unknown) {
      if (e instanceof Error) {
        setError(`Failed to read ZIP: ${e.message}`);
      } else {
        setError(`Failed to read ZIP: ${String(e)}`);
      }
    } finally {
      setIsLoading(false);
    }
  }

  function onParsePastedJson() {
    resetParsedState();
    const text = jsonInput.trim();
    if (!text) {
      setError("Paste a JSON object from a single MyWellness Training Workout page first.");
      return;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      const workout = extractWorkoutFromSinglePageJSON(parsed, jsonStartTime);
      if (!workout) {
        setError("Couldn’t find a supported single-workout payload in this JSON.");
        return;
      }

      setWorkouts([workout]);
      setZipName("mywellness-single-workout");
      setDidParse(true);
      setLastImportMode("json");
    } catch (e: unknown) {
      if (e instanceof Error) {
        setError(`Invalid JSON: ${e.message}`);
      } else {
        setError("Invalid JSON payload.");
      }
    }
  }

  async function downloadAllAsZip() {
    const zip = new JSZip();
    for (const w of sortedWorkouts) {
      const safeDate = safeDateToken(w.startedAtISO);
      if (exportFormat === "fit") {
        const fit = workoutToFIT(w, w.exportOpts, enhancedFitCompatibility);
        const fname = `mywellness-${w.source}-${safeDate}-${w.id}.fit`;
        zip.file(fname, fit);
      } else {
        const tcx = workoutToTCX(w, w.exportOpts);
        const fname = `mywellness-${w.source}-${safeDate}-${w.id}.tcx`;
        zip.file(fname, tcx);
      }
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const base = (zipName ?? "mywellness").replace(/\.zip$/i, "");
    downloadBlob(`${base}-${exportFormat}.zip`, blob);
  }

  function updateWorkoutOpts(
    w: Workout,
    patch: Partial<WorkoutExportOpts>
  ) {
    setWorkouts((prev) =>
      prev.map((x) =>
        x.uid === w.uid
          ? { ...x, exportOpts: { ...x.exportOpts, ...patch } }
          : x
      )
    );
  }

  const downloadButtonStyle: CSSProperties = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #3b82f6",
    background: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontWeight: 600,
  };

  const subtleText: CSSProperties = { fontSize: 13, opacity: 0.78, lineHeight: 1.4 };

  const thStyle: CSSProperties = {
    padding: "10px 8px",
    border: "1px solid #94a3b8",
    borderBottom: "2px solid #475569",
    background: "#f1f5f9",
    fontWeight: 700,
    fontSize: 13,
  };
  const tdStyle: CSSProperties = {
    padding: "8px 8px",
    verticalAlign: "middle",
  };
  const tdCenter: CSSProperties = { ...tdStyle, textAlign: "center" };
  const tdNoWrap: CSSProperties = { ...tdStyle, whiteSpace: "nowrap" };
  const tdValueRow: CSSProperties = { ...tdStyle, borderBottom: "none" };
  const tdValueRowCenter: CSSProperties = { ...tdCenter, borderBottom: "none" };
  const tdValueRowNoWrap: CSSProperties = { ...tdNoWrap, borderBottom: "none" };
  const tdCheck: CSSProperties = { ...tdStyle, padding: "6px 8px" };
  const tdCheckCenter: CSSProperties = { ...tdCheck, textAlign: "center" };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f1f5f9",
        color: "#0f172a",
      }}
    >
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 28, width: "100%" }}>
        <header style={{ marginTop: 6, position: "relative", paddingRight: 120 }}>
          <h1 style={{ margin: 0, fontSize: 42, letterSpacing: -0.5 }}>
            Technogym/MyWellness to TCX/FIT Converter
          </h1>

          <p style={{ marginTop: 10, ...subtleText, fontSize: 16 }}>
            Import data from Technogym/MyWellness and download <b>TCX or FIT files.</b>{" "}
            Upload a ZIP export or paste a single workout JSON payload.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ ...subtleText }}>✅ Runs locally</span>
            <span style={{ ...subtleText }}>✅ No account</span>
            <span style={{ ...subtleText }}>✅ Ignores all sensitive data</span>
          </div>

          <div
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              alignItems: "flex-end",
            }}
          >

            <a
              href={FEEDBACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: "6px 8px",
                borderRadius: 10,
                border: "1px solid #94a3b8",
                background: "#ffffff",
                color: "#0f172a",
                textDecoration: "none",
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              ❗ Issues
            </a>
            <a
              href="mailto:travis@polygon.com.au?subject=mywellness2tcx%20feedback"
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid #94a3b8",
                background: "#ffffff",
                color: "#0f172a",
                textDecoration: "none",
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              📩 Email me
            </a>


          </div>
        </header>





        {/* Hero upload */}
        <div
          style={{
            marginTop: 16,
            border: "1px dashed #94a3b8",
            borderRadius: 16,
            overflow: "hidden",
            background: "#f9fafb",
          }}
        >

          <div style={{ padding: "16px 16px" }}>
            <div style={{ ...subtleText, marginBottom: 6, fontWeight: 600, opacity: 1 }}>
              Select mode:
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{
                    ...downloadButtonStyle,
                    background: importMode === "json" ? "#3b82f6" : "#e2e8f0",
                    color: importMode === "json" ? "#ffffff" : "#64748b",
                    borderColor: importMode === "json" ? "#3b82f6" : "#cbd5e1",
                    opacity: importMode === "json" ? 1 : 0.75,
                    filter: importMode === "json" ? "none" : "saturate(0.7)",
                    fontWeight: importMode === "json" ? 700 : 600,
                  }}
                  onClick={() => setImportMode("json")}
                >
                  Paste JSON
                </button>
                <button
                  type="button"
                  style={{
                    ...downloadButtonStyle,
                    background: importMode === "zip" ? "#3b82f6" : "#e2e8f0",
                    color: importMode === "zip" ? "#ffffff" : "#64748b",
                    borderColor: importMode === "zip" ? "#3b82f6" : "#cbd5e1",
                    opacity: importMode === "zip" ? 1 : 0.75,
                    filter: importMode === "zip" ? "none" : "saturate(0.7)",
                    fontWeight: importMode === "zip" ? 700 : 600,
                  }}
                  onClick={() => setImportMode("zip")}
                >
                  Upload ZIP
                </button>
              </div>
              <div style={{ ...subtleText }}>
                Best use: JSON for one detailed workout; ZIP for bulk exports.
              </div>
            </div>

            {importMode === "zip" ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const f = e.dataTransfer.files?.[0] ?? null;
                  void onZipSelected(f);
                }}
                role="button"
                tabIndex={0}
              >
                <div style={{ fontWeight: 700, fontSize: 16 }}>Upload Technogym/MyWellness ZIP</div>
                <div style={{ marginTop: 8, ...subtleText }}>
                  Drag and drop your export <code>.zip</code> here, or click to browse.
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  style={{ display: "none" }}
                  onChange={(e) => void onZipSelected(e.target.files?.[0] ?? null)}
                />

                {!zipName && !isLoading && !error && (
                  <div style={{ marginTop: 14, ...subtleText }}>
                    Reads only{" "}
                    <code style={{ backgroundColor: "#dbe2ee" }}>indooractivities-*.json</code>.
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>Paste Single Workout JSON</span>
                  <button
                    type="button"
                    onClick={() => setShowJsonHelp((v) => !v)}
                    aria-expanded={showJsonHelp}
                    aria-controls="json-help-panel"
                    title="How to get JSON from browser"
                    style={{
                      border: "1px solid #94a3b8",
                      background: "#ffffff",
                      color: "#0f172a",
                      borderRadius: 999,
                      width: 22,
                      height: 22,
                      lineHeight: "20px",
                      padding: 0,
                      textAlign: "center",
                      cursor: "pointer",
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    ?
                  </button>
                </div>
                <div style={{ marginTop: 8, ...subtleText }}>
                  Paste the JSON payload copied from a MyWellness Training Workout page, then parse it.
                </div>
                {showJsonHelp && (
                  <div
                    id="json-help-panel"
                    style={{
                      marginTop: 10,
                      padding: 12,
                      border: "1px solid #94a3b8",
                      borderRadius: 10,
                      background: "#ffffff",
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>How to get the workout JSON</div>
                    <ol style={{ margin: "0 0 0 18px", padding: 0, ...subtleText }}>
                      <li>Open your workout detail page in MyWellness on desktop.</li>
                      <li>Press F12 to open Developer Tools.</li>
                      <li>Go to the Network tab and reload the page.</li>
                      <li>Filter for XHR/Fetch and click the workout details request.</li>
                      <li>Open the Response tab, copy the full JSON, and paste it here.</li>
                    </ol>
                  </div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label htmlFor="json-start-time" style={{ ...subtleText, fontWeight: 600, opacity: 1 }}>
                    Workout start time:
                  </label>
                  <input
                    id="json-start-time"
                    type="time"
                    step={1}
                    value={jsonStartTime}
                    onChange={(e) => setJsonStartTime(e.target.value)}
                    style={{
                      borderRadius: 8,
                      border: "1px solid #94a3b8",
                      padding: "6px 8px",
                      background: "#ffffff",
                      color: "#0f172a",
                    }}
                  />
                  <span style={subtleText}>Date comes from JSON; time comes from this field.</span>
                </div>
                <textarea
                  value={jsonInput}
                  onChange={(e) => setJsonInput(e.target.value)}
                  placeholder='{"data":{...}}'
                  style={{
                    marginTop: 10,
                    width: "100%",
                    minHeight: 180,
                    borderRadius: 10,
                    border: "1px solid #94a3b8",
                    padding: 10,
                    fontFamily: "Consolas, monospace",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                />
                <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                  <button type="button" style={downloadButtonStyle} onClick={onParsePastedJson}>
                    Process Workout
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowJsonHelp(true)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#1d4ed8",
                      cursor: "pointer",
                      textDecoration: "underline",
                      padding: 0,
                      fontSize: 13,
                    }}
                  >
                    How to get this JSON?
                  </button>
                  <span style={subtleText}>Supports one workout per paste.</span>
                </div>
              </div>
            )}

            {zipName && !error && lastImportMode === "zip" && (
              <div style={{ marginTop: 14, fontSize: 14 }}>
                <b>Loaded:</b> {zipName} — <b>{sortedWorkouts.length}</b>{" "}
                workout{sortedWorkouts.length === 1 ? "" : "s"} detected
              </div>
            )}

            {isLoading && <div style={{ marginTop: 14 }}>Reading ZIP…</div>}
            {error && (
              <div
                style={{
                  marginTop: 14,
                  padding: 12,
                  background: "rgba(255, 0, 0, 0.12)",
                  border: "1px solid rgba(255, 100, 100, 0.35)",
                  borderRadius: 12,
                }}
              >
                <b>Error:</b> {error}
              </div>
            )}
          </div>
        </div>

        {/* Parsed summary + Table */}
        {didParse && sortedWorkouts.length > 0 && !error && (
          <div style={{ marginTop: 16, border: "1px solid #94a3b8", borderRadius: 16, overflow: "hidden", background: "#f9fafb" }}>
            {/* Summary section */}
            <div style={{ padding: "16px 16px" }}>
              <div style={{ padding: "8px 8px", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Detected workouts</div>
                  <div style={subtleText}>
                    Total: <b>{sortedWorkouts.length}</b>
                  </div>
                </div>
                <div style={subtleText}>
                  Total time: <b>{formatDuration(summary.totalSec)}</b>
                  {" • "}
                  Distance: <b>{summary.totalDistM > 0 ? `${(summary.totalDistM / 1000).toFixed(2)} km` : "—"}</b>
                  {" • "}
                  Vertical: <b>{summary.totalVertM > 0 ? `${summary.totalVertM.toFixed(0)} m` : "—"}</b>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", ...subtleText, opacity: 1 }}>
                      <span style={{ fontWeight: 600 }}>Format:</span>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="radio"
                          name="export-format"
                          checked={exportFormat === "tcx"}
                          onChange={() => setExportFormat("tcx")}
                        />
                        TCX
                      </label>
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <input
                          type="radio"
                          name="export-format"
                          checked={exportFormat === "fit"}
                          onChange={() => setExportFormat("fit")}
                        />
                        FIT
                      </label>
                    </div>
                    {exportFormat === "fit" && (
                      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, ...subtleText }}>
                        <input
                          type="checkbox"
                          checked={enhancedFitCompatibility}
                          onChange={(e) => setEnhancedFitCompatibility(e.target.checked)}
                        />
                        Enhanced FIT compatibility (experimental)
                      </label>
                    )}
                  </div>
                  {lastImportMode === "zip" && (
                    <button
                      style={{
                        ...downloadButtonStyle,
                        opacity: sortedWorkouts.length ? 1 : 0.5,
                      }}
                      disabled={!sortedWorkouts.length}
                      onClick={() => void downloadAllAsZip()}
                      title={`Download all workouts as a single ZIP of ${exportFormat.toUpperCase()} files`}
                    >
                      Download all as ZIP ({exportFormat.toUpperCase()})
                    </button>
                  )}
                </div>
                {lastImportMode === "zip" && (
                  <div style={{ marginTop: 8, fontSize: 14 }}>
                    <span>
                      <b>Note: </b>The MyWellness zip export only provides total workout values, so per-trackpoint data is estimated from averages.
                    </span>
                  </div>
                )}
              </div>

            </div>



            {/* Table section */}
            <div style={{ overflowX: "auto", padding: "0px 16px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    <th style={thStyle}>
                      Date
                    </th>
                    <th style={thStyle}>
                      Activity
                    </th>
                    <th style={thStyle}>
                      Duration
                    </th>
                    <th style={thStyle}>
                      Type
                    </th>
                    <th style={thStyle}>Distance</th>
                    <th style={thStyle}>HR</th>
                    <th style={thStyle}>Power</th>
                    <th style={thStyle}>Cadence</th>

                    <th style={thStyle}>Calories</th>
                    <th style={thStyle}>Vertical</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedWorkouts.map((w) => (
                    <Fragment key={w.uid}>
                      <tr>
                        <td style={tdValueRow}>
                          {w.startedAtDisplay}
                        </td>
                        <td style={tdValueRow}>
                          {w.activityName}
                        </td>
                        <td style={tdValueRow}>
                          {formatDuration(w.durationSec)}
                        </td>
                        <td style={tdValueRow}>
                          Machine
                        </td>

                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.distanceM != null ? `${(w.distanceM / 1000).toFixed(2)} km` : "—"}
                          </div>
                        </td>
                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.metrics["AvgHr"] != null
                              ? Math.round(w.metrics["AvgHr"]) + " bpm"
                              : w.metrics["MaxHr"] != null
                                ? Math.round(w.metrics["MaxHr"]) + " bpm"
                                : "—"}
                          </div>
                        </td>
                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.metrics["AvgPower"] != null ? Math.round(w.metrics["AvgPower"]) + " W" : "—"}
                          </div>
                        </td>
                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.metrics["AvgSpm"] != null
                              ? Math.round(w.metrics["AvgSpm"]) + " spm"
                              : w.cadenceSpm != null
                                ? Math.round(w.cadenceSpm) + " spm"
                                : "—"}
                          </div>
                        </td>

                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.calories != null ? Math.round(w.calories) : "—"}
                          </div>
                        </td>

                        <td style={tdValueRowCenter}>
                          <div style={{ ...subtleText }}>
                            {w.verticalM != null ? `${w.verticalM.toFixed(1)} m` : "—"}
                          </div>
                        </td>

                        <td style={tdValueRowNoWrap}>
                          <button
                            style={{ ...downloadButtonStyle, whiteSpace: "nowrap" }}
                            onClick={() => {
                              const safeDate = safeDateToken(w.startedAtISO);
                              if (exportFormat === "fit") {
                                const fit = workoutToFIT(w, w.exportOpts, enhancedFitCompatibility);
                                const fname = `mywellness-${w.source}-${safeDate}-${w.id}.fit`;
                                downloadBlob(fname, new Blob([fit], { type: "application/octet-stream" }));
                              } else {
                                const tcx = workoutToTCX(w, w.exportOpts);
                                const fname = `mywellness-${w.source}-${safeDate}-${w.id}.tcx`;
                                downloadTextFile(fname, tcx);
                              }
                            }}
                          >
                            Download {exportFormat.toUpperCase()}
                          </button>
                        </td>
                      </tr>

                      <tr style={{ background: "#f8fafc" }}>
                        <td style={tdCheck}></td>
                        <td style={tdCheck}></td>
                        <td style={tdCheck}></td>
                        <td style={tdCheck}></td>

                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includeDistance}
                            disabled={w.distanceM == null}
                            onChange={(e) => updateWorkoutOpts(w, { includeDistance: e.target.checked })}
                            aria-label={`Include Distance for ${w.id}`}
                          />
                        </td>

                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includeHrSeries}
                            disabled={w.metrics["AvgHr"] == null && w.metrics["MaxHr"] == null}
                            onChange={(e) => updateWorkoutOpts(w, { includeHrSeries: e.target.checked })}
                            aria-label={`Include HR for ${w.id}`}
                          />
                        </td>

                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includePowerSeries}
                            disabled={w.metrics["AvgPower"] == null}
                            onChange={(e) => updateWorkoutOpts(w, { includePowerSeries: e.target.checked })}
                            aria-label={`Include Power for ${w.id}`}
                          />
                        </td>

                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includeCadenceSeries}
                            disabled={w.metrics["AvgSpm"] == null && w.metrics["Move"] == null && w.cadenceSpm == null}
                            onChange={(e) => updateWorkoutOpts(w, { includeCadenceSeries: e.target.checked })}
                            aria-label={`Include Cadence for ${w.id}`}
                          />
                        </td>



                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includeCalories}
                            disabled={w.calories == null && w.metrics["Calories"] == null}
                            onChange={(e) => updateWorkoutOpts(w, { includeCalories: e.target.checked })}
                            aria-label={`Include Calories for ${w.id}`}
                          />
                        </td>

                        <td style={tdCheckCenter}>
                          <input
                            type="checkbox"
                            checked={w.exportOpts.includeVerticalAsAltitude}
                            disabled={w.verticalM == null}
                            onChange={(e) => updateWorkoutOpts(w, { includeVerticalAsAltitude: e.target.checked })}
                            aria-label={`Include Vertical as Altitude for ${w.id}`}
                          />
                        </td>

                        <td style={tdCheck}></td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>

            </div>
          </div>
        )}

        {/* Footer */}
        <footer style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid #cbd5e1", ...subtleText }}>
          <div>
            Privacy: processed locally in your browser. This tool reads only workout data and ignores biometric/private information.
          </div>
          <div style={{ marginTop: 6 }}>
            Not affiliated with Technogym, MyWellness or Garmin.
          </div>

        </footer>
      </div>
    </div>
  );
}
