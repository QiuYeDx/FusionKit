# FK-PIT-0178: Give a portalled material picker its own scroll lock

- Area: Frontend / Radix Dialog and Popover
- Triggers: mouse wheel ignored, scrollbar drag works, nested picker, Portal, RemoveScroll

## Symptoms

The material picker inside the subtitle translation dialog shows a scrollbar. Dragging its thumb works, but real wheel input leaves scrollTop at zero.

## Root cause

The non-modal Popover is portalled to body. DialogOverlay's RemoveScroll permits its dialog content shard; the picker is outside that DOM subtree, so the document wheel listener cancels the event as background input. CSS overflow and programmatic scrolling still work and conceal this failure in layout-only tests.

## Do

- For this self-contained portalled picker, use Radix Popover's modal mode so its content owns the active scroll lock and focus while open. Keep the library's focus and pointer cleanup.
- Verify Escape returns to the trigger, the parent dialog remains open, nested Select still works, and handoff to QuickTermDialog restores pointer interaction afterward.
- Test actual mouse.wheel input with enough collections to overflow; assert scroll position changes both ways, background stays still at picker boundaries, and outer scrolling recovers after dismissal.
- Keep this choice local. The non-modal record-menu guidance in FK-PIT-0168 concerns a different lifecycle and must not be blindly generalized to scrolling portals.

## Avoid

- Do not disable the parent modal lock, manually clear body pointer-events, or use forced clicks to hide lifecycle bugs.
- Do not equate scrollTop assignment or scrollbar dragging with wheel-input acceptance.
- Do not move the picker into an overflow-clipped animated dialog just to satisfy the scroll shard; preserve its floating geometry.

## Validation

FUSIONKIT_KNOWLEDGE_E2E=1 node node_modules/vitest/vitest.mjs run test/translation-knowledge/materials-layout-electron.test.ts

The regression failed against the previous build with scrollTop=0 after wheel input. Run the updated production build, inspect wide Chinese/light and narrow English/dark wheel screenshots, and close only the test profile.

## Related files

- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.tsx
- src/pages/Tools/Subtitle/SubtitleStudio/StudioMaterialsFields.css
- test/translation-knowledge/materials-layout-electron.test.ts
- node_modules/@radix-ui/react-dialog/dist/index.js
- node_modules/@radix-ui/react-popover/dist/index.js
- node_modules/react-remove-scroll/dist/es5/SideEffect.js
