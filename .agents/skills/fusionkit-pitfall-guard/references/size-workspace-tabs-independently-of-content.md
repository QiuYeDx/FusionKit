# Size workspace tabs independently of content

- Area: Frontend / shared tabs / workspace geometry
- Triggers: ClipPathTabs, w-fit, wide empty gutters, page shrinks after enqueue, measured indicator, short task filename

## Symptoms

A full tool workspace shrinks to its contents after a view switch or when long media names disappear. Long fixtures temporarily fill the viewport and hide the defect. A screenshot taken during the tab transition may also show an offset highlight.

## Root cause

ClipPathTabs defaults to a content-sized root. When it becomes the parent of an entire two-column workspace, max-width alone does not request the available width. Shared filename components in a flex row can similarly shrink-wrap and clip their tail. These are caller layout responsibilities.

## Do

Give the workspace tabs root explicit w-full while retaining the project's max width and side insets. Give filenames the available row space where needed. Check both empty and populated states before and after submission at the same viewport. Wait for finite indicator animations to settle before recording screenshots.

## Avoid

Do not globally change the shared tab defaults, pad the content with long sample text, hardcode a measured indicator offset, or treat one long-name screenshot as proof of all workspace widths.

## Validation

At the actual 1280×860 Electron window, compare layout bounds with the original document workspace: 32px side insets, stable width through empty/media/queue states. At 786×540, verify the picker and primary action are reachable and tabs do not cover the heading. Compare geometry and inspect screenshots after transitions settle.

## Related files

- src/components/qiuye-ui/clip-path-tabs.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/index.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.css
- test/subtitle-studio/transcription-ui.test.ts
