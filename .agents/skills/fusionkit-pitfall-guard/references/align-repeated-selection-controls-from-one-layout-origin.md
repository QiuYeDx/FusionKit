# FK-PIT-0128: Align repeated selection controls from one layout origin

## Area
Frontend / repeated controls / visual measurement

## Triggers
Master checkbox, row checkbox, vertical alignment, nested list padding, animated dialog geometry.

## Symptoms
A selection header looks almost aligned with the rows, but its checkbox is several pixels to the left. Separate geometry reads during a dialog animation can also report a false mismatch.

## Root cause
The header uses one inset while each row combines list padding and a child margin. Matching isolated CSS values misses the final coordinate. Separate DOM reads can sample different ancestor transform frames.

## Do
Derive the header and row selection column from the same layout spacing source. Compare the checkbox outer frames and the adjacent label/file-name origins, preserving existing target sizes and row gaps. Sample all related bounds in one DOM evaluation when ancestors animate, then inspect the settled desktop and narrow-dialog screenshots. Keep a tight geometric tolerance.

## Avoid
Do not compensate by changing only one arbitrary margin without accounting for parent padding. Do not compare bounds captured in different animation frames, widen tolerances to make a mismatch pass, or treat generated screenshots as visual review.

## Validation
In isolated Electron, inspect full and partial selection with several document rows. Assert header and row x coordinates differ by at most 0.5 CSS pixels in a single frame; visually inspect the stable wide and narrow layouts. Also check overlays for duplicate feedback left by older responsive branches.

## Related files
- src/pages/Tools/Subtitle/SubtitleStudio/StudioLibrary.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/studio.css
- test/subtitle-studio/library-ui.test.ts
