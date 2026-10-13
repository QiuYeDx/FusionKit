# FK-PIT-0194: Keep nova Popover and Tooltip content in block layout

## Area

Frontend / shadcn/ui radix-nova / Popover, Tooltip, Button sizes.

## Triggers

- Spacing inside a popover is larger than its `space-y-*` / `mb-*` classes say.
- A tooltip with a title and a description renders them side by side.
- A `size="sm"` button looks cramped next to 20px icons or inside a fixed-height pill.

## Root cause

radix-nova changed layout defaults, not only sizes:

- `PopoverContent` is `flex flex-col gap-2.5` for `PopoverHeader`; FusionKit callers lay out their own
  content, so the gap stacks on their spacing.
- `TooltipContent` is `inline-flex items-center gap-1.5` for keyboard hints; block children line up in a row.
- `Button size="sm"` is 28px with 0.8rem text (new-york sm was 32px with 14px text).

## Do

- Keep `src/components/ui/popover.tsx` and `tooltip.tsx` content as block layout (see the
  `FusionKit:` comments) when reinstalling them.
- Use `size="default"` where a control should keep the old 32px / 14px proportions.
- Compare screenshots and box metrics against the previous build after a style migration; the
  layout snapshot harness flagged both gaps as padding/gap increases.

## Avoid

- Do not reinstall popover or tooltip with `shadcn add -o` without restoring the block layout.

## Validation

Open InfoHint popovers and the name translator / Studio cue help tooltips; titles stack above their
details and spacing matches the class names.

## Related files

- `src/components/ui/popover.tsx`, `src/components/ui/tooltip.tsx`
- `src/pages/components/BottomNavigation.tsx`
