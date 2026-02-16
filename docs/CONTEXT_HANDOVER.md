# Context Handover

Last updated: 2026-02-16

## Project
- Tool: Technogym/MyWellness to TCX/FIT converter (React + Vite + TypeScript)
- Main file: `src/App.tsx`

## Recent feature additions
- Added single-workout JSON paste flow alongside ZIP import.
- Added FIT export alongside TCX export.
- Added an "Enhanced FIT compatibility" option with extra FIT messages/fields for broader platform compatibility.
- Added start-time input for pasted JSON workouts.
- Updated UI copy to reference Technogym/MyWellness and TCX/FIT.
- Adjusted UI behavior for JSON mode (hide non-applicable ZIP-specific labels/actions).

## Validation tooling
- Added FIT validation script: `scripts/validate-fit.mjs`
- npm script: `npm run -s validate:fit`
- Lint/build/fit-validation were passing at last check.

## Active debugging thread
- Symptom reported by user: Garmin charts show HR with visible gaps/spikes in generated FIT (especially in enhanced mode).
- Implemented additional hardening:
- JSON parser now interpolates HR onto every series point (not only exact timestamp matches).
- FIT writer now defensively forward-fills missing HR values when HR export is enabled.
- Added DEV console diagnostic: `[FIT HR] ... records=... withHr=...`.
- Next: user re-test with real Garmin import to confirm sparse-HR graph issue is resolved.

## Key risk
- JSON has many HR points but not one per second; if interpolation or timestamp alignment is off, imported charts can appear sparse.
