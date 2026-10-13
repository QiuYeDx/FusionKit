# FK-PIT-0195: Scope dialog scroll rules to their own viewport

## Area

Frontend / Studio dialogs / Radix ScrollArea.

## Triggers

- A list inside a dialog (for example the selected documents in batch translation) has an unusually
  wide inset around its rows.
- A nested ScrollArea shows extra top and bottom borders.

## Root cause

Dialog styles such as `.studio-translation-content [data-slot="scroll-area-viewport"] > div > div
{ padding: 12px }` and ScrollableDialogContent's `[&_[data-radix-scroll-area-viewport]]:border-t` used
descendant selectors. They meant the dialog's own viewport but also matched every ScrollArea nested in
the dialog content.

## Do

- Use child selectors for a component's own viewport:
  `.x > [data-slot="scroll-area-viewport"] > div > div`, `[&>[data-radix-scroll-area-viewport]]`.

## Avoid

- Do not reach into Radix internals with descendant selectors when the content can contain another
  instance of the same component.

## Validation

Open batch translation with several documents and expand "已选文档": rows sit 4px from the card edge
with no extra border inside.

## Related files

- `src/pages/Tools/Subtitle/SubtitleStudio/*.css`
- `src/components/qiuye-ui/scrollable-dialog.tsx`
