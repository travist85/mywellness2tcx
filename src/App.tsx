import { useMemo, useRef, useState } from "react";
import JSZip from "jszip";

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

  raw: any;
};

function safeNumber(v: any): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
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

function prToMap(raw: any): Record<string, number> {
  const out: Record<string, number> = {};

  const pr =
    raw?.performedData?.pr ??
    raw?.physicalActivityData?.pr ??
    raw?.performedData?.PR ??
    raw?.physicalActivityData?.PR;

  if (!Array.isArray(pr)) return out;

  for (const item of pr) {
    const name = item?.n;
    const val = safeNumber(item?.v);
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

function workoutToTCX(w: Workout, opts: WorkoutExportOpts): string {
  const startISO =
    (typeof w.startedAtISO === "string" && w.startedAtISO) ||
    w.raw?.on ||
    w.raw?.performedDate ||
    new Date().toISOString();

  const start = new Date(startISO);
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

  // Trackpoints every 5 seconds (Strava-friendly)
  const step = 5;
  const n =
    totalSeconds > 0 ? Math.max(2, Math.floor(totalSeconds / step) + 1) : 2;

  const points: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(totalSeconds, i * step);
    const time = new Date(start.getTime() + t * 1000).toISOString();

    // HR: export as constant AvgHr (explicitly approximate)
    const hr =
      opts.includeHrSeries && avgHr != null && maxHr != null
        ? Math.round(avgHr)
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

function extractWorkoutsFromIndoorJSON(obj: any): Workout[] {

  const items = Array.isArray(obj) ? obj : [];
  return items.map((raw: any, idx: number) => {
    const metrics = prToMap(raw);
    const startedAt = raw?.on;
    const durationSec = metrics["Duration"];
    const calories = metrics["Calories"];
    const distanceM = pickDistanceM(metrics);
    const verticalM = pickVerticalM(metrics);
    const cadenceSpm = pickCadenceSpm(metrics);

    // Best-effort naming (improve later using facility metadata if present)
    const activityName =
      raw?.activityName ||
      (verticalM != null ? "Stair climber" : "Indoor workout");

    const id = String(raw?.id ?? `${startedAt ?? "ind"}-${idx}`);

    return {
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

function extractWorkoutsFromOutdoorJSON(obj: any): Workout[] {
  const items = Array.isArray(obj)
    ? obj
    : (obj?.items ?? obj?.activities ?? obj?.data ?? []);
  if (!Array.isArray(items)) return [];

  return items.map((raw: any, idx: number) => {
    const metrics = prToMap(raw);
    const durationSec =
      metrics["Duration"] ??
      safeNumber(raw?.duration) ??
      safeNumber(raw?.Duration);
    const calories =
      metrics["Calories"] ??
      safeNumber(raw?.calories) ??
      safeNumber(raw?.Calories);
    const distanceM = pickDistanceM(metrics);
    const verticalM = pickVerticalM(metrics);
    const cadenceSpm = pickCadenceSpm(metrics);

    const startedAt = raw?.performedDate ?? raw?.on;
    const activityName = raw?.activityName ?? "Outdoor workout";
    const id = String(raw?.id ?? raw?.uuid ?? `${startedAt ?? "out"}-${idx}`);

    return {
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

function computeSummary(ws: Workout[]) {
  const indoor = ws.filter((w) => w.source === "indoor").length;
  const outdoor = ws.filter((w) => w.source === "outdoor").length;
  const totalSec = ws.reduce((acc, w) => acc + (w.durationSec ?? 0), 0);
  const totalDistM = ws.reduce((acc, w) => acc + (w.distanceM ?? 0), 0);
  const totalVertM = ws.reduce((acc, w) => acc + (w.verticalM ?? 0), 0);
  return { indoor, outdoor, totalSec, totalDistM, totalVertM };
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zipName, setZipName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [didParse, setDidParse] = useState(false);

  const sortedWorkouts = useMemo(() => {
    return [...workouts].sort((a, b) => {
      const ta = a.startedAtISO ? new Date(a.startedAtISO).getTime() : 0;
      const tb = b.startedAtISO ? new Date(b.startedAtISO).getTime() : 0;
      return tb - ta;
    });
  }, [workouts]);

  const summary = useMemo(() => computeSummary(sortedWorkouts), [sortedWorkouts]);

  async function onZipSelected(file: File | null) {
    setError(null);
    setWorkouts([]);
    setZipName(null);
    setDidParse(false);

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
      // Only parse indooractivities* and outdooractivities*.
      // Ignore masterdata* and biometrics* entirely.
      const fileEntries = Object.keys(zip.files);

      const targetNames = fileEntries.filter((n) => {
        const lower = n.toLowerCase();
        return (
          (lower.startsWith("indooractivities-") ||
            lower.startsWith("outdooractivities-")) &&
          lower.endsWith(".json")
        );
      });

      if (targetNames.length === 0) {
        setError(
          "Could not find indooractivities-*.json or outdooractivities-*.json in this ZIP. Make sure it’s a full MyWellness export.",
        );
        return;
      }

      const all: Workout[] = [];

      for (const name of targetNames) {
        const lower = name.toLowerCase();
        const text = await zip.files[name].async("string");
        let obj: any;
        try {
          obj = JSON.parse(text);
        } catch {
          continue;
        }

        if (lower.startsWith("indooractivities-")) {
          all.push(...extractWorkoutsFromIndoorJSON(obj));
        } else if (lower.startsWith("outdooractivities-")) {
          all.push(...extractWorkoutsFromOutdoorJSON(obj));
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
    } catch (e: any) {
      setError(`Failed to read ZIP: ${e?.message ?? String(e)}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function downloadAllAsZip() {
    const zip = new JSZip();
    for (const w of sortedWorkouts) {
      const tcx = workoutToTCX(w, w.exportOpts);
      const safeDate = (w.startedAtISO ? new Date(w.startedAtISO) : new Date())
        .toISOString()
        .replace(/[:]/g, "")
        .replace(/\..+/, "Z");
      const fname = `mywellness-${w.source}-${safeDate}-${w.id}.tcx`;
      zip.file(fname, tcx);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const base = (zipName ?? "mywellness").replace(/\.zip$/i, "");
    downloadBlob(`${base}-tcx.zip`, blob);
  }

  function updateWorkoutOpts(
    w: Workout,
    patch: Partial<WorkoutExportOpts>
  ) {
    setWorkouts((prev) =>
      prev.map((x) =>
        x.source === w.source && x.id === w.id
          ? { ...x, exportOpts: { ...x.exportOpts, ...patch } }
          : x
      )
    );
  }

  const cardStyle: any = {
    border: "1px solid #94a3b8 !important",
    borderRadius: 16,
    background: "#f9fafb !important",
    padding: 18,
  };

  const downloadButtonStyle: any = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #3b82f6 !important",
    background: "#3b82f6 !important",
    color: "#ffffff !important",
    cursor: "pointer",
    fontWeight: 600,
  };

  const subtleText: any = { fontSize: 13, opacity: 0.78, lineHeight: 1.4 };

  const thStyle: any = {
    padding: "10px 8px",
    border: "1px solid #94a3b8 !important",
    borderBottom: "2px solid #475569 !important",
    background: "#f1f5f9 !important",
    fontWeight: 700,
    fontSize: 13,
  };
  const tdStyle: any = {
    padding: "8px 8px",
    verticalAlign: "middle",
  };
  const tdCenter: any = { ...tdStyle, textAlign: "center !important" };
  const tdNoWrap: any = { ...tdStyle, whiteSpace: "nowrap" };
  const tdValueRow: any = { ...tdStyle, borderBottom: "none !important" };
  const tdValueRowCenter: any = { ...tdCenter, borderBottom: "none !important" };
  const tdValueRowNoWrap: any = { ...tdNoWrap, borderBottom: "none !important" };
  const tdCheck: any = { ...tdStyle, padding: "6px 8px" };
  const tdCheckCenter: any = { ...tdCheck, textAlign: "center !important" };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f1f5f9 !important",
        color: "#0f172a",
      }}
    >
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: 28 }}>
        <header style={{ marginTop: 6 }}>
          <h1 style={{ margin: 0, fontSize: 42, letterSpacing: -0.5 }}>
            Convert MyWellness Workouts to TCX Files
          </h1>
          <p style={{ marginTop: 10, ...subtleText, fontSize: 16 }}>
            Upload your <b>Mywellness ZIP export</b> and download{" "}
            <b>TCX files.</b> Runs entirely in your browser —{" "}
            <b>no login</b>, <b>no uploads</b>.
          </p>
        </header>

        {/* Hero upload */}
        <div style={{ display: "grid", border: "1px solid #94a3b8", borderWidth: 2, borderStyle: "dashed", borderRadius: 12, gridTemplateColumns: "1fr", gap: 16, marginTop: 18, background: "#f9fafb" }}>
          <div
            style={{
              ...cardStyle,
              padding: 22,
            }}
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
            <div
              style={{

                fontWeight: 700,
                fontSize: 16
              }}>
              Upload Mywellness ZIP
            </div>
            <div style={{ marginTop: 8, ...subtleText }}>
              Drag & drop your export <code>.zip</code> here, or click to browse (export zip file from MyWellness Account Settings)
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              style={{ display: "none" }}
              onChange={(e) => void onZipSelected(e.target.files?.[0] ?? null)}
            />

            <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
              <span style={{ ...subtleText }}>✅ Runs locally</span>
              <span style={{ ...subtleText }}>✅ No account</span>
              <span style={{ ...subtleText }}>
                ✅ Ignores all sensitive data
              </span>
            </div>

            {zipName && !error && (
              <div style={{ marginTop: 14, fontSize: 14 }}>
                <b>Loaded:</b> {zipName} — <b>{sortedWorkouts.length}</b>{" "}
                workouts detected
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

            {!zipName && !isLoading && !error && (
              <div style={{ marginTop: 14, ...subtleText }}>
                This tool reads <b>only</b> {" "}
                <code style={{ backgroundColor: "#dbe2ee" }}>indooractivities-*.json</code> and {" "}
                <code style={{ backgroundColor: "#dbe2ee" }}>outdooractivities-*.json</code>
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
                    Indoor: <b>{summary.indoor}</b> • Outdoor: <b>{summary.outdoor}</b> • Total:{" "}
                    <b>{sortedWorkouts.length}</b>
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
                  <button
                    style={{
                      ...downloadButtonStyle,
                      opacity: sortedWorkouts.length ? 1 : 0.5,
                    }}
                    disabled={!sortedWorkouts.length}
                    onClick={() => void downloadAllAsZip()}
                    title="Download all workouts as a single ZIP of TCX files"
                  >
                    Download all as ZIP
                  </button>
                </div>
                <div style={{ marginTop: 8, fontSize: 14 }}>
                  <span style={{}}>
                    <b>Note: </b>The MyWellness zip export only provides total workout values, so per-trackpoint data is estimated from averages.
                  </span>
                </div>
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
                      Source
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
                    <>
                      <tr key={`${w.source}-${w.id}-values`}>
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
                          {w.source}
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
                              const tcx = workoutToTCX(w, w.exportOpts);
                              const safeDate = (w.startedAtISO ? new Date(w.startedAtISO) : new Date())
                                .toISOString()
                                .replace(/[:]/g, "")
                                .replace(/\..+/, "Z");
                              const fname = `mywellness-${w.source}-${safeDate}-${w.id}.tcx`;
                              downloadTextFile(fname, tcx);
                            }}
                          >
                            Download TCX
                          </button>
                        </td>
                      </tr>

                      <tr key={`${w.source}-${w.id}-checks`} style={{ background: "#f8fafc !important" }}>
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
                    </>
                  ))}
                </tbody>
              </table>

            </div>
          </div>
        )}

        {/* Footer */}
        <footer style={{ marginTop: 22, paddingTop: 14, borderTop: "1px solid #cbd5e1 !important", ...subtleText }}>
          <div>
            Privacy: processed locally in your browser. This tool reads only the activity JSON files and ignores biometrics/masterdata.
          </div>
          <div style={{ marginTop: 6 }}>
            Not affiliated with Technogym, MyWellness or Garmin.
          </div>
        </footer>
      </div>
    </div>
  );
}
