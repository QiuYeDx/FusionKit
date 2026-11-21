# FK-PIT-0201: Mirror capsule content offsets when a container transform collapses

## Area

Frontend / Motion / container transform (the title bar external agent capsule and any shell that grows in place from a small trigger).

## Triggers

external agent capsule, collapse, close, AnimatePresence `initial` vs `exit`, offset direction, empty shell, ease-out fade, hover tint, frame sampling, dot and badge move the wrong way.

## Symptoms

- Closing the capsule panel felt disconnected: the small elements (status dot, name, unseen badge) slid in from the upper right toward the lower left, while the shell's left and bottom edges were sweeping toward the upper right.
- Between roughly 100 ms and 160 ms the shell was an empty rounded block: the panel had already faded out and the capsule's content had not started yet.
- The shell's colour jumped from the panel surface to the lighter hover tint within about 100 ms, while it was still twice its final size.

## Root cause

- The trigger button is mounted by `AnimatePresence` when the panel closes. Its `initial` offset was `(4, -4)` while its `exit` offset (used when the panel opens) was `(-4, 4)`. On opening it left along the expansion; on closing it arrived against the collapse.
- The panel left with `CONTENT_EASE` (expo-out, 0.14 s). That curve is nearly finished after a third of its duration, so the panel was invisible while the spring still had 60 % of the collapse left. The trigger waited 0.12 s plus an expo-out ramp, so its first visible frame came even later.
- The popover surface layer used the same fast ease-out fade, so a hovered shell (pointer on the close button, which ends up inside the capsule) switched from `popover` to `muted` early in the collapse.

## Do

- Treat the shell's direction as the single reference. The shell grows toward the lower left and collapses toward the upper right; give each group of content one offset constant and use it for both `exit` and `initial` of the capsule's content (`TRIGGER_OFFSET`), so closing returns the content from where it left.
- Let the leaving panel fade with an ease-in-out curve (`LEAVE_EASE`, about 0.18 s) so the shrinking shell is still clipping readable content, and start the capsule content early enough (delay about 0.06 s) that the combined opacity never drops below roughly 0.5.
- Fade the popover surface layer on a longer ease-in-out (about 0.3 s) when closing, so the surface colour changes along with the collapse. Keep the opening timing as it was.
- Verify with per-frame data, not a still: sample the shell box, the trigger's opacity and translate, and the panel's opacity and translate every animation frame for both directions, then also close by Escape with the pointer elsewhere and close then reopen at 60, 110 and 160 ms.

- When a sibling inside the capsule (for example the collapse button next to the new-chat pencil in the sessions capsule) appears or disappears together with the transform, animate its slot width (`overflow-x-clip` plus a small `overflow-clip-margin` so a focus ring is not cut) instead of letting `AnimatePresence mode="popLayout"` pull it out of flow. Pop-layout removal shifts right-anchored neighbours by the whole slot in one frame (32 px for the pencil).
- When the same icon exists in the capsule and in the panel header at different sizes, render one shared element and animate `left/top/width/height` between the two positions, with invisible same-size placeholders in both places. Two crossfading copies blink.
- On the sessions capsule (`src/pages/HomeAgent/SessionSidebar.tsx`) the shell grows toward the lower right, so the capsule content offset is `(4, 4)` and the panel offset is `(-4, -4)`.

## Avoid

- Do not copy an offset from one direction's exit into the other direction's entrance without checking which way the shell edges move.
- Do not use an expo-out fade for content that the shell is about to clip; it leaves an empty shell while the size animation continues.
- Do not rely on `page.screenshot` or a CDP screencast alone for timing: in quiet Electron mode a screencast delivers only a few frames per animation.

## Validation

```text
pnpm run pretest
```

Then use a throwaway Playwright Electron script (keep it under the ignored `test-results/` folder; `test/external-agent-activity.electron.test.ts` shows how to launch, enable the external agent server and connect an MCP client so the capsule shows). It should install a `requestAnimationFrame` sampler, open and close the panel, and print per-frame values. A correct close shows the trigger's `x` rising from `-4` to `0` and `y` falling from `4` to `0`, no frame where `max(panel opacity, trigger opacity)` is below about 0.5, and a final state of a 28 px high shell with the trigger at opacity 1 and the panel at opacity 0.

## Related files

- `src/pages/components/ExternalAgentIndicator.tsx`
- `src/pages/HomeAgent/SessionSidebar.tsx`
- [FK-PIT-0198: A closed panel must not count as an open dialog](a-closed-panel-must-not-count-as-an-open-dialog.md)
