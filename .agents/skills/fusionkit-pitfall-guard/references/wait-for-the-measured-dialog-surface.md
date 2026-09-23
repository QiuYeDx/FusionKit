# FK-PIT-0176: Wait for the measured dialog surface

## Area

Electron visual QA / animated dialogs.

## Triggers

Strict locator matches two scroll viewports during a step change; document.getAnimations() never becomes idle; geometry capture after an accordion toggle.

## Symptoms

The export UI regression matched both the outgoing settings viewport and incoming review viewport. A separate export interaction test timed out while waiting for every document animation to stop.

## Root cause

Dialog transitions retain outgoing DOM until its exit finishes. A whole-document animation condition is broader than the geometry under inspection and does not establish that the target dialog has settled.

## Do

- Before selecting a unique viewport after a step change, wait for the expected viewport count or explicitly select the active surface.
- Before measuring a dialog, sample its bounds and relevant rows or flow containers until consecutive frames are stable; include visible flow-animation markers and a bounded deadline.
- Keep existing content, file-output and layout assertions after the wait.

## Avoid

- Do not pick an arbitrary first viewport to hide ambiguous lifecycle state.
- Do not wait for all document animations to stop or disable production motion just to pass a geometry test.

## Validation

Run the affected native Electron export tests. Verify actual output bytes, local geometry, screenshots and process cleanup.

## Related files

- test/subtitle-studio/export-ui.test.ts
- test/subtitle-studio/interaction-export-ui.test.ts
- src/components/qiuye-ui/dialog-motion.tsx
