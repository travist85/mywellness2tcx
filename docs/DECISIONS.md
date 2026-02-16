# Decisions Log

Last updated: 2026-02-16

## Purpose
Track key technical/product decisions so context survives chat/session resets.

## Format
- Date
- Decision
- Context
- Rationale
- Status (`active`, `superseded`, `experimental`)

---

## 2026-02-16
Decision: Support both ZIP import and single-workout JSON paste.
Context: MyWellness users may have either full export ZIPs or single workout JSON from web pages.
Rationale: Lowers friction and broadens usability.
Status: active

## 2026-02-16
Decision: Add FIT export alongside TCX export.
Context: Some platforms accept FIT more reliably and preserve richer semantics.
Rationale: Better interoperability and import success across tools.
Status: active

## 2026-02-16
Decision: Add "Enhanced FIT compatibility" toggle.
Context: Need closer behavior to Garmin-originated FIT files for downstream parsing.
Rationale: Allows extra FIT messages/fields while keeping a simpler baseline mode.
Status: experimental

## 2026-02-16
Decision: For pasted JSON workflow, hide ZIP-specific UI text/actions.
Context: Some labels and controls were misleading when only one workout is present.
Rationale: Avoid user confusion; reflect actual capabilities for JSON mode.
Status: active

## 2026-02-16
Decision: Add start-time input for pasted JSON workouts.
Context: Source JSON date exists but explicit workout start time is ambiguous/missing.
Rationale: Prevent incorrect midnight defaults and improve timestamp accuracy in exports.
Status: active

## 2026-02-16
Decision: Rebrand UI copy to "Technogym/MyWellness" and "TCX/FIT".
Context: Users may know machine brand (Technogym) more than platform name alone.
Rationale: Improves discoverability and user recognition while staying accurate.
Status: active

## 2026-02-16
Decision: Move "runs locally / no account / ignores sensitive data" trust badges above import panel.
Context: These guarantees apply to both ZIP and JSON workflows.
Rationale: Present shared trust signals once, in a globally relevant location.
Status: active

## 2026-02-16
Decision: Add independent FIT validation script (`validate:fit`).
Context: Need repeatable checks beyond manual platform import testing.
Rationale: Catch structural FIT issues early during development.
Status: active

## 2026-02-16
Decision: HR record generation should use series-derived values/interpolation, not average-HR fallback in series mode.
Context: Garmin charts showed unrealistic HR patterns and gaps.
Rationale: Preserve temporal HR shape from source anchors and avoid flat/incorrect substitutions.
Status: active (under verification)

## 2026-02-16
Decision: Interpolate HR during JSON series extraction and defensively fill HR in FIT record emission.
Context: Real-world Garmin imports still showed sparse HR spikes despite earlier interpolation logic.
Rationale: Ensure per-record HR continuity even when source anchors are irregular or partially aligned.
Status: active (awaiting user verification)

---

## Open Decisions
- Should Enhanced FIT remain default-on or default-off?
- Should TCX/FIT selector stay radio, segmented control, or toggle?
- Should we expose a user-facing export diagnostics panel (record count, HR coverage) for troubleshooting?
