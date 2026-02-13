Project: mywellness-to-tcx — Copilot instructions

This repo is a small client-side React + TypeScript app (Vite) that converts MyWellness ZIP exports
into TCX files entirely in the browser. The goal of these instructions is to give AI coding agents
just the project-specific knowledge needed to be productive quickly.

- Quick summary:
  - Single-page React app under `src/` that reads a user ZIP, parses MyWellness JSON, and produces TCX.
  - No backend: all processing, downloads and privacy guarantees are implemented client-side.
  - Key logic and parsing lives in `src/App.tsx` (`workoutToTCX`, parsers, ZIP handling).

- Key files to inspect first:
  - [src/App.tsx](src/App.tsx#L1-L120) — helpers, types, TCX generation (`workoutToTCX`).
  - [src/App.tsx](src/App.tsx#L120-L360) — JSON -> Workout extraction helpers (`extractWorkoutsFromIndoorJSON`, `extractWorkoutsFromOutdoorJSON`).
  - [src/App.tsx](src/App.tsx#L360-L800) — UI, ZIP processing (`onZipSelected`) and download helpers.
  - [package.json](package.json#L1-L80) — scripts: `dev`, `build` (`tsc -b && vite build`), `preview`, `lint`.
  - [vite.config.ts](vite.config.ts#L1-L40) — Vite + React plugin.
  - [tsconfig.app.json](tsconfig.app.json#L1-L60) — strict TypeScript settings; `noEmit: true` (type-checks before build).

- Build & dev workflows (explicit):
  - Start the dev server: `npm run dev` (uses Vite, HMR enabled).
  - Build for production: `npm run build` (runs `tsc -b` for type checking, then `vite build`).
  - Preview production build: `npm run preview`.
  - Lint: `npm run lint`.

- Project-specific conventions & patterns:
  - Privacy-by-design: the app intentionally only reads `indooractivities-*.json` and `outdooractivities-*.json` from ZIPs. Do not change this behavior unless the user asks.
    - See the file filtering logic in `onZipSelected` in [src/App.tsx](src/App.tsx#L360-L420).
  - Metrics parsing: MyWellness uses inconsistent keys. Central helpers normalize them: `prToMap`, `pickDistanceM`, `pickVerticalM`, `pickCadenceSpm` in `src/App.tsx`.
  - TCX generation: `workoutToTCX` creates synthetic trackpoints (5s step) and optionally includes HR/cadence/power depending on `WorkoutExportOpts`.
  - UI uses inline styles and a single-page layout; add components under `src/` and import them into `App.tsx`.
  - Types are defined locally (`Workout`, `WorkoutExportOpts`) — keep additions consistent with these shapes.

- External dependencies & integration points:
  - `jszip` (dependency) — used to read ZIP contents in the browser (see `onZipSelected`).
  - No network APIs or secrets; outputs are downloaded via Blob/anchor pattern (`downloadBlob`/`downloadTextFile`).
  - Strava integration is manual (link to Strava upload). No programmatic upload.

- Debugging notes and runtime checks:
  - There are no automated tests in the repo. To test, run `npm run dev` and open the app in a browser.
  - Useful places to add temporary logs: inside `onZipSelected`, `extractWorkoutsFrom*`, and `workoutToTCX`.
  - Runtime assumptions: many metrics are optional; guard for missing keys (see `safeNumber` and `prToMap`).

- When making changes:
  - If you modify types or add new files, ensure `tsconfig.app.json` still includes `src` and the project builds with `npm run build`.
  - If adding deps, update `package.json` and run `npm install` locally.
  - Preserve the privacy filter (only parse `indooractivities-*.json` and `outdooractivities-*.json`) unless the change explicitly expands supported file types.

- Small examples (use these code anchors when editing):
  - Add new export fields: extend `WorkoutExportOpts` at the top of `src/App.tsx` and update `workoutToTCX`.
  - Change ZIP file acceptance: modify the name filtering in `onZipSelected` in `src/App.tsx`.

If anything in these instructions is unclear or you want more detail on a specific area (parsing, TCX schema, or build nuances), tell me which section to expand. Please review and suggest edits.
