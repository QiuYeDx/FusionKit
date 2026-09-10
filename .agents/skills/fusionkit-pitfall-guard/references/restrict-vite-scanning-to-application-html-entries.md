# FK-PIT-0124: Restrict Vite scanning to application HTML entries

## Area
Vite / development dependency optimization

## Triggers
Failed to scan for dependencies, Unexpected semicolon, stage-listening-review.html, generated reports, release HTML.

## Symptoms
pnpm dev scans HTML under scripts, release, build and test-results. A generator template with const data=/* STAGE_DATA */; fails dependency scanning.

## Root cause
Without explicit optimizeDeps.entries, Vite discovers unrelated HTML across the repository. Build output success and a warm dependency cache can hide this development-only path.

## Do
Set optimizeDeps.entries to the real application index.html. Keep templates unchanged for their generators. Verify pnpm dev with --force and vite:deps diagnostics; check both the exact entry list and successful scan/prebundle completion.

## Avoid
Do not rewrite template placeholders as dummy data, delete reports, suppress scan errors, or claim vite build proves development scanning works.

## Validation
The dependency crawl lists only the application entry and completes without the reported parsing error. Run the Electron dev workflow, then stop all validation-owned services.

## Related files
- vite.config.ts
- scripts/local-subtitle/benchmark/stage-listening-review.html
- docs/features/subtitle-studio/records/2026-09-11-development-startup-fix.md
