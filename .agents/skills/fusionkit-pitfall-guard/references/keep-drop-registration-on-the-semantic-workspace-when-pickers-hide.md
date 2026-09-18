# FK-PIT-0162: Keep drop registration on the semantic workspace when pickers hide

## Area

Frontend / responsive file import

## Triggers

drag drop,hidden picker,narrow window,forceMount,ToolFileDropScope

## Symptoms

A responsive hidden picker must not unregister an otherwise active file importer; attach its marker to the visible semantic workspace and disable inactive modes explicitly.

## Root cause

The page-wide drop registry excludes DOM targets with no rendered bounds. Subtitle Studio hides its upload picker below 1024px after opening a document, while its import command remains available. Registering the picker therefore removes the active importer in that state. Conversely, a force-mounted inactive tab must not retain import ownership merely because its component still exists.

## Do

Put the drop marker on the semantic workspace that remains visible while import is available. For Studio documents this is `ClipPathTabsContent`, with `enabled: workspaceView === 'documents'`. Continue filtering hidden targets; keep busy targets registered with `disabled` so multiple importers cannot redirect files into one another.

## Avoid

Do not attach registration only to a responsive picker or exempt all hidden targets from visibility checks. Do not equate an inactive mode with a temporarily busy importer.

## Validation

Check the document mode before and after import below 1024px, where the picker disappears; a drop on the title or preview must still reach subtitle import. Switch to transcription and verify only media import receives the drop. Check modal and busy states reject it without invoking either bridge.

## Related files

- `src/pages/Tools/_shared/ui/ToolFileDropScope.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/index.tsx`
- `src/pages/Tools/Subtitle/SubtitleStudio/studio.css`
- [Native File capture timing](capture-native-drop-authority-before-queuing-reader-work.md)
