# Technogym/MyWellness to TCX/FIT Converter

Browser-based converter for Technogym/MyWellness workout exports.

## Features
- Import a MyWellness ZIP export
- Paste a single workout JSON payload
- Export workouts as `TCX` or `FIT`
- Optional enhanced FIT compatibility mode
- Local-only processing (no upload required)

## Development
```bash
npm install
npm run dev
```

## Validation
```bash
npm run -s lint
npm run -s build
npm run -s validate:fit
```

## Documentation Maintenance Checklist
Update these files whenever behavior, UI wording, export logic, or known issues change:

- `docs/CONTEXT_HANDOVER.md`
- `docs/DECISIONS.md`
- `docs/FIT_HR_INVESTIGATION.md` (when FIT/HR work is touched)
- `docs/RESUME_CHECKLIST.md` (when workflow or priorities change)

Minimum update routine per meaningful change:

1. Add or update a decision entry in `docs/DECISIONS.md`.
2. Refresh active status and risks in `docs/CONTEXT_HANDOVER.md`.
3. If FIT/HR-related: update findings and next checks in `docs/FIT_HR_INVESTIGATION.md`.
4. Confirm `docs/RESUME_CHECKLIST.md` still reflects current next steps.
