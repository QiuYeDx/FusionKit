# FK-PIT-0196: rounded-smooth-* enlarges the radius, so small controls clamp

## Area
Frontend / Tailwind / smooth corners.

## Triggers
rounded-smooth, corner-shape, superellipse, small badge, icon tile, pill looks squarish, double contour.

## Symptoms
A small badge, popover trigger or 40px icon tile converted from `rounded-md` / `rounded-xl` to `rounded-smooth-*` looks rounder than before, almost like a pill; or a pill that also carries `rounded-smooth-*` gets superellipse ends.

## Root cause
`rounded-smooth-*` (`src/smooth-corners.css`) draws the radius ×1.6 as `superellipse(1.7775)` so the corner keeps its visual size. When ×1.6 exceeds half the short side, the browser scales the radii down (CSS corner-overlap rule) and the shape changes, while computed `border-radius` still reports the unclamped value. Separately, `rounded-full` and `rounded-smooth-*` on one element would combine an infinite radius with a superellipse shape.

## Do
- Step small controls down a size: roughly `sm` below 20px, `md` below 27px, `lg` below 34px, `xl` below 47px short side (radius token ×1.6 ≤ half the short side).
- Merge classes through `cn()`; it is configured so `rounded-*` and `rounded-smooth-*` replace each other. Variant-scoped classes (`data-[size=sm]:rounded-smooth-*`) only apply in that state, as before.
- Give `rounded-[inherit]` children `[corner-shape:inherit]` as well (ScrollArea viewport).
- Leave `src/components/qiuye-ui/*` and `SmoothCorners` surfaces alone: they compute their own corners, and the component's unlayered CSS wins over the utility anyway.

## Avoid
Do not judge from class names or computed `border-radius` alone, and do not convert pills or circles (`rounded-full`).

## Validation
In Electron, list elements whose computed `corner-shape` is a superellipse and compare `min(width, height) / (2 × radius)`; values below ~0.95 need a smaller step. Check the screenshot of each flagged control.

## Related files
- `src/smooth-corners.css`
- `src/lib/utils.ts`
- `src/components/ui/scroll-area.tsx`
