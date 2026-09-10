# FK-PIT-0123: Isolate unreadable documents during library startup

## Area
Subtitle Studio / persistence / Electron startup

## Triggers
pnpm dev, document_unavailable, historical schema, import button does nothing, cached rejected initialization.

## Symptoms
One unreadable historical document makes the whole library fail. Clicking import never calls the native dialog because every IPC method awaits initialization.

## Root cause
Library enumeration throws on a single document, and TranslationService retains the rejected initialization Promise forever. Empty disposable profiles and production builds alone do not cover an existing development profile.

## Do
Report per-document recovery failures separately from usable documents. Keep failed documents and published pointers intact; direct reads must still reject. Preserve repository-wide failures. Coalesce in-flight initialization but release a failed attempt so an explicit retry can recover. Validate a real dev renderer with a synthetic incompatible document and a read-only copy of relevant user data when available.

## Avoid
Do not silently delete old documents, invent an empty replacement, promote orphan generations, guess a migration, or clear a real profile to obtain passing evidence. Do not mistake a missing optional digest for a digest mismatch.

## Validation
Repository and IPC tests must cover healthy plus unreadable documents, unusable root storage, import and restart, preserved failed files, and initialization retry. Run development-ui.test.ts against an actual pnpm dev server; distinguish controlled OS-dialog responses from native dialog interaction.

## Related files
- electron/main/subtitle-studio/document-repository.ts
- electron/main/subtitle-studio/translation-service.ts
- test/subtitle-studio/development-ui.test.ts
- docs/features/subtitle-studio/records/2026-09-11-development-startup-fix.md
