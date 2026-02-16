# Resume Checklist

## Quick startup
1. Open `src/App.tsx`.
2. Run:
- `npm run -s lint`
- `npm run -s build`
- `npm run -s validate:fit`

## Current priority
- Resolve Garmin HR chart sparsity/gaps in FIT exports.

## Suggested immediate steps
1. Add temporary diagnostics inside FIT export path.
2. Generate FIT from the provided real workout JSON.
3. Confirm whether HR is written on most/all record messages.
4. If yes, investigate Garmin interpretation.
5. If no, fix interpolation-to-record mapping.

## Cleanup before shipping
- Remove temporary diagnostics.
- Keep/update docs under `docs/` with final root cause + fix.
