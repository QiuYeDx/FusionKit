# FK-PIT-0192: Keep theme tokens non-circular so ring and shadow render

## Area

Frontend / Tailwind CSS 4 theme / shadcn/ui radix-nova.

## Triggers

- Dropdown, Select or Popover content shows no outline and no shadow.
- `shadow-*` utilities have no visible effect anywhere in the app.
- An `@theme` block maps a token to itself, e.g. `--shadow-md: var(--shadow-md)`.

## Symptoms

- Since the radix-nova migration, menus and popovers float without any edge (they rely on
  `shadow-md ring-1 ring-foreground/10` instead of a border).
- `getComputedStyle(el).boxShadow` is `none` for an element with `shadow-md ring-1`.

## Root cause

`src/index.css` declared `--shadow-sm|md|lg|xl: var(--shadow-*)` (and the radius scale) inside `@theme`.
A custom property that references itself is invalid at computed-value time, so `--tw-shadow` becomes
invalid. Tailwind 4 composes ring and shadow into one `box-shadow` declaration, so the whole declaration
is dropped: the shadow and the ring both disappear. Before the migration menus used `border`, which
hid the problem; every `shadow-*` utility had silently been a no-op since 2025-10.

## Do

- Leave shadow tokens to Tailwind's defaults, or define them with real values.
- Define the radius scale only in the `@theme inline` block (multiples of `--radius`).
- Validate with a probe element: `shadow-md ring-1` must produce a non-`none` `box-shadow`.

## Avoid

- Never write `--token: var(--token)` in `@theme`, `:root` or `.dark`.

## Validation

```text
pnpm run pretest
# In the app: an element with class "shadow-md ring-1 ring-foreground/10" has a box-shadow that
# contains both the 1px ring and the md shadow layers.
```

## Related files

- `src/index.css`
- `src/components/ui/dropdown-menu.tsx`, `select.tsx`, `popover.tsx`
