# FK-PIT-0193: Give radix-nova Card rings room inside scroll containers

## Area

Frontend / shadcn/ui radix-nova / Radix ScrollArea.

## Triggers

- A Card's left (or right/top/bottom) edge is missing next to a ScrollArea or `overflow-hidden` edge.
- Settings content cards look cut off on one side.

## Symptoms

The card shows its outline on three sides; the side touching the scroll viewport has no edge.

## Root cause

The radix-nova Card draws its outline with `ring-1` (an outer `box-shadow`) instead of `border`.
A ring is painted outside the box, so a card placed flush against a clipping ancestor (the Radix
ScrollArea viewport clips both axes) loses that side. The old new-york Card used an inner border.

## Do

- Leave at least 1px between a ringed element and every clipping edge, e.g. `py-1 pl-px pr-3` on the
  settings content column.
- Scan with a probe: for each element whose box-shadow contains a spread ring, check that its rect
  stays 1px inside the nearest ancestor with overflow other than visible.

## Avoid

- Do not switch the Card back to `border` or to an inset ring just for one container; images and
  footers inside the card would cover an inset ring.

## Validation

Open every `/setting?tab=...` page and check all four edges of the content card.

## Related files

- `src/pages/Setting/index.tsx`
- `src/components/ui/card.tsx`
