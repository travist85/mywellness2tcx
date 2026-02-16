# FIT HR Investigation Notes

Last updated: 2026-02-16

## User-observed behavior
- Garmin import shows HR with missing segments / thin vertical spikes.
- User reports this persists after recent fixes and with Enhanced FIT enabled.

## What we know from source JSON
- `analitics.samples`: dense timeline (~1 Hz through ~1803s).
- `analitics.hr`: many points, but sparse/irregular relative to samples.
- Therefore: source does NOT have HR at every second, but does have plenty of anchor points.

## Current code direction
- Build HR anchors from series points where `p.hr != null`.
- Interpolate HR for each FIT record timestamp.
- Avoid inserting overall average HR as per-point fallback when series mode is active.

## Latest change (2026-02-16)
- In JSON extraction, interpolate HR to all series points using `analitics.hr` anchors.
- In FIT export, apply defensive HR forward-fill when HR series export is enabled.
- Added DEV diagnostic log: record count vs records containing HR.

## Next checks to implement
1. Instrument export with counters:
- total FIT records
- HR anchor count
- records with HR value written
- first/last HR timestamp

2. Add an optional debug dump in dev mode:
- first 20 record timestamps with HR
- random middle slice
- last 20

3. Re-run and confirm near-100% `records with HR` when HR series is present.

4. If still sparse after verification:
- inspect FIT message field encoding for HR (record message definition / field id/type usage)
- compare enhanced vs non-enhanced output record payloads
