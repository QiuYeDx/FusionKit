# Join library refresh before opening a completed task document

- Area: Subtitle Studio / async document navigation
- Triggers: completed task, View subtitles, auto-refresh, revision_conflict, filtered library, page two

## Symptoms

A task reports completed, but its View subtitles button leaves the user in the queue with an unavailable-document message. It reproduces when document-created events are still refreshing the library or the result is excluded by search and newer documents.

## Root cause

The reader uses one exclusive operation flag for imports, refreshes and selection. Rejecting a new navigation immediately when the flag is set treats routine background refresh as a revision conflict. A completed task ID also does not grant document-read authority, and the first library page may not contain its result.

## Do

Cache an explicit settlement Promise whenever taking the reader operation. A user-requested task navigation joins the current operation, checks the mounted lifetime, then claims the reader synchronously. Discover the exact document through the main-controlled library, following bounded pages with appropriate filters; only then read that ID and change the view. Release the operation and settle waiters in finally.

## Avoid

Do not sleep for an arbitrary time, silently drop the click, invent authority from a task ID, select the first returned document, or remove the library's concurrency guard.

## Validation

The isolated Electron transcription UI test creates a real completed document, keeps an unrelated library search, and creates 21 newer documents to move the result beyond the first 20. A single click must open that exact 105-cue document and clear the search without retry. Preserve actual main/preload/registration/repository; synthetic transcription is not ASR evidence.

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- test/subtitle-studio/transcription-ui.test.ts
- docs/features/subtitle-studio/records/2026-09-12-transcription-ui.md
